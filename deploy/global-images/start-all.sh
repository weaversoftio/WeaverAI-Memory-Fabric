#!/usr/bin/env bash
# Start memory → memory-hub → proxy in one go (interactive).
#
# Order: start memory (core) and wait for healthy; then memory-hub (panel + knowledge) and wait for healthy;
# then the proxy. Any failing step aborts and prints that container's logs.
#
# Usage:
#   ./start-all.sh            # interactively set up the LLM (Enter keeps the current value), check the connection, then start
#   PULL=1 ./start-all.sh     # docker pull the three images first, upgrading to the latest
#
# Interactive flow:
#   - copies .env.example to .env if .env doesn't exist
#   - every run confirms the memory and proxy LLM settings interactively (existing values are the defaults; Enter keeps them)
#   - checks the LLM connection right after; if it fails you're asked again, until it passes or you give up
#   - finally writes the values back to .env, so the next run reuses them

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# Copy the template if .env doesn't exist (the interactive flow then fills in the LLM)
if [[ ! -f "$ENV_FILE" ]]; then
  info ".env does not exist; copying .env.example"
  cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
fi

load_env

# Confirm both LLM groups interactively + connection check + write back to .env
interactive_llm_setup

# Validate every required setting at once, so a missing proxy setting isn't discovered only after memory is up
require_vars \
  MEMORY_CORE_IMAGE MEMORY_HUB_IMAGE PROXY_IMAGE \
  MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT PROXY_PORT \
  MEMORY_CORE_VOLUME PANEL_VOLUME \
  MEMORY_LLM_BASE_URL MEMORY_LLM_API_KEY MEMORY_LLM_MODEL \
  KNOWLEDGE_PUBLIC_BASE_URL \
  PROXY_UPSTREAM_URL PROXY_UPSTREAM_API_KEY PROXY_UPSTREAM_MODEL

# Port pre-check: check the 4 target ports at once and stop if an outside process holds one,
# so a hub/proxy port conflict isn't discovered only after memory is up. (Our own old wamf containers are excluded.)
check_ports

info "═══ Step 1/3: memory ═══════════════════════════════════════"
"$SCRIPT_DIR/start-memory-core.sh"

info "═══ Step 2/3: memory-hub ═══════════════════════════════════"
"$SCRIPT_DIR/start-memory-hub.sh"

info "═══ Step 3/3: proxy ════════════════════════════════════════"
# The full pipeline is on by default (auth + sessionInit + wamf injection).
# Set PROXY_FULL_STACK=0 to turn it off, or override the three switches separately in .env.
PROXY_FULL_STACK="${PROXY_FULL_STACK:-1}" "$SCRIPT_DIR/start-proxy.sh"

ok "═══ All services are ready ═════════════════════════════════"
print_endpoints

# Print the commands for using Claude Code / the proxy
ADMIN_KEY_FILE="${MEMORY_CORE_ADMIN_KEY_FILE:-$SCRIPT_DIR/.admin-key}"
if [[ -s "$ADMIN_KEY_FILE" ]]; then
  ADMIN_KEY=$(cat "$ADMIN_KEY_FILE")
  UPSTREAM_MODEL="${PROXY_UPSTREAM_MODEL:-<your-model>}"
  echo ""
  echo "  ┌─ Use Claude Code through the proxy ─────────────────────────────┐"
  echo "  │  export ANTHROPIC_BASE_URL=http://127.0.0.1:${PROXY_PORT}/claude-code/default"
  echo "  │  export ANTHROPIC_AUTH_TOKEN='${ADMIN_KEY}'"
  echo "  │  claude --model ${UPSTREAM_MODEL}"
  echo "  │"
  echo "  │  admin user_key is saved in: $ADMIN_KEY_FILE"
  echo "  └────────────────────────────────────────────────────────────────┘"
fi
echo ""
echo "  View logs:      docker logs -f wamf-memory-core | wamf-memory-hub | wamf-proxy"
echo "  Stop services:  ./stop-all.sh"
echo ""
