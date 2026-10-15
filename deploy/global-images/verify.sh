#!/usr/bin/env bash
# Dry-run check: starts no containers, only checks that the environment is ready.
#
# Usage:
#   ./verify.sh               # full check by default (including the LLM connection pre-check)
#   ./verify.sh --skip-llm    # skip the LLM check (offline, or when you don't want outside requests)
#
# Checks:
#   1. the docker command works
#   2. the .env file exists
#   3. every required setting in .env is filled in (not REPLACE_ME and not empty)
#   4. whether the three images are present locally (missing locally is only a warning)
#   5. whether the target ports are in use
#   6. LLM upstream connections (memory group + proxy group, each checked)
#      - openai protocol: GET {base}/models, uses no tokens
#      - anthropic protocol: POST {base}/v1/messages max_tokens=1, uses ≤ 10 tokens
#      - if the containers are running, also run it once more from inside the container (checks container → LLM reachability)
#
# All pass → exit 0; errors → exit 1; warnings only → exit 0

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

SKIP_LLM=0
for arg in "$@"; do
  case "$arg" in
    --skip-llm) SKIP_LLM=1 ;;
    --help|-h)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) warn "Unknown argument: ${arg} (ignored)" ;;
  esac
done

ERRORS=0
WARNS=0
CURL="${CURL:-/usr/bin/curl}"

# ─── LLM connection check functions ──────────────────────────────────
# check_llm_openai <label> <base_url> <api_key> <model>
#   OpenAI-compatible: GET {base}/models only verifies auth + URL and uses no tokens.
#   base_url may or may not include /v1; it is normalised here.
check_llm_openai() {
  local label="$1" base="$2" key="$3" model="$4"
  # Normalise: strip a trailing /, and a /messages or /chat/completions suffix
  base="${base%/}"
  base="${base%/messages}"
  base="${base%/chat/completions}"
  local url="${base}/models"
  local code body_file=/tmp/llm-check.$$
  code=$("$CURL" -sS --max-time 10 -o "$body_file" -w "%{http_code}" \
    -H "Authorization: Bearer $key" \
    "$url" 2>/dev/null || echo "000")
  if [[ "$code" == "200" ]]; then
    # Check whether the model is in the list (loose match; a miss is only a warning)
    if grep -q "\"$model\"" "$body_file" 2>/dev/null; then
      ok "$label OpenAI-protocol connection OK ($model is in the /models list)"
    else
      ok "$label OpenAI-protocol connection OK (${model} is not listed in /models, but may still work)"
    fi
    rm -f "$body_file"
    return 0
  elif [[ "$code" == "401" || "$code" == "403" ]]; then
    echo "${C_RED}[error]${C_RST} $label API key is invalid (HTTP ${code}): $url" >&2
    head -c 200 "$body_file" >&2; echo >&2
    rm -f "$body_file"
    return 1
  elif [[ "$code" == "404" ]]; then
    # Some providers have no /models endpoint; try the anthropic style or skip: warning, not error
    warn "$label GET /models returned 404 — this provider may not have that endpoint; checking with the anthropic protocol instead"
    check_llm_anthropic "$label" "$base" "$key" "$model"
    rm -f "$body_file"
    return $?
  else
    warn "$label cannot reach ${url} (HTTP=${code}) $(head -c 100 "$body_file" 2>/dev/null)"
    rm -f "$body_file"
    return 1
  fi
}

# check_llm_anthropic <label> <base_url> <api_key> <model>
#   Anthropic: POST {base}/v1/messages with max_tokens=1; uses ≤ 10 tokens but checks URL/auth/model at once.
check_llm_anthropic() {
  local label="$1" base="$2" key="$3" model="$4"
  base="${base%/}"
  # Normalise: use as is if it already ends with /messages; otherwise append /v1/messages
  local url
  if [[ "$base" == */messages ]]; then
    url="$base"
  elif [[ "$base" == */v1 ]]; then
    url="${base}/messages"
  else
    url="${base}/v1/messages"
  fi
  local code body_file=/tmp/llm-check.$$
  code=$("$CURL" -sS --max-time 15 -o "$body_file" -w "%{http_code}" \
    -X POST -H "Content-Type: application/json" \
    -H "x-api-key: $key" \
    -H "Authorization: Bearer $key" \
    -H "anthropic-version: 2023-06-01" \
    -d "{\"model\":\"$model\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" \
    "$url" 2>/dev/null || echo "000")
  case "$code" in
    200)
      ok "$label Anthropic-protocol connection OK (model $model answered)"
      rm -f "$body_file"; return 0 ;;
    401|403)
      echo "${C_RED}[error]${C_RST} $label API key is invalid (HTTP ${code}): $url" >&2
      head -c 200 "$body_file" >&2; echo >&2
      rm -f "$body_file"; return 1 ;;
    404)
      echo "${C_RED}[error]${C_RST} $label URL does not exist (HTTP 404): $url — check BASE_URL" >&2
      rm -f "$body_file"; return 1 ;;
    400)
      # 400 usually means the model name doesn't exist or the body failed validation
      if grep -qE "model.*not.*found|invalid.*model|model_not_found" "$body_file" 2>/dev/null; then
        echo "${C_RED}[error]${C_RST} $label model name '$model' is invalid (HTTP 400)" >&2
        rm -f "$body_file"; return 1
      fi
      warn "$label HTTP 400 (probably a parameter format issue, not a connection error): $(head -c 150 "$body_file")"
      rm -f "$body_file"; return 0 ;;
    *)
      warn "$label cannot reach ${url} (HTTP=${code}) $(head -c 100 "$body_file" 2>/dev/null)"
      rm -f "$body_file"; return 1 ;;
  esac
}

# check_llm_group <label> <base_url> <api_key> <model> <protocol>
check_llm_group() {
  local label="$1" base="$2" key="$3" model="$4" proto="${5:-openai}"
  info "Checking the $label connection (protocol=${proto}, base=${base}, model=${model})..."
  case "$proto" in
    anthropic) check_llm_anthropic "$label" "$base" "$key" "$model" ;;
    *)         check_llm_openai    "$label" "$base" "$key" "$model" ;;
  esac
}

# curl check from inside the container (optional, only when the container is running)
check_llm_from_container() {
  local container="$1" label="$2" base="$3" key="$4" model="$5" proto="${6:-openai}"
  if ! $DOCKER ps --format '{{.Names}}' | grep -qx "$container"; then
    return 0  # container not running: skip (not an error)
  fi
  info "  ↳ trying $label once more from inside container $container..."
  # The point is "network reachability": any HTTP status code counts as reachable; only 000 means unreachable.
  # Auth errors were already reported on the host side, so don't raise them again from the container.
  local url code
  case "$proto" in
    anthropic)
      base="${base%/}"; [[ "$base" == */messages ]] || base="${base}/v1/messages"
      url="$base"
      code=$($DOCKER exec "$container" curl -sS -o /dev/null --max-time 15 \
         -w "%{http_code}" -X POST -H "Content-Type: application/json" \
         -H "x-api-key: $key" -H "anthropic-version: 2023-06-01" \
         -d "{\"model\":\"$model\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" \
         "$url" 2>/dev/null || echo "000")
      ;;
    *)
      base="${base%/}"; base="${base%/v1}"
      url="${base}/v1/models"
      code=$($DOCKER exec "$container" curl -sS -o /dev/null --max-time 10 \
         -w "%{http_code}" -H "Authorization: Bearer $key" "$url" 2>/dev/null || echo "000")
      ;;
  esac
  if [[ "$code" == "000" ]]; then
    warn "  Container ${container} cannot reach ${url} (network isolation / DNS failure)"
    WARNS=$((WARNS+1))
  else
    ok "  Container ${container} → $label is reachable (HTTP ${code})"
  fi
}

# 1. docker
if command -v "$DOCKER" >/dev/null 2>&1 || [[ -x "$DOCKER" ]]; then
  ok "docker works: $DOCKER"
else
  ERRORS=$((ERRORS+1))
  echo "${C_RED}[error]${C_RST} docker is not available" >&2
fi

# 2. .env
if [[ ! -f "$ENV_FILE" ]]; then
  ERRORS=$((ERRORS+1))
  echo "${C_RED}[error]${C_RST} $ENV_FILE does not exist. Run: cp .env.example .env" >&2
else
  ok ".env exists"
  set -a; source "$ENV_FILE"; set +a

  # 3. required settings
  MISSING=()
  for var in \
    MEMORY_CORE_IMAGE MEMORY_HUB_IMAGE PROXY_IMAGE \
    MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT PROXY_PORT \
    MEMORY_CORE_VOLUME PANEL_VOLUME \
    MEMORY_LLM_BASE_URL MEMORY_LLM_API_KEY MEMORY_LLM_MODEL \
    KNOWLEDGE_PUBLIC_BASE_URL \
    PROXY_UPSTREAM_URL PROXY_UPSTREAM_API_KEY PROXY_UPSTREAM_MODEL; do
    val="${!var:-}"
    if [[ -z "$val" || "$val" == "REPLACE_ME" ]]; then
      MISSING+=("$var")
    fi
  done
  if (( ${#MISSING[@]} > 0 )); then
    ERRORS=$((ERRORS+1))
    echo "${C_RED}[error]${C_RST} These required settings are not set: ${MISSING[*]}" >&2
  else
    ok "All required settings are filled in"
  fi

  # 4. whether the images exist locally
  for img_var in MEMORY_CORE_IMAGE MEMORY_HUB_IMAGE PROXY_IMAGE; do
    img="${!img_var:-}"
    if [[ -z "$img" ]]; then continue; fi
    if $DOCKER image inspect "$img" >/dev/null 2>&1; then
      ok "Image present locally: $img"
    else
      WARNS=$((WARNS+1))
      warn "Image not present locally, it will be pulled at startup: $img"
    fi
  done

  # 5. port usage (warning only)
  for port_var in MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT PROXY_PORT; do
    port="${!port_var:-}"
    if [[ -z "$port" ]]; then continue; fi
    if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      WARNS=$((WARNS+1))
      warn "Port $port ($port_var) is in use; free it before starting or change the port in .env"
    else
      ok "Port $port ($port_var) is free"
    fi
  done

  # 6. LLM connections (checked by default, --skip-llm skips)
  if (( SKIP_LLM == 1 )); then
    info "Skipping the LLM connection check (--skip-llm)"
  elif (( ${#MISSING[@]} > 0 )); then
    warn "Skipping the LLM connection check (required settings are incomplete)"
  else
    echo ""
    info "═══ LLM connection check ══════════════════════════════════"

    # memory group
    if ! check_llm_group "memory LLM" "$MEMORY_LLM_BASE_URL" "$MEMORY_LLM_API_KEY" \
         "$MEMORY_LLM_MODEL" "${MEMORY_LLM_PROTOCOL:-openai}"; then
      ERRORS=$((ERRORS+1))
    fi
    # if the container is running, check from inside it too
    check_llm_from_container wamf-memory-hub "memory LLM (from container)" \
      "$MEMORY_LLM_BASE_URL" "$MEMORY_LLM_API_KEY" "$MEMORY_LLM_MODEL" \
      "${MEMORY_LLM_PROTOCOL:-openai}"

    # proxy group (if it's identical to the memory group, the user entered the same settings; check once)
    if [[ "$PROXY_UPSTREAM_URL" == "$MEMORY_LLM_BASE_URL" && \
          "$PROXY_UPSTREAM_API_KEY" == "$MEMORY_LLM_API_KEY" && \
          "$PROXY_UPSTREAM_MODEL" == "$MEMORY_LLM_MODEL" ]]; then
      ok "The proxy LLM is identical to the memory LLM; skipping a second check"
    else
      # the proxy group uses the openai protocol by default (same as config.yaml)
      if ! check_llm_group "proxy LLM" "$PROXY_UPSTREAM_URL" "$PROXY_UPSTREAM_API_KEY" \
           "$PROXY_UPSTREAM_MODEL" openai; then
        ERRORS=$((ERRORS+1))
      fi
      check_llm_from_container wamf-proxy "proxy LLM (from container)" \
        "$PROXY_UPSTREAM_URL" "$PROXY_UPSTREAM_API_KEY" "$PROXY_UPSTREAM_MODEL" openai
    fi
  fi
fi

echo ""
if (( ERRORS > 0 )); then
  echo "${C_RED}✗ ${ERRORS} errors, ${WARNS} warnings — cannot start${C_RST}" >&2
  exit 1
elif (( WARNS > 0 )); then
  echo "${C_YLW}⚠ ${WARNS} warnings — you can start, but check the notes above${C_RST}"
  exit 0
else
  echo "${C_GRN}✓ All checks passed — you can run ./start-all.sh${C_RST}"
  exit 0
fi
