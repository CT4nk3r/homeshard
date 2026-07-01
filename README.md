# Homeshard

Homeshard is a self-hostable, **Minecraft-first game-server manager** for you and
a small group of trusted friends. Spin up modpack servers from a web dashboard,
and let a lightweight agent on your home server do the heavy lifting — importing
packs, launching Docker game servers, syncing mods, and taking backups.

> Gameplay stays private when you run it behind [Tailscale](https://tailscale.com):
> the dashboard and game ports are only reachable inside your tailnet.

## Architecture

| Component | Path | What it does |
|-----------|------|--------------|
| **Web dashboard** | `apps/web` | Next.js control plane. Queues commands, shows instance/host status, handles pack + mod uploads. |
| **Agent** | `crates/agent` | Rust worker on the home server. Claims commands from Postgres and runs Docker game servers. |
| **Infra** | `infra/homeserver` | `docker compose` stack: Postgres, migrations, the web dashboard, and the agent. |

The web app and the agent are decoupled: they only talk through the Postgres
`commands` table. The agent processes commands **concurrently, but keeps each
instance independent** — one slow or failing deploy never blocks other servers.

## Features

- Web dashboard to create, start/stop, restart, and trash Minecraft servers
- CurseForge and Modrinth modpack imports
- Per-instance mod management (add/enable/disable/sync)
- Manual-download flow for CurseForge "blocked" mods, surfaced right in the UI
- Backups and cold-storage separation (fast disk for live worlds, big disk for archives)
- Optional [Clerk](https://clerk.com) auth for multi-user access (single-owner demo mode otherwise)

## Quick start

Requirements: a Linux host with **Docker** + the Docker Compose plugin.

```bash
git clone <your-fork-url> homeshard && cd homeshard/infra/homeserver
cp .env.example .env
# edit .env — at minimum set POSTGRES_PASSWORD and OWNER_EMAIL

# create the identity-mounted host directories (match your .env)
sudo mkdir -p /srv/homeshard/instances /srv/homeshard/cold
sudo chown "$USER" /srv/homeshard/instances /srv/homeshard/cold

# 1) dashboard + database only (demo / owner-only)
docker compose up -d --build

# 2) also run the home-server agent (needs Docker socket access)
docker compose --profile agent up -d --build
```

Open `http://<host>:8010` (or your `WEB_PORT`). Without Clerk keys the dashboard
runs in single-owner demo mode as `OWNER_EMAIL`.

## Configuration

Everything is driven by environment variables — see
[`infra/homeserver/.env.example`](infra/homeserver/.env.example) for the full,
documented list. The essentials:

- `POSTGRES_PASSWORD`, `OWNER_EMAIL` — set these.
- `HOMESHARD_MAGIC_DNS` — the hostname players connect to (e.g. your Tailscale
  MagicDNS name); shown in the dashboard.
- `HOMESHARD_GAME_BIND_IP` — the IP game ports bind to. Use your **Tailscale IP**
  to keep servers private, or `0.0.0.0` to expose them on all interfaces.
- `HOST_INSTANCES_DIR`, `HOST_COLD_DIR` — where live worlds and archives live.

### ⚠️ Identity mounts

The agent launches game containers through the **host** Docker socket, so any
path it hands to Docker must be valid on the host. That's why `HOST_INSTANCES_DIR`
and `HOST_COLD_DIR` are bind-mounted at the **same path** inside the agent as on
the host. Change both sides together, or neither.

## CurseForge imports (optional)

CurseForge modpacks import directly from their pack ZIP — no PrismLauncher or
desktop app required. Set a `CF_API_KEY` in `.env` to enable it (Modrinth
`.mrpack` packs and vanilla/Fabric/Forge/NeoForge servers work with no key). You
can also import a PrismLauncher **modlist JSON export**. See
[`infra/homeserver/README.md`](infra/homeserver/README.md) for details.

Some CurseForge projects block automated third-party downloads. When a pack
includes them the deploy pauses with a clear, per-mod list of download links in
the dashboard; download each file, upload it through the UI, and retry the
deploy.

## Development

```bash
pnpm install                                   # web deps (root of repo)
pnpm --filter web dev                          # run the dashboard locally
cargo check --manifest-path crates/agent/Cargo.toml
```

## License

Homeshard is licensed under the **GNU Affero General Public License v3.0**. See
[`LICENSE`](LICENSE).
