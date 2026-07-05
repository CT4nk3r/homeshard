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

## Checks

Run `docker compose -f infra/homeserver/compose.yml config` with suitable example
variables. For script edits, run `bash -n infra/homeserver/*.sh`; do not perform a
real deployment or promotion unless explicitly requested.
