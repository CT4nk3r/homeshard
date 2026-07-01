use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use std::{
    collections::{BTreeMap, HashSet},
    env,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::{process::Command, time::sleep};
use tracing::{error, info, warn};
use uuid::Uuid;

const MAX_INSTANCE_MOD_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Clone, Debug)]
struct Settings {
    database_url: String,
    agent_id: String,
    active_root: PathBuf,
    cold_root: PathBuf,
    staging_root: PathBuf,
    magic_dns_name: String,
    game_bind_ip: String,
    minecraft_image: String,
    blob_token: Option<String>,
    prism_instances_root: PathBuf,
    prism_import_command: Option<String>,
    prism_import_timeout: Duration,
    max_concurrent_commands: usize,
    poll_active_ms: u64,
    poll_idle_ms: u64,
}

#[derive(Debug)]
struct ClaimedCommand {
    id: Uuid,
    instance_id: Option<Uuid>,
    requested_by: Option<Uuid>,
    kind: String,
    payload: Value,
}

#[derive(Debug, Deserialize)]
struct CreateInstancePayload {
    name: String,
    #[serde(rename = "serverType")]
    server_type: Option<String>,
    #[serde(rename = "gameVersion")]
    game_version: Option<String>,
    #[serde(rename = "levelSeed")]
    level_seed: Option<String>,
    #[serde(rename = "memoryMb")]
    memory_mb: Option<i32>,
    #[serde(rename = "packSource")]
    pack_source: Option<PackSource>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum PackSource {
    Local {
        path: String,
        #[serde(rename = "originalName")]
        original_name: String,
        #[serde(rename = "sizeBytes")]
        size_bytes: i64,
        sha256: String,
    },
    Blob {
        url: String,
        #[serde(rename = "originalName")]
        original_name: String,
        #[serde(rename = "sizeBytes")]
        size_bytes: i64,
    },
}

#[derive(Debug, Deserialize)]
struct SetInstanceModsPayload {
    #[serde(default)]
    disabled: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct AddInstanceModPayload {
    source: InstanceModSource,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum InstanceModSource {
    Local {
        path: String,
        #[serde(rename = "originalName")]
        original_name: String,
        #[serde(rename = "sizeBytes")]
        size_bytes: i64,
        sha256: String,
    },
    Url {
        url: String,
        #[serde(rename = "originalName")]
        original_name: String,
    },
}

#[derive(Debug, Deserialize)]
struct ConsolePayload {
    command: String,
}

#[derive(Debug)]
struct PackArchive {
    path: PathBuf,
    original_name: String,
    sha256: String,
    size_bytes: i64,
    manifest: Value,
    platform: PackPlatform,
}

#[derive(Clone, Debug)]
struct InstanceModFile {
    filename: String,
    enabled: bool,
    size_bytes: i64,
}

#[derive(Debug, PartialEq)]
enum PackPlatform {
    CurseForge,
    Modrinth,
}

#[derive(Debug, Serialize)]
struct CommandResult {
    ok: bool,
    message: String,
    data: Value,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let settings = Settings::from_env()?;
    tokio::fs::create_dir_all(&settings.active_root).await?;
    tokio::fs::create_dir_all(settings.cold_root.join("packs")).await?;
    tokio::fs::create_dir_all(settings.cold_root.join("trash")).await?;
    tokio::fs::create_dir_all(settings.cold_root.join("imports")).await?;
    tokio::fs::create_dir_all(&settings.staging_root).await?;

    let pool = PgPoolOptions::new()
        .max_connections(12)
        .connect(&settings.database_url)
        .await
        .context("connect to Neon")?;

    info!(agent_id = %settings.agent_id, "homeshard agent started");
    heartbeat(&pool, &settings).await?;

    // Any commands still 'claimed' by us belong to a previous run that was
    // restarted or crashed mid-command. Fail them so a dead task can never keep
    // an instance permanently locked.
    recover_orphaned_commands(&pool, &settings).await?;

    let settings = Arc::new(settings);
    let in_flight = Arc::new(AtomicUsize::new(0));
    let mut idle_cycles = 0u32;
    let mut last_heartbeat = Instant::now();

    loop {
        if last_heartbeat.elapsed() >= Duration::from_secs(30) {
            if let Err(error) = heartbeat(&pool, &settings).await {
                warn!(error = %error, "heartbeat failed");
            }
            last_heartbeat = Instant::now();
        }

        // Cap how many commands run at once. The claim query already prevents
        // two commands for the same instance (or two Prism imports) from
        // overlapping, so different instances stay fully independent.
        if in_flight.load(Ordering::SeqCst) >= settings.max_concurrent_commands {
            sleep(Duration::from_millis(settings.poll_active_ms)).await;
            continue;
        }

        match claim_command(&pool, &settings).await {
            Ok(Some(command)) => {
                idle_cycles = 0;
                in_flight.fetch_add(1, Ordering::SeqCst);
                let pool = pool.clone();
                let settings = settings.clone();
                let in_flight = in_flight.clone();
                tokio::spawn(async move {
                    let id = command.id;
                    let outcome = match handle_command(&pool, &settings, command).await {
                        Ok(result) => finish_command(&pool, id, true, &result).await,
                        Err(error) => {
                            error!(command_id = %id, error = %error, "command failed");
                            finish_command(
                                &pool,
                                id,
                                false,
                                &CommandResult {
                                    ok: false,
                                    message: format!("{error:#}"),
                                    data: json!({}),
                                },
                            )
                            .await
                        }
                    };
                    if let Err(error) = outcome {
                        error!(command_id = %id, error = %error, "failed to persist command result");
                    }
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                });
                // Loop straight back to fill any remaining concurrency slots.
            }
            Ok(None) => {
                idle_cycles = idle_cycles.saturating_add(1);
                let delay = if idle_cycles < 10 {
                    settings.poll_active_ms
                } else {
                    settings.poll_idle_ms
                };
                sleep(Duration::from_millis(delay)).await;
            }
            Err(error) => {
                warn!(error = %error, "poll failed");
                sleep(Duration::from_secs(5)).await;
            }
        }
    }
}

impl Settings {
    fn from_env() -> Result<Self> {
        Ok(Self {
            database_url: required("DATABASE_URL")?,
            agent_id: env::var("HOMESHARD_AGENT_ID")
                .unwrap_or_else(|_| "homeserver".into()),
            active_root: env::var("HOMESHARD_ACTIVE_ROOT")
                .unwrap_or_else(|_| "/srv/server-manager/instances".into())
                .into(),
            cold_root: env::var("HOMESHARD_COLD_ROOT")
                .unwrap_or_else(|_| "/srv/server-manager/cold".into())
                .into(),
            staging_root: env::var("HOMESHARD_STAGING_ROOT")
                .unwrap_or_else(|_| "/staging".into())
                .into(),
            magic_dns_name: env::var("HOMESHARD_MAGIC_DNS").unwrap_or_default(),
            game_bind_ip: env::var("HOMESHARD_GAME_BIND_IP")
                .unwrap_or_else(|_| "0.0.0.0".into()),
            minecraft_image: env::var("HOMESHARD_MINECRAFT_IMAGE")
                .unwrap_or_else(|_| "itzg/minecraft-server:java21".into()),
            blob_token: optional("BLOB_READ_WRITE_TOKEN"),
            prism_instances_root: env::var("HOMESHARD_PRISM_INSTANCES_ROOT")
                .unwrap_or_else(|_| "/prism/instances".into())
                .into(),
            prism_import_command: optional("HOMESHARD_PRISM_IMPORT_COMMAND"),
            prism_import_timeout: Duration::from_secs(
                env::var("HOMESHARD_PRISM_IMPORT_TIMEOUT_SECS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .filter(|secs| *secs > 0)
                    .unwrap_or(1800),
            ),
            max_concurrent_commands: env::var("HOMESHARD_MAX_CONCURRENT_COMMANDS")
                .ok()
                .and_then(|v| v.parse().ok())
                .filter(|n| *n > 0)
                .unwrap_or(6),
            poll_active_ms: env::var("HOMESHARD_POLL_ACTIVE_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1500),
            poll_idle_ms: env::var("HOMESHARD_POLL_IDLE_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(10_000),
        })
    }
}

fn required(name: &str) -> Result<String> {
    env::var(name).with_context(|| format!("{name} must be set"))
}

fn optional(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.trim().is_empty())
}

async fn heartbeat(pool: &PgPool, settings: &Settings) -> Result<()> {
    let metrics = collect_host_metrics(settings).await;
    sqlx::query(
        r#"
        INSERT INTO hosts (agent_id, name, magic_dns_name, status, metrics, last_seen_at)
        VALUES ($1, $1, $2, 'online', $3::jsonb, now())
        ON CONFLICT (agent_id) DO UPDATE
        SET status = 'online', magic_dns_name = EXCLUDED.magic_dns_name, metrics = EXCLUDED.metrics, last_seen_at = now()
        "#,
    )
    .bind(&settings.agent_id)
    .bind(&settings.magic_dns_name)
    .bind(metrics)
    .execute(pool)
    .await?;
    Ok(())
}

async fn collect_host_metrics(settings: &Settings) -> Value {
    let memory = tokio::fs::read_to_string("/proc/meminfo")
        .await
        .ok()
        .and_then(|contents| parse_meminfo(&contents))
        .unwrap_or((0.0, 0.0));
    let nvme_free_gb = disk_free_gb(&settings.active_root).await.unwrap_or(0.0);
    let cold_used_gb = directory_size_gb(&settings.cold_root).await.unwrap_or(0.0);
    json!({
        "memoryTotalGb": memory.0,
        "memoryUsedGb": memory.1,
        "nvmeFreeGb": nvme_free_gb,
        "coldUsedGb": cold_used_gb,
        "prismInstancesConfigured": prism_instances_configured(settings).await
    })
}

async fn prism_instances_configured(settings: &Settings) -> bool {
    tokio::fs::metadata(&settings.prism_instances_root)
        .await
        .is_ok_and(|metadata| metadata.is_dir())
}

fn parse_meminfo(contents: &str) -> Option<(f64, f64)> {
    let value = |key: &str| {
        contents
            .lines()
            .find(|line| line.starts_with(key))
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|value| value.parse::<u64>().ok())
    };
    let total_kib = value("MemTotal:")?;
    let available_kib = value("MemAvailable:")?;
    Some((
        kib_to_gib(total_kib),
        kib_to_gib(total_kib.saturating_sub(available_kib)),
    ))
}

fn kib_to_gib(value: u64) -> f64 {
    ((value as f64 / 1024.0 / 1024.0) * 10.0).round() / 10.0
}

async fn disk_free_gb(path: &PathBuf) -> Result<f64> {
    let output = run_command(
        "df",
        &["-B1", "--output=avail", &path.display().to_string()],
    )
    .await?;
    let bytes = output
        .lines()
        .last()
        .ok_or_else(|| anyhow!("df returned no data"))?
        .trim()
        .parse::<u64>()?;
    Ok(bytes_to_gib(bytes))
}

async fn directory_size_gb(path: &PathBuf) -> Result<f64> {
    let output = run_command("du", &["-sb", &path.display().to_string()]).await?;
    let bytes = output
        .split_whitespace()
        .next()
        .ok_or_else(|| anyhow!("du returned no data"))?
        .parse::<u64>()?;
    Ok(bytes_to_gib(bytes))
}

fn bytes_to_gib(value: u64) -> f64 {
    ((value as f64 / 1024.0 / 1024.0 / 1024.0) * 10.0).round() / 10.0
}

async fn claim_command(pool: &PgPool, settings: &Settings) -> Result<Option<ClaimedCommand>> {
    let row = sqlx::query(
        r#"
        WITH next_command AS (
          SELECT c.id FROM commands c
          WHERE c.status = 'queued'
            AND c.available_at <= now()
            -- Keep instances independent: never run two commands for the same
            -- instance at the same time.
            AND NOT EXISTS (
              SELECT 1 FROM commands busy
              WHERE busy.status = 'claimed'
                AND busy.instance_id IS NOT NULL
                AND busy.instance_id = c.instance_id
            )
            -- Only one Prism import (create/retry) at a time; they share the
            -- host Prism launcher. This never blocks other instances' commands.
            AND NOT (
              c.kind IN ('create_instance', 'retry_deploy')
              AND EXISTS (
                SELECT 1 FROM commands busy
                WHERE busy.status = 'claimed'
                  AND busy.kind IN ('create_instance', 'retry_deploy')
              )
            )
          ORDER BY c.created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE commands
        SET status = 'claimed', claimed_by = $1, claimed_at = now()
        WHERE id = (SELECT id FROM next_command)
        RETURNING id, instance_id, requested_by, kind, payload
        "#,
    )
    .bind(&settings.agent_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|row| ClaimedCommand {
        id: row.get("id"),
        instance_id: row.get("instance_id"),
        requested_by: row.get("requested_by"),
        kind: row.get("kind"),
        payload: row.get("payload"),
    }))
}

async fn finish_command(
    pool: &PgPool,
    id: Uuid,
    success: bool,
    result: &CommandResult,
) -> Result<()> {
    sqlx::query(
        r#"
        UPDATE commands
        SET status = $2::command_status,
            result = $3::jsonb,
            error = $4,
            completed_at = now()
        WHERE id = $1
        "#,
    )
    .bind(id)
    .bind(if success { "succeeded" } else { "failed" })
    .bind(serde_json::to_value(result)?)
    .bind(if success {
        None
    } else {
        Some(result.message.clone())
    })
    .execute(pool)
    .await?;
    Ok(())
}

async fn recover_orphaned_commands(pool: &PgPool, settings: &Settings) -> Result<()> {
    let result = sqlx::query(
        r#"
        UPDATE commands
        SET status = 'failed',
            error = 'Agent restarted while this command was in progress; please retry.',
            completed_at = now()
        WHERE status = 'claimed' AND claimed_by = $1
        "#,
    )
    .bind(&settings.agent_id)
    .execute(pool)
    .await?;
    let recovered = result.rows_affected();
    if recovered > 0 {
        warn!(count = recovered, "failed orphaned in-progress commands from a previous run");
    }
    Ok(())
}

async fn handle_command(
    pool: &PgPool,
    settings: &Settings,
    command: ClaimedCommand,
) -> Result<CommandResult> {
    info!(command_id = %command.id, kind = %command.kind, "handling command");
    match command.kind.as_str() {
        "create_instance" => create_instance(pool, settings, command).await,
        "retry_deploy" => retry_deploy(pool, settings, command.instance_id).await,
        "start" => docker_lifecycle(pool, command.instance_id, "start").await,
        "stop" | "sleep" => docker_lifecycle(pool, command.instance_id, "stop").await,
        "restart" => docker_lifecycle(pool, command.instance_id, "restart").await,
        "sync_mods" => sync_instance_mods(pool, settings, command.instance_id).await,
        "set_instance_mods" => {
            set_instance_mods(pool, settings, command.instance_id, command.payload).await
        }
        "add_instance_mod" => {
            add_instance_mod(pool, settings, command.instance_id, command.payload).await
        }
        "trash" | "delete_instance" => trash_instance(pool, settings, command.instance_id).await,
        "console" => run_console_command(pool, command.instance_id, command.payload).await,
        "tail_logs" => Ok(CommandResult {
            ok: true,
            message: "Tail logs are read locally by the agent in a later slice".into(),
            data: json!({ "lines": [] }),
        }),
        other => Err(anyhow!("unsupported command kind: {other}")),
    }
}

async fn create_instance(
    pool: &PgPool,
    settings: &Settings,
    command: ClaimedCommand,
) -> Result<CommandResult> {
    let payload: CreateInstancePayload =
        serde_json::from_value(command.payload).context("invalid create_instance payload")?;
    let slug = unique_slug(pool, &payload.name).await?;
    let port = allocate_port(pool).await?;
    let instance_id = Uuid::new_v4();
    let server_type = payload.server_type.unwrap_or_else(|| "VANILLA".into());
    let game_version = payload.game_version.unwrap_or_else(|| "LATEST".into());
    let level_seed = payload
        .level_seed
        .as_deref()
        .map(str::trim)
        .filter(|seed| !seed.is_empty())
        .map(str::to_string);
    let memory_mb = payload.memory_mb.unwrap_or(4096).clamp(2048, 12_288);

    sqlx::query(
        r#"
        INSERT INTO instances (id, created_by, name, slug, state, port, server_type, game_version, world_seed, memory_mb)
        VALUES ($1, $2, $3, $4, 'deploying', $5, $6, $7, $8, $9)
        "#,
    )
    .bind(instance_id)
    .bind(command.requested_by)
    .bind(&payload.name)
    .bind(&slug)
    .bind(port)
    .bind(&server_type)
    .bind(&game_version)
    .bind(level_seed.as_deref())
    .bind(memory_mb)
    .execute(pool)
    .await?;
    sqlx::query("UPDATE commands SET instance_id = $2 WHERE id = $1")
        .bind(command.id)
        .bind(instance_id)
        .execute(pool)
        .await?;

    let pack = match payload.pack_source {
        Some(source) => match ingest_pack(settings, instance_id, source).await {
            Ok(pack) => Some(pack),
            Err(error) => {
                update_instance_state(
                    pool,
                    instance_id,
                    "failed",
                    json!({ "reason": format!("{error:#}"), "stage": "pack_ingestion" }),
                )
                .await?;
                return Err(error);
            }
        },
        None => None,
    };

    if let Some(pack) = &pack {
        sqlx::query(
            r#"
            INSERT INTO pack_revisions (instance_id, original_name, sha256, cold_path, manifest, size_bytes, active)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6, true)
            "#,
        )
        .bind(instance_id)
        .bind(&pack.original_name)
        .bind(&pack.sha256)
        .bind(pack.path.display().to_string())
        .bind(&pack.manifest)
        .bind(pack.size_bytes)
        .execute(pool)
        .await?;
    }

    if let Err(error) = launch_instance(
        settings,
        instance_id,
        &payload.name,
        port,
        &server_type,
        &game_version,
        level_seed.as_deref(),
        memory_mb,
        pack.as_ref(),
    )
    .await
    {
        update_instance_state(
            pool,
            instance_id,
            "failed",
            json!({ "reason": format!("{error:#}"), "stage": "container_launch" }),
        )
        .await?;
        return Err(error);
    }
    let mods = scan_instance_mods(settings, instance_id).await?;
    persist_instance_mods(pool, instance_id, &mods).await?;

    update_instance_state(
        pool,
        instance_id,
        "running",
        json!({ "players": 0, "maxPlayers": 20 }),
    )
    .await?;
    Ok(CommandResult {
        ok: true,
        message: format!("Created {} on port {}", payload.name, port),
        data: json!({ "instanceId": instance_id, "port": port }),
    })
}

async fn retry_deploy(
    pool: &PgPool,
    settings: &Settings,
    instance_id: Option<Uuid>,
) -> Result<CommandResult> {
    let instance_id = instance_id.ok_or_else(|| anyhow!("instance_id is required"))?;
    let row = sqlx::query(
        "SELECT name, port, server_type, game_version, world_seed, memory_mb FROM instances WHERE id = $1 AND state = 'failed'",
    )
    .bind(instance_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| anyhow!("only failed instances can retry deployment"))?;
    let pack_row = sqlx::query(
        "SELECT original_name, sha256, cold_path, manifest, size_bytes FROM pack_revisions WHERE instance_id = $1 AND active = true ORDER BY created_at DESC LIMIT 1",
    )
    .bind(instance_id)
    .fetch_optional(pool)
    .await?;
    let pack = pack_row
        .map(|row| {
            let manifest: Value = row.get("manifest");
            Ok::<PackArchive, anyhow::Error>(PackArchive {
                path: PathBuf::from(row.get::<String, _>("cold_path")),
                original_name: row.get("original_name"),
                sha256: row.get("sha256"),
                size_bytes: row.get("size_bytes"),
                platform: pack_platform(&manifest)?,
                manifest,
            })
        })
        .transpose()?;

    let instance_name: String = row.get("name");
    let port: i32 = row.get("port");
    let server_type: String = row.get("server_type");
    let game_version: String = row.get("game_version");
    let level_seed: Option<String> = row.get("world_seed");
    let memory_mb: i32 = row.get("memory_mb");
    update_instance_state(pool, instance_id, "deploying", json!({})).await?;
    if let Err(error) = launch_instance(
        settings,
        instance_id,
        &instance_name,
        port,
        &server_type,
        &game_version,
        level_seed.as_deref(),
        memory_mb,
        pack.as_ref(),
    )
    .await
    {
        update_instance_state(
            pool,
            instance_id,
            "failed",
            json!({ "reason": format!("{error:#}"), "stage": "container_launch" }),
        )
        .await?;
        return Err(error);
    }
    let mods = scan_instance_mods(settings, instance_id).await?;
    persist_instance_mods(pool, instance_id, &mods).await?;
    update_instance_state(
        pool,
        instance_id,
        "running",
        json!({ "players": 0, "maxPlayers": 20 }),
    )
    .await?;
    Ok(CommandResult {
        ok: true,
        message: format!("Retried deployment for {instance_id}"),
        data: json!({ "instanceId": instance_id }),
    })
}

async fn launch_instance(
    settings: &Settings,
    instance_id: Uuid,
    instance_name: &str,
    port: i32,
    server_type: &str,
    game_version: &str,
    level_seed: Option<&str>,
    memory_mb: i32,
    pack: Option<&PackArchive>,
) -> Result<()> {
    let data_dir = settings.active_root.join(instance_id.to_string());
    tokio::fs::create_dir_all(&data_dir).await?;
    let container = format!("homeshard-{instance_id}");
    let port_arg = format!("{}:{port}:25565", settings.game_bind_ip);
    let volume_arg = format!("{}:/data", data_dir.display());
    let mut args = vec![
        "run".into(),
        "-d".into(),
        "--name".into(),
        container,
        "--label".into(),
        "homeshard.managed=true".into(),
        "--label".into(),
        format!("homeshard.instance_id={instance_id}"),
        "-e".into(),
        "EULA=TRUE".into(),
        "-e".into(),
        format!("MEMORY={memory_mb}M"),
        "-p".into(),
        port_arg,
        "-v".into(),
        volume_arg,
    ];
    if let Some(seed) = level_seed.map(str::trim).filter(|seed| !seed.is_empty()) {
        args.extend(["-e".into(), format!("SEED={seed}")]);
    }
    if let Some(pack) = pack {
        match pack.platform {
            PackPlatform::CurseForge => {
                stage_curseforge_pack_from_prism(settings, &data_dir, pack, instance_name).await?;
                add_curseforge_prism_arguments(&mut args, pack)?;
            }
            PackPlatform::Modrinth => add_modrinth_pack_arguments(&mut args, pack),
        }
    } else {
        args.extend([
            "-e".into(),
            format!("TYPE={server_type}"),
            "-e".into(),
            format!("VERSION={game_version}"),
        ]);
    }
    args.push(settings.minecraft_image.clone());
    docker_owned(&args).await?;
    Ok(())
}

fn add_curseforge_prism_arguments(args: &mut Vec<String>, pack: &PackArchive) -> Result<()> {
    for (name, value) in curseforge_loader_env(&pack.manifest)? {
        args.extend(["-e".into(), format!("{name}={value}")]);
    }
    Ok(())
}

fn add_modrinth_pack_arguments(args: &mut Vec<String>, pack: &PackArchive) {
    args.extend([
        "-e".into(),
        "MODPACK_PLATFORM=MODRINTH".into(),
        "-e".into(),
        "MODRINTH_MODPACK=/packs/source.mrpack".into(),
        "-v".into(),
        format!("{}:/packs/source.mrpack:ro", pack.path.display()),
    ]);
}

fn curseforge_loader_env(manifest: &Value) -> Result<Vec<(String, String)>> {
    let minecraft = manifest
        .get("minecraft")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("CurseForge manifest is missing minecraft settings"))?;
    let minecraft_version = minecraft
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("CurseForge manifest is missing minecraft version"))?;
    let loader_id = minecraft
        .get("modLoaders")
        .and_then(Value::as_array)
        .and_then(|loaders| {
            loaders
                .iter()
                .find(|loader| loader.get("primary").and_then(Value::as_bool) == Some(true))
                .or_else(|| loaders.first())
        })
        .and_then(|loader| loader.get("id").and_then(Value::as_str))
        .ok_or_else(|| anyhow!("CurseForge manifest is missing a mod loader"))?;
    let (loader, loader_version) = loader_id
        .split_once('-')
        .ok_or_else(|| anyhow!("unsupported CurseForge mod loader id: {loader_id}"))?;
    let (server_type, version_env) = match loader.to_ascii_lowercase().as_str() {
        "forge" => ("FORGE", "FORGE_VERSION"),
        "fabric" => ("FABRIC", "FABRIC_LOADER_VERSION"),
        "neoforge" => ("NEOFORGE", "NEOFORGE_VERSION"),
        other => return Err(anyhow!("unsupported CurseForge mod loader: {other}")),
    };
    Ok(vec![
        ("TYPE".into(), server_type.into()),
        ("VERSION".into(), minecraft_version.into()),
        (version_env.into(), loader_version.into()),
    ])
}

async fn stage_curseforge_pack_from_prism(
    settings: &Settings,
    data_dir: &Path,
    pack: &PackArchive,
    instance_name: &str,
) -> Result<()> {
    let mut imported = false;
    let mut instance_dir = match find_prism_instance_for_pack(settings, pack, instance_name).await {
        Ok(path) => path,
        Err(error) => {
            import_curseforge_pack_with_prism(settings, pack)
                .await
                .with_context(|| {
                    format!("auto-import Prism instance after match failed: {error}")
                })?;
            imported = true;
            find_prism_instance_for_pack(settings, pack, instance_name).await?
        }
    };
    let mut minecraft_dir = prism_minecraft_dir(&instance_dir).await?;
    let mods_dir = minecraft_dir.join("mods");
    if !has_downloaded_mods(&mods_dir).await? {
        if !imported && settings.prism_import_command.is_some() {
            import_curseforge_pack_with_prism(settings, pack).await?;
            instance_dir = find_prism_instance_for_pack(settings, pack, instance_name).await?;
            minecraft_dir = prism_minecraft_dir(&instance_dir).await?;
            if !has_downloaded_mods(&minecraft_dir.join("mods")).await? {
                return Err(anyhow!(
                    "Prism instance '{}' still has no downloaded mods after auto-import",
                    instance_dir.display()
                ));
            }
        } else {
            return Err(anyhow!(
                "Prism instance '{}' has no downloaded mods; import the pack in Prism before deploying",
                instance_dir.display()
            ));
        }
    }

    let source = format!("{}/.", minecraft_dir.display());
    let target = data_dir.display().to_string();
    run_command("cp", &["-a", &source, &target])
        .await
        .with_context(|| {
            format!(
                "copy Prism instance files from '{}' into '{}'",
                minecraft_dir.display(),
                data_dir.display()
            )
        })?;
    let disabled = disable_default_server_mods(data_dir).await?;
    if !disabled.is_empty() {
        info!(
            disabled_mods = %disabled.join(", "),
            "moved default-disabled server mods to mods_disabled"
        );
    }
    Ok(())
}

async fn import_curseforge_pack_with_prism(settings: &Settings, pack: &PackArchive) -> Result<()> {
    let command = settings.prism_import_command.as_deref().ok_or_else(|| {
        anyhow!(
            "No Prism instance matching '{}' was found and HOMESHARD_PRISM_IMPORT_COMMAND is not configured",
            pack.sha256
        )
    })?;
    let pack_path = pack.path.display().to_string();
    let output = run_command_with_timeout(
        command,
        &[&pack_path, &pack.sha256, &pack.original_name],
        settings.prism_import_timeout,
    )
    .await
    .with_context(|| format!("run Prism auto-import for '{}'", pack.original_name))?;
    info!(pack = %pack.original_name, output = %output, "Prism auto-import completed");
    Ok(())
}

#[derive(Debug)]
struct PrismCandidate {
    path: PathBuf,
    name: String,
    score: i32,
}

async fn find_prism_instance_for_pack(
    settings: &Settings,
    pack: &PackArchive,
    instance_name: &str,
) -> Result<PathBuf> {
    let expected_names = expected_pack_names(pack, instance_name);
    let expected_slugs = expected_names
        .iter()
        .map(|name| slugify(name))
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    if expected_names.is_empty() || expected_slugs.is_empty() {
        return Err(anyhow!("CurseForge pack is missing a usable pack name"));
    }
    let root = &settings.prism_instances_root;
    let metadata = tokio::fs::metadata(root).await.with_context(|| {
        format!(
            "Prism instances directory '{}' is not available",
            root.display()
        )
    })?;
    if !metadata.is_dir() {
        return Err(anyhow!(
            "Prism instances path '{}' is not a directory",
            root.display()
        ));
    }

    let mut entries = tokio::fs::read_dir(root).await?;
    let mut candidates = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        if !entry.file_type().await?.is_dir() {
            continue;
        }
        let path = entry.path();
        if prism_minecraft_dir(&path).await.is_err() {
            continue;
        }
        let mut names = Vec::new();
        if let Some(name) = read_prism_instance_name(&path).await {
            names.push(name);
        }
        if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
            names.push(name.to_string());
        }
        let score = prism_candidate_score(&names, &expected_slugs);
        if score > 0 {
            let name = names
                .first()
                .cloned()
                .unwrap_or_else(|| path.display().to_string());
            candidates.push(PrismCandidate { path, name, score });
        }
    }

    candidates.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.name.cmp(&right.name))
    });
    let Some(best) = candidates.first() else {
        return Err(anyhow!(
            "No Prism instance matching '{}' was found under '{}'; import the pack in Prism using one of those names first",
            expected_names.join("' or '"),
            root.display()
        ));
    };
    if candidates
        .get(1)
        .is_some_and(|candidate| candidate.score == best.score)
    {
        let names = candidates
            .iter()
            .filter(|candidate| candidate.score == best.score)
            .map(|candidate| candidate.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(anyhow!(
            "Multiple Prism instances match '{}': {names}; rename one or remove the stale import",
            expected_names.join("' or '")
        ));
    }

    Ok(best.path.clone())
}

fn expected_pack_names(pack: &PackArchive, instance_name: &str) -> Vec<String> {
    let mut values = Vec::new();
    if !instance_name.trim().is_empty() {
        values.push(instance_name.trim().to_string());
    }
    if let Some(name) = pack.manifest.get("name").and_then(Value::as_str) {
        values.push(name.to_string());
    }
    if let Some(stem) = Path::new(&pack.original_name)
        .file_stem()
        .and_then(|value| value.to_str())
    {
        values.push(stem.to_string());
    }
    if !pack.sha256.trim().is_empty() {
        values.push(pack.sha256.clone());
    }
    values.sort_by_key(|value| value.to_ascii_lowercase());
    values.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    values
}

async fn prism_minecraft_dir(instance_dir: &Path) -> Result<PathBuf> {
    for name in [".minecraft", "minecraft"] {
        let candidate = instance_dir.join(name);
        if tokio::fs::metadata(&candidate)
            .await
            .is_ok_and(|metadata| metadata.is_dir())
        {
            return Ok(candidate);
        }
    }
    Err(anyhow!(
        "Prism instance '{}' has no Minecraft data directory",
        instance_dir.display()
    ))
}

fn prism_candidate_score(names: &[String], expected_slugs: &[String]) -> i32 {
    let mut score = 0;
    for name in names {
        let candidate = slugify(name);
        for expected in expected_slugs {
            if candidate == *expected {
                score = score.max(100);
            } else if candidate.contains(expected) || expected.contains(&candidate) {
                score = score.max(50);
            }
        }
    }
    score
}

async fn read_prism_instance_name(path: &Path) -> Option<String> {
    for file in ["instance.cfg", "prismlauncher.cfg"] {
        let Ok(contents) = tokio::fs::read_to_string(path.join(file)).await else {
            continue;
        };
        for line in contents.lines() {
            let Some((key, value)) = line.trim().split_once('=') else {
                continue;
            };
            if key.trim().eq_ignore_ascii_case("name") {
                let name = value.trim();
                if !name.is_empty() {
                    return Some(name.to_string());
                }
            }
        }
    }
    None
}

async fn has_downloaded_mods(mods_dir: &Path) -> Result<bool> {
    let mut entries = match tokio::fs::read_dir(mods_dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    while let Some(entry) = entries.next_entry().await? {
        if entry.file_type().await?.is_file()
            && entry
                .path()
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("jar"))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

async fn sync_instance_mods(
    pool: &PgPool,
    settings: &Settings,
    instance_id: Option<Uuid>,
) -> Result<CommandResult> {
    let instance_id = instance_id.ok_or_else(|| anyhow!("instance_id is required"))?;
    instance_state(pool, instance_id).await?;
    let mods = scan_instance_mods(settings, instance_id).await?;
    persist_instance_mods(pool, instance_id, &mods).await?;
    let disabled = mods.iter().filter(|mod_file| !mod_file.enabled).count();
    Ok(CommandResult {
        ok: true,
        message: format!("Synced {} mods ({disabled} disabled)", mods.len()),
        data: json!({
            "instanceId": instance_id,
            "mods": mods.len(),
            "disabled": disabled,
        }),
    })
}

async fn set_instance_mods(
    pool: &PgPool,
    settings: &Settings,
    instance_id: Option<Uuid>,
    payload: Value,
) -> Result<CommandResult> {
    let instance_id = instance_id.ok_or_else(|| anyhow!("instance_id is required"))?;
    let state = instance_state(pool, instance_id).await?;
    let payload: SetInstanceModsPayload =
        serde_json::from_value(payload).context("invalid set_instance_mods payload")?;
    let disabled = payload
        .disabled
        .iter()
        .map(|filename| sanitize_mod_filename(filename))
        .collect::<Result<HashSet<_>>>()?;

    let data_dir = settings.active_root.join(instance_id.to_string());
    let mods_dir = data_dir.join("mods");
    let disabled_dir = data_dir.join("mods_disabled");
    tokio::fs::create_dir_all(&mods_dir).await?;
    tokio::fs::create_dir_all(&disabled_dir).await?;

    let before = scan_instance_mods(settings, instance_id).await?;
    let mut moved_to_disabled = 0usize;
    let mut moved_to_enabled = 0usize;
    for mod_file in &before {
        if mod_file.enabled && disabled.contains(&mod_file.filename) {
            if move_mod_file(&mods_dir, &disabled_dir, &mod_file.filename).await? {
                moved_to_disabled += 1;
            }
        } else if !mod_file.enabled && !disabled.contains(&mod_file.filename) {
            if move_mod_file(&disabled_dir, &mods_dir, &mod_file.filename).await? {
                moved_to_enabled += 1;
            }
        }
    }

    let mods = scan_instance_mods(settings, instance_id).await?;
    persist_instance_mods(pool, instance_id, &mods).await?;
    if state == "running" {
        let container = format!("homeshard-{instance_id}");
        require_managed_container(&container, instance_id).await?;
        docker(["restart", &container]).await?;
    }
    let disabled_count = mods.iter().filter(|mod_file| !mod_file.enabled).count();
    Ok(CommandResult {
        ok: true,
        message: format!(
            "Updated mods: {moved_to_disabled} disabled, {moved_to_enabled} re-enabled"
        ),
        data: json!({
            "instanceId": instance_id,
            "mods": mods.len(),
            "disabled": disabled_count,
            "restarted": state == "running",
        }),
    })
}

async fn add_instance_mod(
    pool: &PgPool,
    settings: &Settings,
    instance_id: Option<Uuid>,
    payload: Value,
) -> Result<CommandResult> {
    let instance_id = instance_id.ok_or_else(|| anyhow!("instance_id is required"))?;
    let state = instance_state(pool, instance_id).await?;
    let payload: AddInstanceModPayload =
        serde_json::from_value(payload).context("invalid add_instance_mod payload")?;

    let data_dir = settings.active_root.join(instance_id.to_string());
    let mods_dir = data_dir.join("mods");
    tokio::fs::create_dir_all(&mods_dir).await?;

    let (filename, size_bytes) =
        ingest_instance_mod_source(settings, &data_dir, &mods_dir, payload.source).await?;

    let mods = scan_instance_mods(settings, instance_id).await?;
    persist_instance_mods(pool, instance_id, &mods).await?;
    if state == "running" {
        let container = format!("homeshard-{instance_id}");
        require_managed_container(&container, instance_id).await?;
        docker(["restart", &container]).await?;
    }

    Ok(CommandResult {
        ok: true,
        message: format!(
            "Added {filename} ({:.1} MiB){}",
            size_bytes as f64 / 1024.0 / 1024.0,
            if state == "running" {
                " and restarted the instance"
            } else {
                ""
            }
        ),
        data: json!({
            "instanceId": instance_id,
            "filename": filename,
            "sizeBytes": size_bytes,
            "mods": mods.len(),
            "restarted": state == "running",
        }),
    })
}

async fn ingest_instance_mod_source(
    settings: &Settings,
    data_dir: &Path,
    mods_dir: &Path,
    source: InstanceModSource,
) -> Result<(String, i64)> {
    let (filename, expected_size, expected_sha, remove_after, url) = match source {
        InstanceModSource::Local {
            path,
            original_name,
            size_bytes,
            sha256,
        } => {
            if size_bytes <= 0 || size_bytes as u64 > MAX_INSTANCE_MOD_BYTES {
                return Err(anyhow!("mod exceeds the 128 MB limit"));
            }
            let source_path = PathBuf::from(path);
            let canonical_root = tokio::fs::canonicalize(&settings.staging_root).await?;
            let canonical_source = tokio::fs::canonicalize(&source_path).await?;
            if !canonical_source.starts_with(&canonical_root) {
                return Err(anyhow!("local mod path is outside the staging root"));
            }
            (
                sanitize_mod_filename(&original_name)?,
                Some(size_bytes),
                Some(sha256),
                Some(canonical_source),
                None,
            )
        }
        InstanceModSource::Url { url, original_name } => {
            if !url.starts_with("https://") && !url.starts_with("http://") {
                return Err(anyhow!("mod URL must use http or https"));
            }
            if url.contains('\n') || url.contains('\r') {
                return Err(anyhow!("invalid mod URL"));
            }
            (
                sanitize_mod_filename(&original_name)?,
                None,
                None,
                None,
                Some(url),
            )
        }
    };

    let target = mods_dir.join(&filename);
    let disabled_target = data_dir.join("mods_disabled").join(&filename);
    if tokio::fs::metadata(&target).await.is_ok()
        || tokio::fs::metadata(&disabled_target).await.is_ok()
    {
        return Err(anyhow!("mod '{filename}' already exists on this instance"));
    }

    let temporary = mods_dir.join(format!(".incoming-{}.tmp", Uuid::new_v4()));
    if let Some(source_path) = remove_after.as_ref() {
        tokio::fs::copy(source_path, &temporary)
            .await
            .with_context(|| format!("copy staged mod '{}'", source_path.display()))?;
    } else if let Some(url) = url.as_ref() {
        run_command(
            "curl",
            &[
                "--fail",
                "--location",
                "--silent",
                "--show-error",
                "--max-filesize",
                &MAX_INSTANCE_MOD_BYTES.to_string(),
                "--output",
                &temporary.display().to_string(),
                url,
            ],
        )
        .await
        .with_context(|| format!("download mod from {url}"))?;
    }

    let metadata = tokio::fs::metadata(&temporary).await?;
    if metadata.len() == 0 || metadata.len() > MAX_INSTANCE_MOD_BYTES {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(anyhow!("downloaded mod exceeds the 128 MB limit"));
    }
    if expected_size.is_some_and(|size| metadata.len() as i64 != size) {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(anyhow!("staged mod size does not match"));
    }
    let digest = sha256_file(&temporary).await?;
    if expected_sha
        .as_deref()
        .is_some_and(|expected| expected != digest)
    {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(anyhow!("staged mod checksum does not match"));
    }

    tokio::fs::rename(&temporary, &target)
        .await
        .with_context(|| format!("install mod '{}'", target.display()))?;
    if let Some(path) = remove_after {
        tokio::fs::remove_file(path).await?;
    }
    Ok((filename, metadata.len() as i64))
}

async fn run_console_command(
    pool: &PgPool,
    instance_id: Option<Uuid>,
    payload: Value,
) -> Result<CommandResult> {
    let instance_id = instance_id.ok_or_else(|| anyhow!("instance_id is required"))?;
    let state = instance_state(pool, instance_id).await?;
    if state != "running" {
        return Err(anyhow!("console commands require a running instance"));
    }
    let payload: ConsolePayload =
        serde_json::from_value(payload).context("invalid console payload")?;
    let command = payload.command.trim();
    if command.is_empty() {
        return Err(anyhow!("console command is empty"));
    }
    if command.len() > 512 || command.contains('\n') || command.contains('\r') {
        return Err(anyhow!(
            "console command must be a single line under 512 characters"
        ));
    }

    let container = format!("homeshard-{instance_id}");
    require_managed_container(&container, instance_id).await?;
    let output = docker_exec(&[&container, "rcon-cli", command]).await?;
    Ok(CommandResult {
        ok: true,
        message: format!("Executed console command: {command}"),
        data: json!({
            "instanceId": instance_id,
            "output": output,
        }),
    })
}

async fn instance_state(pool: &PgPool, instance_id: Uuid) -> Result<String> {
    let row = sqlx::query(
        "SELECT state::text AS state FROM instances WHERE id = $1 AND state != 'trashed'",
    )
    .bind(instance_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| anyhow!("instance is deleted or does not exist"))?;
    Ok(row.get("state"))
}

async fn scan_instance_mods(
    settings: &Settings,
    instance_id: Uuid,
) -> Result<Vec<InstanceModFile>> {
    let data_dir = settings.active_root.join(instance_id.to_string());
    let mut by_name = BTreeMap::new();
    for mod_file in scan_mod_dir(&data_dir.join("mods_disabled"), false).await? {
        by_name.insert(mod_file.filename.clone(), mod_file);
    }
    for mod_file in scan_mod_dir(&data_dir.join("mods"), true).await? {
        by_name.insert(mod_file.filename.clone(), mod_file);
    }
    Ok(by_name.into_values().collect())
}

async fn scan_mod_dir(dir: &Path, enabled: bool) -> Result<Vec<InstanceModFile>> {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut mods = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        if !entry.file_type().await?.is_file() {
            continue;
        }
        let path = entry.path();
        if !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("jar"))
        {
            continue;
        }
        let Some(filename) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let metadata = entry.metadata().await?;
        mods.push(InstanceModFile {
            filename: filename.to_string(),
            enabled,
            size_bytes: metadata.len() as i64,
        });
    }
    Ok(mods)
}

async fn persist_instance_mods(
    pool: &PgPool,
    instance_id: Uuid,
    mods: &[InstanceModFile],
) -> Result<()> {
    let filenames = mods
        .iter()
        .map(|mod_file| mod_file.filename.clone())
        .collect::<Vec<_>>();
    if filenames.is_empty() {
        sqlx::query("DELETE FROM instance_mods WHERE instance_id = $1")
            .bind(instance_id)
            .execute(pool)
            .await?;
    } else {
        sqlx::query(
            "DELETE FROM instance_mods WHERE instance_id = $1 AND NOT (filename = ANY($2))",
        )
        .bind(instance_id)
        .bind(&filenames)
        .execute(pool)
        .await?;
    }

    for mod_file in mods {
        sqlx::query(
            r#"
            INSERT INTO instance_mods (instance_id, filename, enabled, size_bytes, updated_at)
            VALUES ($1, $2, $3, $4, now())
            ON CONFLICT (instance_id, filename) DO UPDATE
            SET enabled = EXCLUDED.enabled,
                size_bytes = EXCLUDED.size_bytes,
                updated_at = now()
            "#,
        )
        .bind(instance_id)
        .bind(&mod_file.filename)
        .bind(mod_file.enabled)
        .bind(mod_file.size_bytes)
        .execute(pool)
        .await?;
    }
    Ok(())
}

async fn disable_default_server_mods(data_dir: &Path) -> Result<Vec<String>> {
    let mods_dir = data_dir.join("mods");
    let disabled_dir = data_dir.join("mods_disabled");
    let mut moved = Vec::new();
    for mod_file in scan_mod_dir(&mods_dir, true).await? {
        if default_disabled_server_mod(&mod_file.filename)
            && move_mod_file(&mods_dir, &disabled_dir, &mod_file.filename).await?
        {
            moved.push(mod_file.filename);
        }
    }
    Ok(moved)
}

fn default_disabled_server_mod(filename: &str) -> bool {
    let filename = filename.to_ascii_lowercase();
    ["configured-", "catalogue-", "controlling-"]
        .iter()
        .any(|prefix| filename.starts_with(prefix))
}

async fn move_mod_file(source_dir: &Path, target_dir: &Path, filename: &str) -> Result<bool> {
    let filename = sanitize_mod_filename(filename)?;
    let source = source_dir.join(&filename);
    let target = target_dir.join(&filename);
    match tokio::fs::metadata(&source).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    }
    if tokio::fs::metadata(&target).await.is_ok() {
        return Err(anyhow!(
            "refusing to overwrite existing mod '{}'",
            target.display()
        ));
    }
    tokio::fs::create_dir_all(target_dir).await?;
    tokio::fs::rename(&source, &target)
        .await
        .with_context(|| format!("move mod '{}' to '{}'", source.display(), target.display()))?;
    Ok(true)
}

fn sanitize_mod_filename(filename: &str) -> Result<String> {
    let filename = filename.trim();
    if filename.is_empty()
        || filename == "."
        || filename == ".."
        || filename.contains('/')
        || filename.contains('\\')
        || !filename.to_ascii_lowercase().ends_with(".jar")
    {
        return Err(anyhow!("invalid mod filename: {filename}"));
    }
    Ok(filename.to_string())
}

async fn ingest_pack(
    settings: &Settings,
    instance_id: Uuid,
    source: PackSource,
) -> Result<PackArchive> {
    let pack_dir = settings
        .cold_root
        .join("packs")
        .join(instance_id.to_string());
    tokio::fs::create_dir_all(&pack_dir).await?;
    let temporary = pack_dir.join("incoming.zip");

    let (original_name, expected_size, expected_sha, remove_after) = match source {
        PackSource::Local {
            path,
            original_name,
            size_bytes,
            sha256,
        } => {
            let source_path = PathBuf::from(path);
            let canonical_root = tokio::fs::canonicalize(&settings.staging_root).await?;
            let canonical_source = tokio::fs::canonicalize(&source_path).await?;
            if !canonical_source.starts_with(&canonical_root) {
                return Err(anyhow!("local pack path is outside the staging root"));
            }
            tokio::fs::copy(&canonical_source, &temporary).await?;
            (
                original_name,
                size_bytes,
                Some(sha256),
                Some(canonical_source),
            )
        }
        PackSource::Blob {
            url,
            original_name,
            size_bytes,
        } => {
            if !url.starts_with("https://") || !url.contains(".blob.vercel-storage.com/") {
                return Err(anyhow!("refusing untrusted Blob URL"));
            }
            let token = settings.blob_token.as_deref().ok_or_else(|| {
                anyhow!("BLOB_READ_WRITE_TOKEN is required to ingest private packs")
            })?;
            run_command(
                "curl",
                &[
                    "--fail",
                    "--location",
                    "--silent",
                    "--show-error",
                    "--header",
                    &format!("Authorization: Bearer {token}"),
                    "--output",
                    &temporary.display().to_string(),
                    &url,
                ],
            )
            .await?;
            (original_name, size_bytes, None, None)
        }
    };

    let metadata = tokio::fs::metadata(&temporary).await?;
    if metadata.len() > 250 * 1024 * 1024 || metadata.len() as i64 != expected_size {
        return Err(anyhow!("staged pack size does not match"));
    }
    let digest = sha256_file(&temporary).await?;
    if expected_sha
        .as_deref()
        .is_some_and(|expected| expected != digest)
    {
        return Err(anyhow!("staged pack checksum does not match"));
    }
    let (manifest, platform) = inspect_pack_archive(&temporary).await?;
    let archive = pack_dir.join(format!("{digest}.zip"));
    tokio::fs::rename(&temporary, &archive).await?;
    if let Some(path) = remove_after {
        tokio::fs::remove_file(path).await?;
    }
    Ok(PackArchive {
        path: archive,
        original_name,
        sha256: digest,
        size_bytes: metadata.len() as i64,
        manifest,
        platform,
    })
}

async fn inspect_pack_archive(path: &PathBuf) -> Result<(Value, PackPlatform)> {
    let archive = path.display().to_string();
    if let Ok(text) = run_command("unzip", &["-p", &archive, "manifest.json"]).await {
        let manifest: Value =
            serde_json::from_str(&text).context("invalid CurseForge manifest.json")?;
        if manifest.get("manifestType").and_then(Value::as_str) != Some("minecraftModpack") {
            return Err(anyhow!("unsupported CurseForge manifest type"));
        }
        return Ok((manifest, PackPlatform::CurseForge));
    }

    let text = run_command("unzip", &["-p", &archive, "modrinth.index.json"])
        .await
        .context("pack is not a supported CurseForge ZIP or Modrinth .mrpack")?;
    let manifest: Value = serde_json::from_str(&text).context("invalid modrinth.index.json")?;
    if manifest
        .get("formatVersion")
        .and_then(Value::as_u64)
        .is_none()
    {
        return Err(anyhow!("unsupported Modrinth manifest"));
    }
    Ok((manifest, PackPlatform::Modrinth))
}

fn pack_platform(manifest: &Value) -> Result<PackPlatform> {
    if manifest.get("manifestType").and_then(Value::as_str) == Some("minecraftModpack") {
        return Ok(PackPlatform::CurseForge);
    }
    if manifest
        .get("formatVersion")
        .and_then(Value::as_u64)
        .is_some()
    {
        return Ok(PackPlatform::Modrinth);
    }
    Err(anyhow!("unsupported stored pack manifest"))
}

async fn trash_instance(
    pool: &PgPool,
    settings: &Settings,
    instance_id: Option<Uuid>,
) -> Result<CommandResult> {
    let instance_id = instance_id.ok_or_else(|| anyhow!("instance_id is required"))?;
    let row = sqlx::query(
        "SELECT state::text AS state FROM instances WHERE id = $1 AND state != 'trashed'",
    )
    .bind(instance_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| anyhow!("instance is already deleted or does not exist"))?;
    let previous_state: String = row.get("state");

    let container = format!("homeshard-{instance_id}");
    let removed_container = remove_managed_container_if_present(&container, instance_id).await?;
    let data_path = move_path_to_trash(
        settings,
        &settings.active_root.join(instance_id.to_string()),
        instance_id,
        "data",
    )
    .await?;
    let pack_path = move_path_to_trash(
        settings,
        &settings
            .cold_root
            .join("packs")
            .join(instance_id.to_string()),
        instance_id,
        "packs",
    )
    .await?;
    let trash_port = allocate_trash_port(pool).await?;

    let status = json!({
        "reason": "Deleted",
        "previousState": previous_state,
        "removedContainer": removed_container,
        "trashedDataPath": data_path.map(|path| path.display().to_string()),
        "trashedPackPath": pack_path.map(|path| path.display().to_string()),
    });
    sqlx::query(
        "UPDATE instances SET state = 'trashed', port = $3, status = $2::jsonb, trashed_at = now(), updated_at = now() WHERE id = $1",
    )
    .bind(instance_id)
    .bind(status)
    .bind(trash_port)
    .execute(pool)
    .await?;

    Ok(CommandResult {
        ok: true,
        message: format!("Deleted {instance_id}"),
        data: json!({ "instanceId": instance_id, "state": "trashed", "releasedPort": true }),
    })
}

async fn allocate_trash_port(pool: &PgPool) -> Result<i32> {
    let row =
        sqlx::query("SELECT COALESCE(MIN(port), 0) - 1 AS port FROM instances WHERE port < 0")
            .fetch_one(pool)
            .await?;
    Ok(row.get("port"))
}

async fn remove_managed_container_if_present(container: &str, instance_id: Uuid) -> Result<bool> {
    match inspect_managed_container(container, instance_id).await {
        Ok(true) => {
            docker(["rm", "-f", container]).await?;
            Ok(true)
        }
        Ok(false) => Ok(false),
        Err(error) => Err(error),
    }
}

async fn inspect_managed_container(container: &str, instance_id: Uuid) -> Result<bool> {
    let expected = format!("true:{instance_id}");
    match docker([
        "inspect",
        "--format",
        "{{ index .Config.Labels \"homeshard.managed\" }}:{{ index .Config.Labels \"homeshard.instance_id\" }}",
        container,
    ])
    .await
    {
        Ok(managed) if managed == expected => Ok(true),
        Ok(_) => Err(anyhow!(
            "refusing to manage container without matching Homeshard labels"
        )),
        Err(error) if docker_missing_container(&error) => Ok(false),
        Err(error) => Err(error),
    }
}

fn docker_missing_container(error: &anyhow::Error) -> bool {
    let message = error.to_string();
    message.contains("No such object") || message.contains("No such container")
}

async fn move_path_to_trash(
    settings: &Settings,
    source: &Path,
    instance_id: Uuid,
    kind: &str,
) -> Result<Option<PathBuf>> {
    match tokio::fs::metadata(source).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    }

    let trash_root = settings.cold_root.join("trash");
    tokio::fs::create_dir_all(&trash_root).await?;
    for suffix in 0..100 {
        let name = if suffix == 0 {
            format!("{instance_id}-{kind}")
        } else {
            format!("{instance_id}-{kind}-{suffix}")
        };
        let target = trash_root.join(name);
        match tokio::fs::metadata(&target).await {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let source_arg = source.display().to_string();
                let target_arg = target.display().to_string();
                run_command("mv", &[&source_arg, &target_arg]).await?;
                return Ok(Some(target));
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err(anyhow!(
        "could not allocate trash path for {instance_id} {kind}"
    ))
}

async fn docker_lifecycle(
    pool: &PgPool,
    instance_id: Option<Uuid>,
    action: &str,
) -> Result<CommandResult> {
    let instance_id = instance_id.ok_or_else(|| anyhow!("instance_id is required"))?;
    let container = format!("homeshard-{instance_id}");
    require_managed_container(&container, instance_id).await?;
    docker([action, &container]).await?;
    let state = match action {
        "start" | "restart" => "running",
        "stop" => "sleeping",
        _ => "stopped",
    };
    update_instance_state(pool, instance_id, state, json!({})).await?;
    Ok(CommandResult {
        ok: true,
        message: format!("{action} queued for {instance_id}"),
        data: json!({ "instanceId": instance_id, "state": state }),
    })
}

async fn require_managed_container(container: &str, instance_id: Uuid) -> Result<()> {
    inspect_managed_container(container, instance_id)
        .await?
        .then_some(())
        .ok_or_else(|| anyhow!("container does not exist"))
}

async fn update_instance_state(
    pool: &PgPool,
    instance_id: Uuid,
    state: &str,
    status: Value,
) -> Result<()> {
    sqlx::query(
        "UPDATE instances SET state = $2::instance_state, status = $3::jsonb, updated_at = now() WHERE id = $1",
    )
    .bind(instance_id)
    .bind(state)
    .bind(status)
    .execute(pool)
    .await?;
    Ok(())
}

async fn docker<const N: usize>(args: [&str; N]) -> Result<String> {
    run_command("docker", &args).await
}

async fn docker_exec(args: &[&str]) -> Result<String> {
    let mut docker_args = Vec::with_capacity(args.len() + 1);
    docker_args.push("exec");
    docker_args.extend_from_slice(args);
    run_command("docker", &docker_args).await
}

async fn docker_owned(args: &[String]) -> Result<String> {
    let borrowed = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_command("docker", &borrowed).await
}

async fn run_command(program: &str, args: &[&str]) -> Result<String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .await
        .with_context(|| format!("launch {program} command"))?;
    if !output.status.success() {
        return Err(anyhow!(
            "{program} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Like [`run_command`], but aborts (and SIGKILLs the child via `kill_on_drop`)
/// if it does not finish within `timeout`. Used for the Prism auto-import, which
/// drives a GUI and can wedge indefinitely; without this the serial agent loop
/// would never claim any further commands.
async fn run_command_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<String> {
    let child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("launch {program} command"))?;

    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(result) => result.with_context(|| format!("wait for {program} command"))?,
        Err(_) => {
            return Err(anyhow!(
                "{program} timed out after {}s",
                timeout.as_secs()
            ))
        }
    };
    if !output.status.success() {
        return Err(anyhow!(
            "{program} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

async fn allocate_port(pool: &PgPool) -> Result<i32> {
    let row = sqlx::query(
        r#"
        SELECT port FROM generate_series(25600, 25699) AS port
        WHERE port NOT IN (SELECT port FROM instances WHERE state != 'trashed')
        ORDER BY port ASC
        LIMIT 1
        "#,
    )
    .fetch_one(pool)
    .await?;
    Ok(row.get("port"))
}

async fn unique_slug(pool: &PgPool, name: &str) -> Result<String> {
    let base = slugify(name);
    for suffix in 0..100 {
        let candidate = if suffix == 0 {
            base.clone()
        } else {
            format!("{base}-{suffix}")
        };
        let exists: Option<(String,)> =
            sqlx::query_as("SELECT slug FROM instances WHERE slug = $1")
                .bind(&candidate)
                .fetch_optional(pool)
                .await?;
        if exists.is_none() {
            return Ok(candidate);
        }
    }
    Err(anyhow!("could not allocate unique slug"))
}

fn slugify(input: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for ch in input.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "minecraft".into()
    } else {
        trimmed
    }
}

async fn sha256_file(path: &PathBuf) -> Result<String> {
    let bytes = tokio::fs::read(path).await?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::{curseforge_loader_env, parse_meminfo, prism_candidate_score, slugify};
    use serde_json::json;

    #[test]
    fn slugifies_names() {
        assert_eq!(slugify("TwoWeekMc"), "twoweekmc");
        assert_eq!(slugify("My Cool Pack!!"), "my-cool-pack");
        assert_eq!(slugify("!!!"), "minecraft");
    }

    #[test]
    fn parses_memory_metrics() {
        let metrics = parse_meminfo("MemTotal:       32505856 kB\nMemAvailable:   24117248 kB\n");
        assert_eq!(metrics, Some((31.0, 8.0)));
    }

    #[test]
    fn builds_curseforge_loader_environment() {
        let manifest = json!({
            "minecraft": {
                "version": "1.20.1",
                "modLoaders": [{ "id": "forge-47.2.20", "primary": true }]
            }
        });
        assert_eq!(
            curseforge_loader_env(&manifest).unwrap(),
            vec![
                ("TYPE".into(), "FORGE".into()),
                ("VERSION".into(), "1.20.1".into()),
                ("FORGE_VERSION".into(), "47.2.20".into()),
            ]
        );

        let manifest = json!({
            "minecraft": {
                "version": "1.21.1",
                "modLoaders": [{ "id": "fabric-0.16.10", "primary": true }]
            }
        });
        assert_eq!(
            curseforge_loader_env(&manifest).unwrap(),
            vec![
                ("TYPE".into(), "FABRIC".into()),
                ("VERSION".into(), "1.21.1".into()),
                ("FABRIC_LOADER_VERSION".into(), "0.16.10".into()),
            ]
        );
    }

    #[test]
    fn scores_prism_instance_names() {
        let expected = vec![slugify("Better MC [FORGE]")];
        assert_eq!(
            prism_candidate_score(&["Better MC [FORGE]".into()], &expected),
            100
        );
        assert_eq!(
            prism_candidate_score(&["Better MC [FORGE] - server copy".into()], &expected),
            50
        );
        assert_eq!(
            prism_candidate_score(&["Unrelated Pack".into()], &expected),
            0
        );
    }
}
