#!/usr/bin/env bash
# Stop and remove the three containers.
#
# Usage:
#   ./stop-all.sh              # stop the containers, keep the volumes (data is kept)
#   ./stop-all.sh --purge      # stop the containers + delete the volumes + delete the network (full cleanup)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

PURGE=0
if [[ "${1:-}" == "--purge" ]]; then
  PURGE=1
fi

# Also allowed without .env (falls back to the default volume names)
if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi
MEMORY_CORE_VOLUME="${MEMORY_CORE_VOLUME:-wamf-memory-core-data}"
PANEL_VOLUME="${PANEL_VOLUME:-wamf-panel-data}"
MONGO_LOCAL_CONTAINER="${MONGO_LOCAL_CONTAINER:-wamf-mongo-local}"

for c in wamf-proxy wamf-memory-hub wamf-memory-core "$MONGO_LOCAL_CONTAINER"; do
  if $DOCKER ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
    info "Stopping and removing $c"
    $DOCKER rm -f "$c" >/dev/null
  else
    info "$c is not running, skipping"
  fi
done

if (( PURGE == 1 )); then
  warn "--purge is on: deleting volumes + network + the admin key file"
  for v in "$MEMORY_CORE_VOLUME" "$PANEL_VOLUME" mongo-local-db mongo-local-configdb mongo-local-mongot; do
    if $DOCKER volume inspect "$v" >/dev/null 2>&1; then
      $DOCKER volume rm "$v" >/dev/null && ok "Deleted volume $v" || warn "Failed to delete volume $v"
    fi
  done
  if $DOCKER network inspect wamf-memory-stack >/dev/null 2>&1; then
    $DOCKER network rm wamf-memory-stack >/dev/null && ok "Deleted network wamf-memory-stack" || true
  fi
  # The admin key is tied to the volume: purging the volume must also remove the key, otherwise the next start reads
  # the old key against a fresh volume and auth fails.
  ADMIN_KEY_FILE="${MEMORY_CORE_ADMIN_KEY_FILE:-$SCRIPT_DIR/.admin-key}"
  if [[ -f "$ADMIN_KEY_FILE" ]]; then
    rm -f "$ADMIN_KEY_FILE" && ok "Deleted the admin key file $ADMIN_KEY_FILE"
  fi
  # Also clean up the config generated for proxy / memory-core
  PROXY_CFG_DIR="${PROXY_CONFIG_DIR:-$SCRIPT_DIR/.proxy-config}"
  if [[ -d "$PROXY_CFG_DIR" ]]; then
    rm -rf "$PROXY_CFG_DIR" && ok "Deleted the proxy config directory $PROXY_CFG_DIR"
  fi
  CORE_CFG_DIR="${MEMORY_CORE_CONFIG_DIR:-$SCRIPT_DIR/.memory-core-config}"
  if [[ -d "$CORE_CFG_DIR" ]]; then
    rm -rf "$CORE_CFG_DIR" && ok "Deleted the memory-core config directory $CORE_CFG_DIR"
  fi
fi

ok "Done."
