# Homeshard contributor guide

Homeshard is a self-hosted, Minecraft-first server manager. The Next.js web app
is the control plane; the Rust agent runs beside the host Docker daemon. They do
not call each other directly: Postgres tables, especially `commands`, are their
shared contract.

## Repository map

- `apps/web`: Next.js dashboard, API routes, authentication, Drizzle schema and migrations.
- `crates/agent`: Rust worker that claims commands and manages game containers and files.
- `infra/homeserver`: Docker Compose stack and preview/live release scripts.

Read the nearest nested `AGENTS.md` before changing one of these areas.

## Working rules

- Multiple agents may share this checkout concurrently. Assume unfamiliar working-tree changes
  belong to another active task; never overwrite, revert, stage, or commit them without confirmation.
- Preserve user changes; check `git status` before editing and keep unrelated diffs untouched.
- Treat command kinds/payloads and database columns as cross-component APIs. Update producers,
  consumers, types, and migrations together.
- Generate a new Drizzle migration for schema changes; do not rewrite migrations that may have run.
- Keep secrets out of source control. Add documented placeholders to the relevant `.env.example`.
- Preserve host-path identity mounts used by the agent and game containers.
- Prefer focused changes over new abstractions in this small codebase.

## macOS local development

- macOS is fine for web development and local preview testing with Docker Desktop,
  but it is not the production-equivalent homeserver runtime. Validate release
  candidates on the Linux Docker host before promoting to live.
- For a local Compose preview on macOS, copy
  `infra/homeserver/preview.env.example` to `infra/homeserver/.env.preview` and
  replace `/srv/homeshard-preview/*` paths with absolute paths under the user's
  home directory, such as `/Users/<you>/homeshard-preview/instances`.
- Create the preview folders before starting Compose, and ensure Docker Desktop
  file sharing allows the parent directory.
- Keep identity mounts intact: `HOST_INSTANCES_DIR`, `HOST_COLD_DIR`,
  `HOST_STAGING_DIR`, and `HOST_MISSING_MODS_DIR` must be valid absolute paths
  from both macOS and Docker Desktop because the agent passes them to the host
  Docker daemon.
- For local Mac testing, prefer `HOMESHARD_GAME_BIND_IP=0.0.0.0` or
  `127.0.0.1`; do not assume the Linux homeserver's Tailscale bind address works
  on macOS.
- Do not run live deployment or promotion commands from a Mac unless the user
  explicitly asks for that operation.

## Checks

Run the smallest relevant checks, then broaden when a shared contract changed:

```bash
pnpm --filter web test
pnpm --filter web lint
pnpm --filter web build
cargo fmt --check
cargo test --manifest-path crates/agent/Cargo.toml
docker compose -f infra/homeserver/compose.yml config
```

The web app can run without Clerk or a database in demo mode, but persistence,
agent execution, and migrations require Postgres.
