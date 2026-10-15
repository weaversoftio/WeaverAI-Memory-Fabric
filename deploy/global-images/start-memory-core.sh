#!/usr/bin/env bash
# Start memory-core on its own (the kernel gateway, port 8420). On first start it runs init-admin automatically
# and saves the generated user_key to .admin-key for the proxy / Claude Code.
#
# Usage:
#   ./start-memory-core.sh
#
# Data is persisted in a named volume (default wamf-memory-core-data; change MEMORY_CORE_VOLUME in .env).
# Rerunning removes the old container before starting a new one; the volume data is kept — and so is the admin user_key.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

load_env
require_vars MEMORY_CORE_IMAGE MEMORY_CORE_PORT MEMORY_CORE_VOLUME

# ── Gateway internal admin credential ─────────────────────────────────
# Uses ${VAR-default} (not :-default) so .env can explicitly set it to an empty string to turn the Bearer gate off.
#
# memory-core's Bearer gate is currently **known to be incompatible** with proxy auth: the proxy calls
# /v3/meta/auth/verify without a Bearer (an omission in the source, see MemoryProxy/src/auth.ts),
# so MEMORY_CORE_GATEWAY_API_KEY must stay empty when the proxy has auth on. It is empty by default.
MEMORY_CORE_GATEWAY_API_KEY="${MEMORY_CORE_GATEWAY_API_KEY-}"
MEMORY_CORE_ADMIN_USERNAME="${MEMORY_CORE_ADMIN_USERNAME:-admin}"

# Where the admin user_key is stored (on the host; delete this file too when the volume data is wiped)
ADMIN_KEY_FILE="${MEMORY_CORE_ADMIN_KEY_FILE:-$SCRIPT_DIR/.admin-key}"

if [[ -n "$MEMORY_CORE_GATEWAY_API_KEY" ]]; then
  warn "MEMORY_CORE_GATEWAY_API_KEY is not empty — the proxy's sessionInit/auth currently fails because it sends no Bearer."
  warn "For local use, leave MEMORY_CORE_GATEWAY_API_KEY empty in .env."
fi

CONTAINER=wamf-memory-core
NETWORK=wamf-memory-stack

# Create the shared network (idempotent)
if ! $DOCKER network inspect "$NETWORK" >/dev/null 2>&1; then
  info "Creating docker network $NETWORK"
  $DOCKER network create "$NETWORK" >/dev/null
fi

# ── Storage backend: sqlite (default) / mongodb ─────────────────────────────
# With MEMORY_CORE_STORE_MODE=mongodb the data plane uses MongoDB (L0/L1/profile/skill +
# mongot native BM25). Requires Mongo 7.0+ with mongot — core probes it on first connect and
# fails init without mongot (full-text search is mandatory, no silent fallback).
#   MONGODB_ENDPOINT set     → use an external Mongo (Atlas or a self-hosted replica set with mongot)
#   MONGODB_ENDPOINT not set → start a mongodb-atlas-local container on the same network
#                             (mongod + mongot in one, data persisted in the mongo-local-* volumes)
#
# Metadata backend (meta_* teams/users/agents/tasks/ACL):
#   MEMORY_CORE_METADATA_BACKEND=auto (default, follows STORE_MODE) / sqlite / mongodb
#   with mongodb it reuses the same Mongo by default (WAMF_METADATA_MONGO_URI can override it);
#   metadata uses multi-document transactions, so the target must be a replica set (single-node atlas-local RS is fine).
MEMORY_CORE_STORE_MODE="${MEMORY_CORE_STORE_MODE:-sqlite}"
MEMORY_CORE_METADATA_BACKEND="${MEMORY_CORE_METADATA_BACKEND:-auto}"
MONGODB_DATABASE="${MONGODB_DATABASE:-wamf_memory}"
MONGO_LOCAL_CONTAINER="${MONGO_LOCAL_CONTAINER:-wamf-mongo-local}"
MONGO_LOCAL_IMAGE="${MONGO_LOCAL_IMAGE:-mongodb/mongodb-atlas-local:8.3}"
MONGO_ENV_ARGS=()

if [[ "$MEMORY_CORE_METADATA_BACKEND" == "auto" ]]; then
  if [[ "$MEMORY_CORE_STORE_MODE" == "mongodb" ]]; then
    MEMORY_CORE_METADATA_BACKEND="mongodb"
  else
    MEMORY_CORE_METADATA_BACKEND="sqlite"
  fi
fi

if [[ "$MEMORY_CORE_STORE_MODE" == "mongodb" || "$MEMORY_CORE_METADATA_BACKEND" == "mongodb" ]]; then
  if [[ -z "${MONGODB_ENDPOINT:-}" ]]; then
    info "MONGODB_ENDPOINT not set → starting a local atlas-local ($MONGO_LOCAL_IMAGE)"
    if ! $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "$MONGO_LOCAL_CONTAINER"; then
      rm_container_if_exists "$MONGO_LOCAL_CONTAINER"
      # --hostname must be fixed: atlas-local initialises the single-node RS member from the container hostname.
      # If it isn't fixed, recreating the container → hostname changes → the old member name in the RS config no longer matches → no primary ever
      # (not primary / ReplicaSetNoPrimary), and the only fix is wiping the volume.
      $DOCKER run -d --name "$MONGO_LOCAL_CONTAINER" \
        --hostname mongo-search \
        --network "$NETWORK" \
        --network-alias mongo-search \
        -v mongo-local-db:/data/db \
        -v mongo-local-configdb:/data/configdb \
        -v mongo-local-mongot:/data/mongot \
        "$MONGO_LOCAL_IMAGE" >/dev/null
    fi
    info "Waiting for mongo to be ready..."
    mongo_ready=0
    for _ in $(seq 1 30); do
      # ping succeeds even when the RS has no primary — wait for isWritablePrimary,
      # otherwise core starts before the RS election finishes and every ensureIndex/transaction at startup fails.
      if $DOCKER exec "$MONGO_LOCAL_CONTAINER" mongosh --quiet --eval \
          'if (db.adminCommand("hello").isWritablePrimary === true) quit(0); else quit(1)' >/dev/null 2>&1; then
        mongo_ready=1; break
      fi
      sleep 2
    done
    [[ "$mongo_ready" == "1" ]] || die "The mongo container was not ready within 60s; check docker logs $MONGO_LOCAL_CONTAINER"
    ok "mongo is ready (container $MONGO_LOCAL_CONTAINER, network alias mongo-search)"
    MONGODB_ENDPOINT="mongodb://mongo-search:27017/?directConnection=true"
  fi
fi

if [[ "$MEMORY_CORE_STORE_MODE" == "mongodb" ]]; then
  MONGO_ENV_ARGS+=( -e "MONGODB_ENDPOINT=$MONGODB_ENDPOINT" -e "MONGODB_DATABASE=$MONGODB_DATABASE" )
  info "memory-core data plane backend = mongodb (endpoint=$MONGODB_ENDPOINT, db=$MONGODB_DATABASE)"
fi

if [[ "$MEMORY_CORE_METADATA_BACKEND" == "mongodb" ]]; then
  # Metadata shares the data plane's Mongo instance by default (separate databases: {prefix}_{instance_id}, default prefix wamf_metadata).
  # Note: the metadata client is created separately, outside the shared pool, and doesn't inherit the data plane's w:1 (transaction durability relies on the server default, majority).
  WAMF_METADATA_MONGO_URI="${WAMF_METADATA_MONGO_URI:-$MONGODB_ENDPOINT}"
  MONGO_ENV_ARGS+=( -e "WAMF_METADATA_MONGO_URI=$WAMF_METADATA_MONGO_URI" )
  info "memory-core metadata backend = mongodb (uri=$WAMF_METADATA_MONGO_URI, database wamf_metadata_<instance>)"
else
  info "memory-core metadata backend = sqlite (inside the container volume)"
fi

pull_image "$MEMORY_CORE_IMAGE"
rm_container_if_exists "$CONTAINER"

# ── Generate the gateway config.yaml, mounted at /data/config/wamf-gateway.yaml in the container ──
# The default image has no config, so memory-core uses its compiled defaults (skill / knowledge modules off).
# Generate a minimal standalone + skill config from MEMORY_LLM_* in .env.
CORE_CONFIG_DIR="${MEMORY_CORE_CONFIG_DIR:-$SCRIPT_DIR/.memory-core-config}"
mkdir -p "$CORE_CONFIG_DIR"
CORE_CONFIG_FILE="$CORE_CONFIG_DIR/wamf-gateway.yaml"
info "Generating gateway config → $CORE_CONFIG_FILE"
cat > "$CORE_CONFIG_FILE" <<YAML
# Generated automatically by start-memory-core.sh — overwritten on every start, don't edit by hand.
deployMode: standalone
stateBackend: local

server:
  port: 8420
  host: 0.0.0.0

data:
  baseDir: /data/wamf-memory

llm:
  baseUrl: "${MEMORY_LLM_BASE_URL:-}"
  apiKey: "${MEMORY_LLM_API_KEY:-}"
  model: "${MEMORY_LLM_MODEL:-}"
  maxTokens: 32000
  timeoutMs: 300000

memory:
  # promptMode: code (default; engineering/code work — extracts team-shared memories: project facts/tasks/decisions/SOPs/taboos)
  #           | chat (general chat / teaching — extracts personal persona/episodic/instruction memories)
  # Override with MEMORY_PROMPT_MODE in .env.
  # Note: in code mode, pure small talk may extract 0 memories (the LLM finds no engineering content worth keeping).
  promptMode: ${MEMORY_PROMPT_MODE:-code}
  capture: { enabled: true }
  extraction:
    enabled: true
    enableDedup: true
    maxMemoriesPerSession: 20
  persona:
    triggerEveryN: 50
    maxScenes: 15
  pipeline:
    everyNConversations: 5
    enableWarmup: true
    l1IdleTimeoutSeconds: 600
    l2DelayAfterL1Seconds: 90
    l2MinIntervalSeconds: 900
    l2MaxIntervalSeconds: 3600
  recall:
    enabled: true
    maxResults: 5
    scoreThreshold: 0.3
    strategy: hybrid
    timeoutMs: 5000
  # In gateway form the storage backend is actually decided by the STORE_MODE env var (see docker run -e STORE_MODE);
  # the same value is kept here only for readability; only the plugin/SDK form reads this field.
  storeBackend: ${MEMORY_CORE_STORE_MODE}
  embedding:
    provider: none

# ── Skill module ──
skill:
  enabled: true
  routing:
    mode: bm25
    searchTopK: 20
  extraction:
    enabled: true
    maxIterations: 16
    queue:
      backend: local
      keyPrefix: wamf
      resultTtlSeconds: 86400
      lockTtlMs: 600000
      maxRetries: 2
      retryBackoffsMs: [5000, 15000]
  resources:
    maxResourceSizeBytes: 5000000
YAML

info "Starting memory-core (image=$MEMORY_CORE_IMAGE, port=$MEMORY_CORE_PORT)"
$DOCKER run -d --name "$CONTAINER" \
  --network "$NETWORK" \
  --network-alias memory-core \
  -p "127.0.0.1:${MEMORY_CORE_PORT}:8420" \
  -v "${MEMORY_CORE_VOLUME}:/data/wamf-memory" \
  -v "$CORE_CONFIG_FILE:/data/config/wamf-gateway.yaml:ro" \
  -e WAMF_GATEWAY_PORT=8420 \
  -e WAMF_GATEWAY_HOST=0.0.0.0 \
  -e WAMF_GATEWAY_API_KEY="$MEMORY_CORE_GATEWAY_API_KEY" \
  -e WAMF_DATA_DIR=/data/wamf-memory \
  -e STORE_MODE="$MEMORY_CORE_STORE_MODE" \
  ${MONGO_ENV_ARGS[@]+"${MONGO_ENV_ARGS[@]}"} \
  "$MEMORY_CORE_IMAGE" >/dev/null

wait_healthy "$CONTAINER" 90
ok "memory-core started → http://localhost:${MEMORY_CORE_PORT}/"

# ── Admin user lifecycle ─────────────────────────────────────────
# First start: init-admin **with the random user_key we generate**, read back from the response and saved to a file.
# Restart, already initialised (409): prefer .admin-key; if the volume is new but .admin-key is
#   old, it can't be recovered (volume and key must match; tell the user to clean up).
#
# The init-admin API honours the user_key passed in (see MemoryCore/src/metadata/store/sqlite-adapter.ts
# defaultKeyValue = input.default_key_value ?? generateUserKey()); as long as the volume is empty and
# we pass a fixed key, we get the key we chose. On first start the script generates a random 32-byte
# base32url key — independent per machine and per purge, so no collisions.

generate_user_key() {
  # sk-mem-<32 chars A-Za-z0-9>, the same format as metadata/utils/user-key.ts
  # uses openssl (portable; tr filters +/= out of the base64 down to 32 characters)
  local raw
  if command -v openssl >/dev/null 2>&1; then
    raw=$(openssl rand -base64 48 | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 32)
  else
    # fallback: read enough urandom so at least 32 remain after filtering
    raw=$(head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 32)
  fi
  echo "sk-mem-${raw}"
}

verify_user_key() {
  local key="$1"
  local code
  code=$("$CURL" -sS -o /dev/null -w "%{http_code}" --max-time 5 \
    -X POST -H "Content-Type: application/json" \
    -H "x-wamf-service-id: default" \
    ${MEMORY_CORE_GATEWAY_API_KEY:+-H "Authorization: Bearer ${MEMORY_CORE_GATEWAY_API_KEY}"} \
    "http://localhost:${MEMORY_CORE_PORT}/v3/meta/auth/verify" \
    -d "$(printf '{"user_key":"%s"}' "$key")" 2>/dev/null || echo "000")
  [[ "$code" == "200" ]]
}

info "Initialising admin user (username=${MEMORY_CORE_ADMIN_USERNAME}, key saved to → ${ADMIN_KEY_FILE})..."

# Generate a random key (for the first init-admin; reuse the file if one exists)
if [[ -s "$ADMIN_KEY_FILE" ]]; then
  ADMIN_KEY=$(cat "$ADMIN_KEY_FILE")
  info "  Reusing the saved admin key (.admin-key exists)"
else
  ADMIN_KEY=$(generate_user_key)
fi

init_body=$(printf '{"username":"%s","user_key":"%s"}' \
  "$MEMORY_CORE_ADMIN_USERNAME" "$ADMIN_KEY")
init_resp=$("$CURL" -sS -o /tmp/init-admin.$$ -w "%{http_code}" \
  -X POST -H "Content-Type: application/json" \
  ${MEMORY_CORE_GATEWAY_API_KEY:+-H "Authorization: Bearer ${MEMORY_CORE_GATEWAY_API_KEY}"} \
  -H "x-wamf-service-id: default" \
  "http://localhost:${MEMORY_CORE_PORT}/v3/internal/meta/user/init-admin" \
  -d "$init_body" 2>/dev/null || echo "000")

case "$init_resp" in
  200)
    ok "admin user created"
    # save the key (and tighten the host file's permissions)
    umask 077
    echo -n "$ADMIN_KEY" > "$ADMIN_KEY_FILE"
    ok "  admin user_key saved to $ADMIN_KEY_FILE"
    ;;
  409)
    if [[ -s "$ADMIN_KEY_FILE" ]]; then
      ok "admin user already exists (skipping init-admin, using the key in $ADMIN_KEY_FILE)"
    else
      warn "admin user already exists, but $ADMIN_KEY_FILE is missing, so the user_key cannot be recovered."
      warn "Option A: wipe the volume and recreate — ./stop-all.sh --purge && ./start-memory-core.sh"
      warn "Option B: create a new admin user_key by hand (needs the old key or the gateway apiKey)"
    fi
    ;;
  *)
    warn "init-admin returned HTTP=${init_resp}; may need manual investigation:"
    cat /tmp/init-admin.$$ 2>/dev/null || true; echo
    ;;
esac
rm -f /tmp/init-admin.$$

# ── Verify the admin key works ─────────────────────────────────────
if [[ -s "$ADMIN_KEY_FILE" ]]; then
  ADMIN_KEY=$(cat "$ADMIN_KEY_FILE")
  if verify_user_key "$ADMIN_KEY"; then
    # Only print a masked value at the end, so the full key doesn't end up in terminal history
    masked="${ADMIN_KEY:0:11}****${ADMIN_KEY: -4}"
    ok "admin user_key verified (auth/verify 200) — $masked"
    ok "  key file: $ADMIN_KEY_FILE"
  else
    warn "admin user_key verification failed (auth/verify not 200). Check that $ADMIN_KEY_FILE matches the volume."
  fi
fi
