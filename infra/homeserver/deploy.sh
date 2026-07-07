#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <preview|live> [release-tag|--local]" >&2
  exit 2
}

environment=${1:-}
release=${2:---local}
[[ "$environment" == "preview" || "$environment" == "live" ]] || usage

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
env_file="$script_dir/.env.$environment"
project="homeshard-$environment"

if [[ ! -f "$env_file" ]]; then
  echo "missing $env_file; copy ${environment}.env.example and configure it first" >&2
  exit 1
fi

compose=(docker compose --project-name "$project" --env-file "$env_file" -f "$script_dir/compose.yml" --profile agent)

if [[ "$release" == "--local" ]]; then
  "${compose[@]}" up -d --build --wait --wait-timeout 180
else
  repository=${HOMESHARD_IMAGE_REPOSITORY:-}
  if [[ -z "$repository" ]]; then
    repository=$(sed -n 's/^HOMESHARD_IMAGE_REPOSITORY=//p' "$env_file" | tail -n 1)
  fi
  if [[ -z "$repository" ]]; then
    echo "set HOMESHARD_IMAGE_REPOSITORY (for example ghcr.io/acme/homeshard)" >&2
    exit 1
  fi

  export HOMESHARD_WEB_IMAGE="${repository}-web:${release}"
  export HOMESHARD_AGENT_IMAGE="${repository}-agent:${release}"
  export HOMESHARD_SLEEP_PROXY_IMAGE="$HOMESHARD_AGENT_IMAGE"
  "${compose[@]}" pull web agent
  "${compose[@]}" up -d --no-build --wait --wait-timeout 180
fi

"${compose[@]}" ps
echo "$environment is running release $release"
