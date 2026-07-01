#!/usr/bin/env bash
set -euo pipefail

# The PrismLauncher setup lives in this user's home directory; the import runs
# as them. Configure via HOMESHARD_PRISM_USER.
prism_user=${HOMESHARD_PRISM_USER:-}

if [ "$(id -u)" -eq 0 ]; then
  if [ -z "$prism_user" ]; then
    echo "HOMESHARD_PRISM_USER must be set (the OS user that owns the PrismLauncher install)" >&2
    exit 78
  fi
  if command -v runuser >/dev/null 2>&1; then
    exec runuser -u "$prism_user" -- "$0" "$@"
  fi
  exec sudo -u "$prism_user" "$0" "$@"
fi

if [ "$#" -lt 1 ]; then
  echo "usage: prism-import-host.sh <pack.zip> [expected-name] [original-name]" >&2
  exit 64
fi

pack=$1
expected=${2:-}
if [ -z "$expected" ]; then
  expected=$(basename "$pack")
  expected=${expected%.*}
fi

data_dir=${HOMESHARD_PRISM_DATA_DIR:-"$HOME/.local/share/PrismLauncher"}
instances_dir="$data_dir/instances"
missing_mods_dir=${HOMESHARD_PRISM_MISSING_MODS_DIR:-"$HOME/random_mods"}
display=${HOMESHARD_PRISM_DISPLAY:-:1}
log_dir="$data_dir/homeshard-import-logs"
log_file="$log_dir/import-$(date +%Y%m%d-%H%M%S)-$expected.log"

export DISPLAY=$display
mkdir -p "$instances_dir" "$log_dir" "$missing_mods_dir"

ensure_prism_setting() {
  local key=$1 value=$2 cfg="$data_dir/prismlauncher.cfg"
  touch "$cfg"
  grep -q '^\[General\]' "$cfg" || printf '[General]\n' >>"$cfg"
  if grep -q "^${key}=" "$cfg"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$cfg"
  else
    printf '%s=%s\n' "$key" "$value" >>"$cfg"
  fi
}

ensure_prism_setting CentralModsDir "$missing_mods_dir"
ensure_prism_setting DownloadsDir "$missing_mods_dir"
ensure_prism_setting DownloadsDirWatchRecursive false
ensure_prism_setting MoveModsFromDownloadsDir false

command -v prismlauncher >/dev/null 2>&1 || { echo "prismlauncher is not installed on the host" >&2; exit 69; }
command -v xdotool >/dev/null 2>&1 || { echo "xdotool is not installed on the host" >&2; exit 69; }

if ! DISPLAY=$display xdotool getdisplaygeometry >/dev/null 2>&1; then
  if command -v vncserver >/dev/null 2>&1; then
    vncserver "$display" >/dev/null 2>&1 || true
    sleep 3
  fi
fi

if ! DISPLAY=$display xdotool getdisplaygeometry >/dev/null 2>&1; then
  echo "Prism display $display is not available" >&2
  exit 70
fi

candidate_with_mods() {
  local dir mods_dir cfg name
  for dir in "$instances_dir/$expected" "$instances_dir"/*; do
    [ -d "$dir" ] || continue
    name=$(basename "$dir")
    cfg="$dir/instance.cfg"
    if [ "$name" != "$expected" ] && ! grep -qiE "^(name|ManagedPackName)=${expected}$" "$cfg" 2>/dev/null; then
      continue
    fi
    for mods_dir in "$dir/minecraft/mods" "$dir/.minecraft/mods"; do
      if [ -d "$mods_dir" ] && find "$mods_dir" -maxdepth 1 -type f -name '*.jar' -print -quit | grep -q .; then
        printf '%s\n' "$dir"
        return 0
      fi
    done
  done
  return 1
}

blocked_mods_window_visible() {
  DISPLAY=$display xdotool search --name 'Blocked mods found' >/dev/null 2>&1
}

# Print "name<TAB>url<TAB>hash" for every mod in the most recent Blocked Mods
# dialog belonging to THIS import (parsed from this run's log only).
blocked_mods_list() {
  local line
  line=$(grep -h '\[Blocked Mods Dialog\] Mods List' "$log_file" 2>/dev/null | tail -1 || true)
  [ -n "$line" ] || return 0
  printf '%s' "$line" | perl -ne 'print "$1\t$2\t$3\n" while /\{ name: "([^"]*)", websiteUrl: "([^"]*)", hash: "([^"]*)"/g'
}

blocked_mods_error() {
  local mods any=0 name url hash
  mods=$(blocked_mods_list)
  if [ -n "$mods" ]; then
    echo "Prism needs manual CurseForge download(s) before this pack can import." >&2
    while IFS=$(printf '\t') read -r name url hash; do
      [ -n "$name" ] || continue
      any=1
      echo "Blocked mod: $name" >&2
      [ -n "$url" ] && echo "Download: $url" >&2
      [ -n "$hash" ] && echo "Expected SHA-1: $hash" >&2
    done <<EOF
$mods
EOF
  fi
  if [ "$any" -eq 0 ]; then
    echo "Prism is waiting for blocked CurseForge mods. Upload the missing files through Homeshard or place them in $missing_mods_dir, then retry deploy. See $log_file" >&2
    return
  fi
  echo "Download each file, then upload the .jar/.zip through Homeshard (or place it in $missing_mods_dir) and retry deploy." >&2
}

exec 9>"$data_dir/homeshard-import.lock"
flock -w 900 9

if existing=$(candidate_with_mods); then
  echo "already imported: $existing"
  exit 0
fi

echo "importing $pack as $expected" >"$log_file"
prismlauncher -d "$data_dir" -I "$pack" >>"$log_file" 2>&1 &
prism_pid=$!
# Ensure the Prism GUI never leaks as an orphan on the host, regardless of which
# exit path (success, blocked mods, dialog timeout, or error) we take below.
stop_prism() {
  [ -n "${prism_pid:-}" ] || return 0
  kill "$prism_pid" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    kill -0 "$prism_pid" 2>/dev/null || return 0
    sleep 1
  done
  kill -9 "$prism_pid" 2>/dev/null || true
}
trap stop_prism EXIT

clicked=0
for _ in $(seq 1 120); do
  if blocked_mods_window_visible; then
    blocked_mods_error
    exit 73
  fi
  if windows=$(DISPLAY=$display xdotool search --name 'New Instance' 2>/dev/null); then
    for window in $windows; do
      DISPLAY=$display timeout 30 xdotool windowactivate --sync "$window" key Return >>"$log_file" 2>&1 || true
    done
    clicked=1
    break
  fi
  if imported=$(candidate_with_mods); then
    echo "imported: $imported"
    exit 0
  fi
  sleep 1
done

if [ "$clicked" -eq 0 ]; then
  echo "Prism import dialog did not appear; see $log_file" >&2
  exit 71
fi

blocked_mods_seen=0
for _ in $(seq 1 600); do
  if imported=$(candidate_with_mods); then
    echo "imported: $imported"
    exit 0
  fi
  if blocked_mods_window_visible; then
    blocked_mods_seen=$((blocked_mods_seen + 1))
    if [ "$blocked_mods_seen" -ge 15 ]; then
      blocked_mods_error
      exit 73
    fi
  else
    blocked_mods_seen=0
  fi
  sleep 2
done

echo "Prism import timed out waiting for downloaded mods; see $log_file" >&2
exit 72
