#!/bin/sh
set -eu

HOST_SCRIPT=${HOMESHARD_PRISM_HOST_IMPORT_SCRIPT:-}
LOG_FILE=${HOMESHARD_PRISM_IMPORT_LOG:-/tmp/homeshard-prism-import.log}

if [ "$#" -lt 1 ]; then
  echo "usage: homeshard-prism-import <pack.zip> [expected-name] [original-name]" >&2
  exit 64
fi

if [ -z "$HOST_SCRIPT" ]; then
  echo "HOMESHARD_PRISM_HOST_IMPORT_SCRIPT is not set (absolute host path to prism-import-host.sh); CurseForge auto-import is disabled" >&2
  exit 78
fi

{
  printf '%s host_script=%s args=' "$(date -Is)" "$HOST_SCRIPT"
  for arg in "$@"; do printf '[%s]' "$arg"; done
  printf '\n'
} >>"$LOG_FILE" 2>/dev/null || true

IMPORT_TIMEOUT=${HOMESHARD_PRISM_IMPORT_DOCKER_TIMEOUT:-1500}
CONTAINER_NAME=${HOMESHARD_PRISM_IMPORT_CONTAINER:-homeshard-prism-import}

# Remove any stale import container left behind by a previous crash so the
# --name below is free to reuse.
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

set +e
timeout --signal=TERM --kill-after=30 "$IMPORT_TIMEOUT" \
  docker run --rm \
    --name "$CONTAINER_NAME" \
    --privileged \
    --pid=host \
    --network=host \
    -e HOMESHARD_PRISM_USER="${HOMESHARD_PRISM_USER:-}" \
    -e HOMESHARD_PRISM_DISPLAY="${HOMESHARD_PRISM_DISPLAY:-}" \
    -e HOMESHARD_PRISM_DATA_DIR="${HOMESHARD_PRISM_DATA_DIR:-}" \
    -e HOMESHARD_PRISM_MISSING_MODS_DIR="${HOMESHARD_PRISM_MISSING_MODS_DIR:-}" \
    -v /:/host \
    debian:bookworm-slim \
    chroot /host "$HOST_SCRIPT" "$@"
code=$?
set -e

# On any non-zero exit (including timeout=124) force-remove the container so a
# wedged import can never linger and block the next one.
if [ "$code" -ne 0 ]; then
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
fi
printf '%s exit=%s\n' "$(date -Is)" "$code" >>"$LOG_FILE" 2>/dev/null || true
exit "$code"
