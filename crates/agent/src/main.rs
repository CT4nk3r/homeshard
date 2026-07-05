use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use std::{
    collections::{BTreeMap, HashSet},
    env,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::{
    process::Command,
    time::{sleep, timeout},
};
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
    minecraft_image_modern: String,
    blob_token: Option<String>,
    cf_api_key: Option<String>,
    missing_mods_dir: Option<String>,
    cf_install_timeout: Duration,
    max_concurrent_commands: usize,
    poll_active_ms: u64,
    poll_idle_ms: u64,
    instance_status_interval: Duration,
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
    PrismModlist,
}

/// One entry from a PrismLauncher JSON modlist export.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ModlistEntry {
    #[serde(default)]
    name: Option<String>,
    url: String,
    #[serde(default)]
    filename: Option<String>,
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
    let status_refresh_in_flight = Arc::new(AtomicBool::new(false));
    let mut idle_cycles = 0u32;
    let mut last_heartbeat = Instant::now();
    let mut last_instance_status = Instant::now()
        .checked_sub(settings.instance_status_interval)
        .unwrap_or_else(Instant::now);

    loop {
        if last_heartbeat.elapsed() >= Duration::from_secs(30) {
            if let Err(error) = heartbeat(&pool, &settings).await {
                warn!(error = %error, "heartbeat failed");
            }
            last_heartbeat = Instant::now();
        }

        if last_instance_status.elapsed() >= settings.instance_status_interval {
            if status_refresh_in_flight
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                let pool = pool.clone();
                let status_refresh_in_flight = status_refresh_in_flight.clone();
                tokio::spawn(async move {
                    if let Err(error) = refresh_instance_statuses(&pool).await {
                        warn!(error = %error, "instance status refresh failed");
                    }
                    status_refresh_in_flight.store(false, Ordering::SeqCst);
                });
            }
            last_instance_status = Instant::now();
        }

        // Cap how many commands run at once. The claim query already prevents
        // two commands for the same instance (or two deploys) from
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
            // Newer Minecraft (e.g. 26.x) needs a newer JRE than 1.x packs; the
            // right image is auto-selected per instance from the pack's MC version.
            minecraft_image_modern: env::var("HOMESHARD_MINECRAFT_IMAGE_MODERN")
                .unwrap_or_else(|_| "itzg/minecraft-server:java25".into()),
            blob_token: optional("BLOB_READ_WRITE_TOKEN"),
            cf_api_key: optional("HOMESHARD_CF_API_KEY").or_else(|| optional("CF_API_KEY")),
            missing_mods_dir: optional("HOMESHARD_MISSING_MODS_DIR"),
            cf_install_timeout: Duration::from_secs(
                env::var("HOMESHARD_CF_INSTALL_TIMEOUT_SECS")
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
            instance_status_interval: Duration::from_secs(
                env::var("HOMESHARD_INSTANCE_STATUS_INTERVAL_SECS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .filter(|seconds| *seconds > 0)
                    .unwrap_or(15),
            ),
        })
    }

    /// Pick the server image whose bundled JRE matches the Minecraft version.
    /// Classic "1.x" versions run on the default (Java 21) image; newer schemes
    /// (e.g. "26.x") need the modern (Java 25) image.
    fn image_for_minecraft_version(&self, version: Option<&str>) -> String {
        pick_minecraft_image(&self.minecraft_image, &self.minecraft_image_modern, version)
    }
}

fn pick_minecraft_image(default_image: &str, modern_image: &str, version: Option<&str>) -> String {
    match version.map(str::trim) {
        Some(version) if !version.is_empty() && !version.starts_with("1.") => modern_image.to_string(),
        _ => default_image.to_string(),
    }
}

/// The Minecraft version a pack targets, read from its stored manifest.
fn pack_minecraft_version(pack: &PackArchive) -> Option<String> {
    match pack.platform {
        PackPlatform::CurseForge => pack
            .manifest
            .get("minecraft")
            .and_then(|value| value.get("version"))
            .and_then(Value::as_str)
            .map(str::to_string),
        PackPlatform::Modrinth => pack
            .manifest
            .get("dependencies")
            .and_then(|value| value.get("minecraft"))
            .and_then(Value::as_str)
            .map(str::to_string),
        // A Prism modlist doesn't carry a version; the caller falls back to the
        // Minecraft version chosen in the create form.
        PackPlatform::PrismModlist => None,
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
        "coldUsedGb": cold_used_gb
    })
}

async fn refresh_instance_statuses(pool: &PgPool) -> Result<()> {
    let rows = sqlx::query("SELECT id FROM instances WHERE state = 'running'")
        .fetch_all(pool)
        .await?;

    for row in rows {
        let instance_id: Uuid = row.get("id");
        let container = format!("homeshard-{instance_id}");
        let result = timeout(
            Duration::from_secs(5),
            docker_exec(&[&container, "rcon-cli", "list"]),
        )
        .await;

        let output = match result {
            Ok(Ok(output)) => output,
            Ok(Err(error)) => {
                warn!(%instance_id, error = %error, "could not query instance player count");
                continue;
            }
            Err(_) => {
                warn!(%instance_id, "instance player count query timed out");
                continue;
            }
        };

        let Some((players, max_players)) = parse_player_count(&output) else {
            warn!(%instance_id, output = %output, "could not parse instance player count");
            continue;
        };

        sqlx::query(
            r#"
            UPDATE instances
            SET status = COALESCE(status, '{}'::jsonb) || jsonb_build_object(
                'players', $2::int,
                'maxPlayers', $3::int,
                'statusUpdatedAt', now()
            )
            WHERE id = $1 AND state = 'running'
            "#,
        )
        .bind(instance_id)
        .bind(players)
        .bind(max_players)
        .execute(pool)
        .await?;

        info!(%instance_id, players, max_players, "instance player count updated");
    }

    Ok(())
}

fn parse_player_count(output: &str) -> Option<(i32, i32)> {
    let (_, after_prefix) = output.split_once("There are ")?;
    let (players, after_players) = after_prefix.split_once(" of a max of ")?;
    let (max_players, _) = after_players.split_once(" players online")?;
    Some((players.trim().parse().ok()?, max_players.trim().parse().ok()?))
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
            -- Only one deploy (create/retry) at a time, so instance creation
            -- can't race on slug/port allocation. Never blocks other commands.
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
    _instance_name: &str,
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
        container.clone(),
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
    let mut auto_curseforge = false;
    if let Some(pack) = pack {
        match pack.platform {
            // Install the pack headlessly through the itzg image's CurseForge API
            // support. No privileged host access, no GUI launcher.
            PackPlatform::CurseForge => {
                let cf_api_key = settings.cf_api_key.as_deref().ok_or_else(|| {
                    anyhow!("CurseForge packs require a CurseForge API key; set CF_API_KEY")
                })?;
                add_curseforge_auto_arguments(&mut args, settings, pack, cf_api_key);
                auto_curseforge = true;
            }
            PackPlatform::Modrinth => add_modrinth_pack_arguments(&mut args, pack),
            // Recreate a PrismLauncher modlist export: resolve each mod to an
            // exact pinned file and install it headlessly. Loader + MC version
            // come from the create form (they aren't in the export).
            PackPlatform::PrismModlist => {
                add_prism_modlist_arguments(&mut args, settings, pack, server_type, game_version)
                    .await?;
                auto_curseforge = true;
            }
        }
    } else {
        args.extend([
            "-e".into(),
            format!("TYPE={server_type}"),
            "-e".into(),
            format!("VERSION={game_version}"),
        ]);
    }
    // Match the server image's JRE to the Minecraft version so newer packs (e.g.
    // 26.x on Java 25) and classic 1.x packs (Java 21) both start cleanly.
    let mc_version = pack
        .and_then(pack_minecraft_version)
        .unwrap_or_else(|| game_version.to_string());
    args.push(settings.image_for_minecraft_version(Some(&mc_version)));
    docker_owned(&args).await?;
    if auto_curseforge {
        if let Err(error) = await_curseforge_install(settings, &container).await {
            let _ = docker(["rm", "-f", &container]).await;
            return Err(error);
        }
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

fn add_curseforge_auto_arguments(
    args: &mut Vec<String>,
    settings: &Settings,
    pack: &PackArchive,
    cf_api_key: &str,
) {
    args.extend([
        "-e".into(),
        "MODPACK_PLATFORM=AUTO_CURSEFORGE".into(),
        "-e".into(),
        format!("CF_API_KEY={cf_api_key}"),
        // Install the uploaded (possibly unpublished) modpack archive directly.
        "-e".into(),
        "CF_MODPACK_ZIP=/modpack.zip".into(),
        // A slug is required alongside CF_MODPACK_ZIP; a placeholder is fine.
        "-e".into(),
        "CF_SLUG=homeshard".into(),
        "-v".into(),
        format!("{}:/modpack.zip:ro", pack.path.display()),
    ]);
    // Let the itzg image pick up manually-downloaded "blocked" mods that the user
    // uploaded through Homeshard.
    if let Some(dir) = settings.missing_mods_dir.as_deref() {
        args.extend(["-v".into(), format!("{dir}:/downloads/mods:ro")]);
    }
}

/// Read a PrismLauncher JSON modlist export (a JSON array of mod entries). Returns
/// None if the file is not such an export (e.g. it's a ZIP pack).
async fn read_prism_modlist(path: &Path) -> Option<Vec<ModlistEntry>> {
    let metadata = tokio::fs::metadata(path).await.ok()?;
    if metadata.len() > 8 * 1024 * 1024 {
        return None;
    }
    let text = tokio::fs::read_to_string(path).await.ok()?;
    let mods: Vec<ModlistEntry> = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    // Require at least one entry that actually looks like a mod reference.
    if mods.iter().any(|entry| entry.filename.is_some() && !entry.url.is_empty()) {
        Some(mods)
    } else {
        None
    }
}

/// Resolve every mod in a Prism modlist to an exact pinned file and set the itzg
/// CURSEFORGE_FILES / MODRINTH_PROJECTS environment variables. The mod loader and
/// Minecraft version come from the create form, not the export.
async fn add_prism_modlist_arguments(
    args: &mut Vec<String>,
    settings: &Settings,
    pack: &PackArchive,
    server_type: &str,
    game_version: &str,
) -> Result<()> {
    let cf_api_key = settings
        .cf_api_key
        .clone()
        .ok_or_else(|| anyhow!("Prism modlists with CurseForge mods require a CurseForge API key; set CF_API_KEY"))?;
    let mods: Vec<ModlistEntry> = pack
        .manifest
        .get("homeshardModlist")
        .cloned()
        .map(serde_json::from_value)
        .transpose()?
        .ok_or_else(|| anyhow!("stored Prism modlist is missing its mod entries"))?;

    let mut set = tokio::task::JoinSet::new();
    let semaphore = Arc::new(tokio::sync::Semaphore::new(10));
    for entry in mods {
        let cf_api_key = cf_api_key.clone();
        let semaphore = semaphore.clone();
        set.spawn(async move {
            let _permit = semaphore.acquire_owned().await.ok();
            resolve_modlist_entry(&cf_api_key, &entry).await
        });
    }

    let mut cf_refs = Vec::new();
    let mut mr_refs = Vec::new();
    let mut unresolved = Vec::new();
    while let Some(joined) = set.join_next().await {
        match joined? {
            Ok(ResolvedMod::CurseForge(reference)) => cf_refs.push(reference),
            Ok(ResolvedMod::Modrinth(reference)) => mr_refs.push(reference),
            Ok(ResolvedMod::Skipped) => {}
            Err(label) => unresolved.push(label),
        }
    }

    if !unresolved.is_empty() {
        unresolved.sort();
        return Err(anyhow!(
            "Could not resolve {} mod(s) from the Prism modlist: {}",
            unresolved.len(),
            unresolved.join("; ")
        ));
    }

    args.extend([
        "-e".into(),
        format!("TYPE={server_type}"),
        "-e".into(),
        format!("VERSION={game_version}"),
        "-e".into(),
        format!("CF_API_KEY={cf_api_key}"),
    ]);
    if !cf_refs.is_empty() {
        args.extend(["-e".into(), format!("CURSEFORGE_FILES={}", cf_refs.join(","))]);
    }
    if !mr_refs.is_empty() {
        args.extend(["-e".into(), format!("MODRINTH_PROJECTS={}", mr_refs.join(","))]);
    }
    if let Some(dir) = settings.missing_mods_dir.as_deref() {
        args.extend(["-v".into(), format!("{dir}:/downloads/mods:ro")]);
    }
    Ok(())
}

enum ResolvedMod {
    CurseForge(String),
    Modrinth(String),
    /// The mod was disabled in Prism (filename ends in .disabled); skip it.
    Skipped,
}

/// Resolve one modlist entry to a pinned itzg reference, or Err(label) naming the
/// mod that could not be resolved.
async fn resolve_modlist_entry(
    cf_api_key: &str,
    entry: &ModlistEntry,
) -> std::result::Result<ResolvedMod, String> {
    let label = entry
        .name
        .clone()
        .or_else(|| entry.filename.clone())
        .unwrap_or_else(|| entry.url.clone());
    let filename = match entry.filename.as_deref() {
        Some(filename) if !filename.is_empty() => filename,
        _ => return Err(format!("{label} (no filename in export)")),
    };
    // PrismLauncher appends ".disabled" to mods the user turned off; honor that by
    // leaving them out of the server.
    let filename = match filename.strip_suffix(".disabled") {
        Some(_) => return Ok(ResolvedMod::Skipped),
        None => filename,
    };

    if let Some(project_id) = curseforge_project_id(&entry.url) {
        match resolve_curseforge_file_id(cf_api_key, project_id, filename).await {
            Ok(file_id) => Ok(ResolvedMod::CurseForge(format!("{project_id}:{file_id}"))),
            Err(error) => Err(format!("{label} ({error})")),
        }
    } else if let Some(slug) = modrinth_slug(&entry.url) {
        match resolve_modrinth_version(&slug, filename).await {
            Ok(version_id) => Ok(ResolvedMod::Modrinth(format!("{slug}:{version_id}"))),
            Err(error) => Err(format!("{label} ({error})")),
        }
    } else {
        Err(format!("{label} (unrecognized url: {})", entry.url))
    }
}

fn curseforge_project_id(url: &str) -> Option<u64> {
    let rest = url.split("curseforge.com/projects/").nth(1)?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

fn modrinth_slug(url: &str) -> Option<String> {
    let rest = url.split("modrinth.com/").nth(1)?;
    let slug = rest.rsplit('/').next()?.split(['?', '#']).next()?;
    if slug.is_empty() {
        None
    } else {
        Some(slug.to_string())
    }
}

async fn resolve_curseforge_file_id(
    cf_api_key: &str,
    project_id: u64,
    filename: &str,
) -> std::result::Result<i64, String> {
    for index in (0..1000).step_by(50) {
        let url = format!(
            "https://api.curseforge.com/v1/mods/{project_id}/files?pageSize=50&index={index}"
        );
        let body = curl_json(&url, &["-H", &format!("x-api-key: {cf_api_key}")])
            .await
            .map_err(|error| error.to_string())?;
        let files = body.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
        for file in &files {
            if file.get("fileName").and_then(Value::as_str) == Some(filename) {
                return file
                    .get("id")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| "malformed file id".to_string());
            }
        }
        if files.len() < 50 {
            break;
        }
    }
    Err("file not found on CurseForge".to_string())
}

async fn resolve_modrinth_version(
    slug: &str,
    filename: &str,
) -> std::result::Result<String, String> {
    let url = format!("https://api.modrinth.com/v2/project/{slug}/version");
    let body = curl_json(&url, &[]).await.map_err(|error| error.to_string())?;
    let versions = body.as_array().ok_or_else(|| "malformed Modrinth response".to_string())?;
    for version in versions {
        let Some(files) = version.get("files").and_then(Value::as_array) else {
            continue;
        };
        if files
            .iter()
            .any(|file| file.get("filename").and_then(Value::as_str) == Some(filename))
        {
            return version
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| "malformed version id".to_string());
        }
    }
    Err("version not found on Modrinth".to_string())
}

async fn curl_json(url: &str, extra: &[&str]) -> Result<Value> {
    let mut params = vec![
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--max-time",
        "30",
        "-H",
        "Accept: application/json",
        "-H",
        "User-Agent: homeshard-agent",
    ];
    params.extend_from_slice(extra);
    params.push(url);
    let output = run_command("curl", &params).await?;
    serde_json::from_str(&output).with_context(|| format!("parse JSON from {url}"))
}

/// Surfaces blocked-mod downloads in Homeshard's standard format and is bounded
/// so a stuck install can never block the agent forever.
async fn await_curseforge_install(settings: &Settings, container: &str) -> Result<()> {
    let deadline = Instant::now() + settings.cf_install_timeout;
    loop {
        let logs = container_logs(container, 800).await.unwrap_or_default();
        if let Some(message) = blocked_mods_from_cf_logs(&logs) {
            return Err(anyhow!("{message}"));
        }
        if curseforge_server_ready(&logs) {
            return Ok(());
        }
        let (running, exit_code) = container_state(container).await?;
        if !running {
            let tail = logs
                .lines()
                .rev()
                .take(20)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n");
            return Err(anyhow!(
                "CurseForge install failed (server container exited with code {exit_code}). Recent output:\n{tail}"
            ));
        }
        if Instant::now() >= deadline {
            return Err(anyhow!(
                "CurseForge install timed out after {}s",
                settings.cf_install_timeout.as_secs()
            ));
        }
        sleep(Duration::from_secs(3)).await;
    }
}

fn curseforge_server_ready(logs: &str) -> bool {
    logs.contains("RCON running on") || logs.contains("For help, type") || logs.contains("Done (")
}

/// Best-effort detection of CurseForge mods that must be downloaded manually,
/// reformatted into the `Blocked mod:` / `Download:` shape the dashboard parses.
fn blocked_mods_from_cf_logs(logs: &str) -> Option<String> {
    let lower = logs.to_lowercase();
    let manual_needed = lower.contains("manually download")
        || lower.contains("mods need download")
        || lower.contains("must be downloaded manually")
        || lower.contains("need to be downloaded manually")
        || lower.contains("manual download");
    if !manual_needed {
        return None;
    }
    let mut seen = HashSet::new();
    let mut mods: Vec<(String, String)> = Vec::new();
    for raw in logs.split(|c: char| {
        c.is_whitespace() || matches!(c, '(' | ')' | '"' | '\'' | ',' | '<' | '>')
    }) {
        let url = raw.trim_end_matches(|c: char| matches!(c, '.' | ',' | ')' | ']' | '>' | ':'));
        if (url.starts_with("https://www.curseforge.com/") || url.starts_with("https://curseforge.com/"))
            && seen.insert(url.to_string())
        {
            mods.push((cf_name_from_url(url), url.to_string()));
        }
    }
    if mods.is_empty() {
        return None;
    }
    let mut message =
        String::from("Manual CurseForge download(s) required before this pack can install.\n");
    for (name, url) in &mods {
        message.push_str(&format!("Blocked mod: {name}\nDownload: {url}\n"));
    }
    message.push_str("Download each file from CurseForge, add it through Homeshard, then retry deploy.");
    Some(message)
}

fn cf_name_from_url(url: &str) -> String {
    url.split('/')
        .filter(|segment| !segment.is_empty())
        .rev()
        .find(|segment| {
            *segment != "download"
                && *segment != "files"
                && !segment.chars().all(|c| c.is_ascii_digit())
        })
        .map(|segment| segment.replace('-', " "))
        .unwrap_or_else(|| url.to_string())
}

async fn container_state(container: &str) -> Result<(bool, i64)> {
    let output = run_command(
        "docker",
        &["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", container],
    )
    .await?;
    let mut parts = output.split_whitespace();
    let running = parts.next() == Some("true");
    let exit_code = parts.next().and_then(|value| value.parse().ok()).unwrap_or(0);
    Ok((running, exit_code))
}

async fn container_logs(container: &str, lines: u32) -> Result<String> {
    let output = Command::new("docker")
        .args(["logs", "--tail", &lines.to_string(), container])
        .output()
        .await
        .with_context(|| format!("read logs for container {container}"))?;
    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok(combined)
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
    let extension = match platform {
        PackPlatform::PrismModlist => "json",
        _ => "zip",
    };
    let archive = pack_dir.join(format!("{digest}.{extension}"));
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
    // A PrismLauncher JSON modlist export is a plain JSON array, not a ZIP.
    if let Some(mods) = read_prism_modlist(path).await {
        return Ok((json!({ "homeshardModlist": mods }), PackPlatform::PrismModlist));
    }

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
    if manifest.get("homeshardModlist").is_some() {
        return Ok(PackPlatform::PrismModlist);
    }
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
    let status_patch = if state == "running" {
        json!({})
    } else {
        json!({ "players": 0, "statusUpdatedAt": Value::Null })
    };
    merge_instance_state(pool, instance_id, state, status_patch).await?;
    Ok(CommandResult {
        ok: true,
        message: format!("{action} queued for {instance_id}"),
        data: json!({ "instanceId": instance_id, "state": state }),
    })
}

async fn merge_instance_state(
    pool: &PgPool,
    instance_id: Uuid,
    state: &str,
    status_patch: Value,
) -> Result<()> {
    sqlx::query(
        "UPDATE instances SET state = $2::instance_state, status = COALESCE(status, '{}'::jsonb) || $3::jsonb, updated_at = now() WHERE id = $1",
    )
    .bind(instance_id)
    .bind(state)
    .bind(status_patch)
    .execute(pool)
    .await?;
    Ok(())
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
    let mut command = Command::new(program);
    command.kill_on_drop(true).args(args);
    let output = command
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
    use super::{
        blocked_mods_from_cf_logs, cf_name_from_url, curseforge_project_id, curseforge_server_ready,
        modrinth_slug, parse_meminfo, parse_player_count, pick_minecraft_image, slugify,
    };

    #[test]
    fn parses_curseforge_project_id_from_export_url() {
        assert_eq!(
            curseforge_project_id("https://www.curseforge.com/projects/1191517"),
            Some(1191517)
        );
        assert_eq!(curseforge_project_id("https://modrinth.com/mod/tagwiZkJ"), None);
        assert_eq!(
            curseforge_project_id("https://www.curseforge.com/minecraft/mc-mods/jei"),
            None
        );
    }

    #[test]
    fn parses_modrinth_slug_from_export_url() {
        assert_eq!(
            modrinth_slug("https://modrinth.com/mod/tagwiZkJ"),
            Some("tagwiZkJ".to_string())
        );
        assert_eq!(
            modrinth_slug("https://modrinth.com/mod/sodium?foo=1"),
            Some("sodium".to_string())
        );
        assert_eq!(modrinth_slug("https://www.curseforge.com/projects/123"), None);
    }

    #[test]
    fn selects_java_image_by_minecraft_version() {
        let default_image = "itzg/minecraft-server:java21";
        let modern_image = "itzg/minecraft-server:java25";
        assert_eq!(pick_minecraft_image(default_image, modern_image, Some("1.21.1")), default_image);
        assert_eq!(pick_minecraft_image(default_image, modern_image, Some("1.20.4")), default_image);
        assert_eq!(pick_minecraft_image(default_image, modern_image, Some("26.1.2")), modern_image);
        assert_eq!(pick_minecraft_image(default_image, modern_image, Some(" ")), default_image);
        assert_eq!(pick_minecraft_image(default_image, modern_image, None), default_image);
    }

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
    fn parses_player_counts() {
        assert_eq!(
            parse_player_count("There are 0 of a max of 20 players online:"),
            Some((0, 20))
        );
        assert_eq!(
            parse_player_count("There are 1 of a max of 20 players online: PlayerOne"),
            Some((1, 20))
        );
        assert_eq!(
            parse_player_count("There are 3 of a max of 12 players online: One, Two, Three"),
            Some((3, 12))
        );
    }

    #[test]
    fn rejects_malformed_player_counts() {
        assert_eq!(parse_player_count("No players are online"), None);
        assert_eq!(
            parse_player_count("There are many of a max of 20 players online:"),
            None
        );
    }

    #[test]
    fn cf_name_from_url_extracts_readable_name() {
        assert_eq!(
            cf_name_from_url(
                "https://www.curseforge.com/minecraft/mc-mods/custom-nether-portals/download/8267193"
            ),
            "custom nether portals"
        );
        assert_eq!(
            cf_name_from_url(
                "https://www.curseforge.com/minecraft/texture-packs/immersive-interfaces/download/8190061"
            ),
            "immersive interfaces"
        );
    }

    #[test]
    fn blocked_mods_from_cf_logs_parses_manual_downloads() {
        let logs = "\
[mc-image-helper] Some mods need to be downloaded manually:
  Custom Nether Portals https://www.curseforge.com/minecraft/mc-mods/custom-nether-portals/download/8267193
  Immersive Interfaces (https://www.curseforge.com/minecraft/texture-packs/immersive-interfaces/download/8190061)
";
        let message = blocked_mods_from_cf_logs(logs).expect("should detect blocked mods");
        assert_eq!(message.matches("Blocked mod:").count(), 2);
        assert!(message.contains(
            "Download: https://www.curseforge.com/minecraft/mc-mods/custom-nether-portals/download/8267193"
        ));
        assert!(message.contains("Blocked mod: immersive interfaces"));
    }

    #[test]
    fn blocked_mods_from_cf_logs_ignores_normal_output() {
        let logs = "[init] Starting the Minecraft server\nDone (12.3s)! For help, type \"help\"";
        assert!(blocked_mods_from_cf_logs(logs).is_none());
    }

    #[test]
    fn curseforge_server_ready_detects_startup() {
        assert!(curseforge_server_ready("Done (12.3s)! For help, type \"help\""));
        assert!(curseforge_server_ready("[15:00:00] [Server thread]: RCON running on 0.0.0.0:25575"));
        assert!(!curseforge_server_ready("Downloading mods (12/175)"));
    }
}
