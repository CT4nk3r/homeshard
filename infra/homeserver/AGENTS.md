# Homeserver deployment

This directory owns the Docker Compose stack, environment templates, and the
preview-to-live release flow. Read `README.md` for operation and `ENVIRONMENTS.md`
before changing release scripts.

## Invariants

- Active, cold, and missing-mod host directories are identity-mounted into the
  agent because child game containers are created through the host Docker socket.
- Preview and live must keep separate Compose projects, databases, directories,
  dashboard ports, agent IDs, and game-port ranges.
- Live promotion deploys the exact image tag tested in preview; do not rebuild it.
- Migrations run once in filename order and must fail the deployment on SQL errors.
- Never commit populated `.env` files or real credentials. Keep defaults and new
  variables synchronized across Compose, examples, scripts, and documentation.
- Do not weaken private network defaults or expose Docker/game ports silently.

## macOS preview notes

- Docker Desktop can run the preview stack for development, but treat it as a
  local preview only. Final release validation and live promotion should happen
  on the Linux homeserver unless the user explicitly says otherwise.
- A Mac preview must use `infra/homeserver/.env.preview`, not `.env.live`, with
  host directories changed from `/srv/homeshard-preview/*` to Docker Desktop
  shared absolute paths such as `/Users/<you>/homeshard-preview/*`.
- Preserve identity-mounted path values. The agent launches child containers
  through the Docker socket, so paths in `HOST_INSTANCES_DIR`, `HOST_COLD_DIR`,
  `HOST_STAGING_DIR`, and `HOST_MISSING_MODS_DIR` must be valid on the Mac host
  and mounted at the same paths where required by `compose.yml`.
- Prefer `HOMESHARD_GAME_BIND_IP=0.0.0.0` or `127.0.0.1` for local Mac previews;
  Linux homeserver private-network addresses may not exist on macOS.

## Checks

Run `docker compose -f infra/homeserver/compose.yml config` with suitable example
variables. For script edits, run `bash -n infra/homeserver/*.sh`; do not perform a
real deployment or promotion unless explicitly requested.
