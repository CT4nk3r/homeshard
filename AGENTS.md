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
