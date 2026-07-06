# Preview and live deployments

Homeshard can run two isolated Compose projects on one Docker host. Preview uses
its own database volume, host folders, dashboard port, agent identity, and game
port range. Live keeps the existing production paths and ports.

## One-time setup

```bash
cd infra/homeserver
cp preview.env.example .env.preview
cp live.env.example .env.live
$EDITOR .env.preview .env.live
```

Use different passwords and credentials in each file. Set
`HOMESHARD_IMAGE_REPOSITORY` to a registry path you can push and pull (the
templates use `ghcr.io/ct4nk3r/homeshard`). Authenticate Docker before
publishing or deploying.

Create the four host folders listed in each environment file. Preview defaults
to `/srv/homeshard-preview/*`; live defaults to `/srv/homeshard/*`. These paths
must never overlap because the agent hands them to the host Docker daemon.

## Local preview

Build from the current checkout and start only the preview stack:

```bash
./infra/homeserver/deploy.sh preview --local
```

## Publish and deploy an immutable release

Use a commit SHA or another immutable identifier as the release tag:

```bash
export HOMESHARD_IMAGE_REPOSITORY=ghcr.io/ct4nk3r/homeshard
release=$(git rev-parse --short=12 HEAD)
./infra/homeserver/build-release.sh "$release"
./infra/homeserver/deploy.sh preview "$release"
```

Exercise the dashboard and create a disposable preview game server. Once that
exact release has passed validation, promote it without rebuilding:

```bash
./infra/homeserver/promote-live.sh "$release"
```

The promotion script requires the release tag to be typed again. Automation can
set `PROMOTE_LIVE=1` after applying its own protected-environment approval.

## Isolation guarantees

- Compose projects are named `homeshard-preview` and `homeshard-live`, so their
  Postgres volumes and service containers are independent.
- Preview defaults to dashboard port `8011` and game ports `25700-25799`; live
  defaults to `8010` and `25600-25699`.
- Instance, cold, staging, and missing-mod directories are separate.
- Release deployment uses `--no-build`, ensuring live runs the same image tags
  tested in preview.

Back up the live Postgres volume and live host directories before deploying a
release that includes database migrations. Promotion moves application images;
it deliberately never copies preview data into live.
