#!/usr/bin/env bash
set -euo pipefail

release=${1:-}
repository=${HOMESHARD_IMAGE_REPOSITORY:-${2:-}}
if [[ -z "$release" || -z "$repository" ]]; then
  echo "usage: HOMESHARD_IMAGE_REPOSITORY=ghcr.io/acme/homeshard $0 <release-tag>" >&2
  exit 2
fi

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
web_image="${repository}-web:${release}"
agent_image="${repository}-agent:${release}"

docker build --file "$repo_root/apps/web/Dockerfile" --tag "$web_image" "$repo_root"
docker build --file "$repo_root/crates/agent/Dockerfile" --tag "$agent_image" "$repo_root"
docker push "$web_image"
docker push "$agent_image"

echo "published $web_image and $agent_image"
