# Homeserver deployment

This directory contains the full `docker compose` stack for running Homeshard on
your home server: Postgres, a one-shot migration job, the web dashboard, and the
Rust agent.

## 1. Configure

```bash
cd infra/homeserver
cp .env.example .env
$EDITOR .env            # set at least POSTGRES_PASSWORD and OWNER_EMAIL
```

Every option is documented in [`.env.example`](.env.example).

## 2. Create the host directories

The **instances** and **cold** directories are *identity-mounted* — the agent
sees them at the same absolute path as the host, because it hands those paths to
the host Docker daemon when launching game containers. Create them and make them
writable by the user that runs Compose:

```bash
sudo mkdir -p /srv/homeshard/instances /srv/homeshard/cold
sudo chown "$USER" /srv/homeshard/instances /srv/homeshard/cold
# match whatever you set for HOST_INSTANCES_DIR / HOST_COLD_DIR in .env
```

## 3. Bring it up

```bash
# dashboard + database only (single-owner demo mode)
docker compose up -d --build

# add the agent (mounts the Docker socket to launch game servers)
docker compose --profile agent up -d --build
```

The `migrate` service applies every `apps/web/drizzle/*.sql` file on a fresh
database and is a no-op afterwards. The dashboard listens on `WEB_PORT` (8010 by
default).

## Networking & privacy

Game containers bind to `HOMESHARD_GAME_BIND_IP` on ports `25600-25699`. Set it
to your **Tailscale IP** so servers are reachable only inside your tailnet, and
set `HOMESHARD_MAGIC_DNS` to the hostname players use (e.g. your MagicDNS name) —
the dashboard shows `MAGIC_DNS:port` as the connection address.

The agent only manages containers it labels with `homeshard.managed` and
`homeshard.instance_id`; other containers on the host are never touched.

## CurseForge packs through PrismLauncher (optional)

Modrinth packs and vanilla/Fabric/Forge/NeoForge servers work out of the box.
**CurseForge** packs are different: many mods are blocked from third-party API
downloads, so Homeshard resolves them by driving a real
[PrismLauncher](https://prismlauncher.org) install on the host.

To enable it:

1. Install PrismLauncher on the host under a dedicated user and complete its
   first-run setup (accounts, Java). Note that user and its instances directory.
2. Provide an X display for Prism's GUI (a headless `Xvfb`/VNC display works);
   set `HOMESHARD_PRISM_DISPLAY` if it isn't `:1`.
3. In `.env` set:
   - `HOMESHARD_PRISM_USER` — the OS user that owns the Prism install.
   - `HOST_PRISM_IMPORT_SCRIPT` — the **absolute host path** to this repo's
     `prism-import-host.sh` (e.g. `/opt/homeshard/infra/homeserver/prism-import-host.sh`).
   - `HOST_PRISM_INSTANCES_DIR` — the host PrismLauncher `instances` directory.
   - `HOST_MISSING_MODS_DIR` — a host folder for manually-downloaded mods; this
     is also the folder Prism watches for blocked files, so keep the two aligned.

### Blocked mods

Some CurseForge projects forbid third-party downloads. When a pack includes them
the deploy fails and the dashboard shows a per-mod list with a download link and
expected SHA-1 for each. Download each file from CurseForge, add it through the
blocked-mods upload form (`.jar`/`.zip`), then retry the deploy — Prism matches
the files by hash and continues.

## How imports work

`prism-import-container.sh` (mounted into the agent as
`/usr/local/bin/homeshard-prism-import`) runs a privileged helper container that
`chroot`s into the host and executes `prism-import-host.sh` as
`HOMESHARD_PRISM_USER`. That script imports the pack ZIP through Prism, accepts
the import dialog, waits for the mod jars, and reports any blocked mods. Both the
agent-side call and the helper have timeouts so a wedged import can never block
the agent.
