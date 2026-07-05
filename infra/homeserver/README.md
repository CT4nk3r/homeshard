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

The `migrate` service records and applies each `apps/web/drizzle/*.sql` file once,
in filename order. The dashboard listens on `WEB_PORT` (8010 by default).

## Networking & privacy

Game containers bind to `HOMESHARD_GAME_BIND_IP` on ports `25600-25699`. Set it
to your **Tailscale IP** so servers are reachable only inside your tailnet, and
set `HOMESHARD_MAGIC_DNS` to the hostname players use (e.g. your MagicDNS name) —
the dashboard shows `MAGIC_DNS:port` as the connection address.

The agent only manages containers it labels with `homeshard.managed` and
`homeshard.instance_id`; other containers on the host are never touched.

## CurseForge & Modrinth packs

Modrinth `.mrpack` packs and vanilla/Fabric/Forge/NeoForge servers work out of
the box. **CurseForge** packs need a CurseForge API key: set `CF_API_KEY` in
`.env` and the agent imports the pack ZIP headlessly through the itzg
`AUTO_CURSEFORGE` installer — no PrismLauncher, desktop app, or X display.

> **Getting a key:** CurseForge issues API keys to approved projects through the
> [CurseForge developer console](https://console.curseforge.com/). Access is
> limited, so if you can't get one, use Modrinth packs or the Prism modlist
> import below instead — neither needs a key.

You can also import a **PrismLauncher modlist JSON export** (`.json`). The agent
resolves each CurseForge/Modrinth mod through their public APIs and installs
them, using the server type and Minecraft version chosen in the create form.

### Blocked mods

Some CurseForge projects forbid automated third-party downloads. When a pack
includes them the deploy pauses and the dashboard shows a per-mod list with a
download link and expected SHA-1 for each. Download each file from CurseForge,
add it through the blocked-mods upload form (`.jar`/`.zip`), then retry the
deploy — the agent picks the files up from `HOST_MISSING_MODS_DIR` and continues.

## How imports work

The agent stages the uploaded pack, then launches the itzg
[`minecraft-server`](https://docker-minecraft-server.readthedocs.io) image with
the right platform env: `AUTO_CURSEFORGE` + `CF_API_KEY` for CurseForge ZIPs,
`MODRINTH` for `.mrpack`, or resolved `CURSEFORGE_FILES`/`MODRINTH_PROJECTS` for
a Prism modlist. It watches the install, re-surfaces any blocked mods, and picks
the JRE image that matches the pack's Minecraft version. The install has a
timeout so a stuck download can never block the agent.
