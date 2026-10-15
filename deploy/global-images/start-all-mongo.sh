#!/usr/bin/env bash
# Start the three services in **MongoDB mode** in one go (memory-core + memory-hub + proxy).
# Experimental: off by default; the default entry point is still ./start-all.sh (sqlite).
#
# How it relates to start-all.sh:
#   - start-all.sh is unchanged — sqlite by default, data in the container volume;
#   - this script reuses the same flow, forcing MEMORY_CORE_STORE_MODE=mongodb and writing it to .env:
#       · the data plane (L0/L1 memories, profile, skill) uses MongoDB + mongot native BM25;
#       · metadata (meta_* teams/users/agents/tasks) follows into the same Mongo by default
#         (MEMORY_CORE_METADATA_BACKEND=auto);
#       · when .env has no MONGODB_ENDPOINT, a local mongodb-atlas-local container is started
#         on the same network (mongod + mongot in one, persisted in the mongo-local-* volumes).
#
# Usage (same as start-all.sh):
#   ./start-all-mongo.sh            # interactive LLM setup, then start
#   PULL=1 ./start-all-mongo.sh     # docker pull to upgrade the images first
#
# To go back to sqlite: comment out MEMORY_CORE_STORE_MODE in .env or set it to sqlite, then ./start-all.sh.
# Switching backends doesn't migrate existing data.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# Copy the template first if .env doesn't exist, so STORE_MODE can be written to it.
if [[ ! -f "$ENV_FILE" ]]; then
  info ".env does not exist; copying .env.example"
  cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
fi

# Conflict check: if .env **explicitly** sets a non-mongodb MEMORY_CORE_STORE_MODE,
# sourcing .env in start-all.sh would override the export below and silently run another mode — stop that early.
# (The line is commented out in .env.example, so standard users don't hit this.)
env_mode=$(grep -E '^[[:space:]]*MEMORY_CORE_STORE_MODE=' "$ENV_FILE" \
  | tail -n1 | cut -d= -f2- | tr -d '[:space:]"' || true)
if [[ -n "$env_mode" && "$env_mode" != "mongodb" ]]; then
  echo "[error] .env explicitly sets MEMORY_CORE_STORE_MODE=$env_mode, which conflicts with this script." >&2
  echo "        Choose one:" >&2
  echo "          ① to use mongo: comment out that line in .env and rerun this script;" >&2
  echo "          ② to use $env_mode: just run ./start-all.sh." >&2
  exit 1
fi

set_env_value MEMORY_CORE_STORE_MODE mongodb "$ENV_FILE"
export MEMORY_CORE_STORE_MODE=mongodb
echo "[start-all-mongo] Wrote MEMORY_CORE_STORE_MODE=mongodb to .env (data plane + metadata both use MongoDB by default)"

exec "$SCRIPT_DIR/start-all.sh" "$@"
