#!/usr/bin/env bash
set -euo pipefail

release=${1:-}
if [[ -z "$release" ]]; then
  echo "usage: $0 <tested-preview-release-tag>" >&2
  exit 2
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

if [[ ${PROMOTE_LIVE:-0} != 1 ]]; then
  read -r -p "Promote release '$release' to LIVE? Type the release tag to continue: " confirmation
  if [[ "$confirmation" != "$release" ]]; then
    echo "promotion cancelled" >&2
    exit 1
  fi
fi

"$script_dir/deploy.sh" live "$release"
