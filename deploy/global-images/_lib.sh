#!/usr/bin/env bash
# Shared helpers: load .env, validate required settings, wait for container health, clean up old containers.
# Sourced by the start-*.sh scripts via `source _lib.sh`; not run on its own.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"

# Colours
if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YLW=$'\033[33m'; C_BLU=$'\033[34m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YLW=""; C_BLU=""; C_RST=""
fi

info() { echo "${C_BLU}[$(date +%H:%M:%S)]${C_RST} $*"; }
ok()   { echo "${C_GRN}[ok]${C_RST} $*"; }
warn() { echo "${C_YLW}[warn]${C_RST} $*" >&2; }
die()  { echo "${C_RED}[error]${C_RST} $*" >&2; exit 1; }

# Load .env (with a hint when it doesn't exist yet)
load_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    die ".env does not exist. Run cp .env.example .env first and fill in the LLM settings."
  fi
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
}

# Validate a set of required variables; refuse to start if any is missing, listing all of them at once
require_vars() {
  local missing=()
  for var in "$@"; do
    local val="${!var:-}"
    if [[ -z "$val" || "$val" == "REPLACE_ME" ]]; then
      missing+=("$var")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    echo "${C_RED}[error]${C_RST} These required settings in .env are not set or still REPLACE_ME:" >&2
    for v in "${missing[@]}"; do echo "  - $v" >&2; done
    echo "" >&2
    echo "  Edit $ENV_FILE and try again." >&2
    exit 1
  fi
}

# Find a usable docker command (also works with a standalone Homebrew install + colima)
# Order: docker on PATH → Homebrew Apple silicon → Homebrew Intel → /usr/local
# Homebrew Cellar paths are globbed by version and the newest is used (sort -V), to avoid hard-coding a version.
find_docker() {
  if command -v docker >/dev/null 2>&1; then
    echo "docker"
    return
  fi
  local candidate
  for prefix in /opt/homebrew/Cellar/docker /usr/local/Cellar/docker; do
    if [[ -d "$prefix" ]]; then
      candidate=$(ls -1 "$prefix" 2>/dev/null | sort -V | tail -n1)
      if [[ -n "$candidate" && -x "$prefix/$candidate/bin/docker" ]]; then
        echo "$prefix/$candidate/bin/docker"
        return
      fi
    fi
  done
  for path in /opt/homebrew/bin/docker /usr/local/bin/docker; do
    if [[ -x "$path" ]]; then
      echo "$path"
      return
    fi
  done
  die "docker command not found. Install Docker Desktop / OrbStack / colima + the docker CLI first."
}

DOCKER="$(find_docker)"

# Git Bash / MSYS (Windows) rewrites `-v /c/...:/data/...` into a Windows path list,
# which breaks bind mounts (the container can't see the generated config). Turn path
# conversion off for docker only; curl and others still need it to understand /tmp, /dev/null.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    _DOCKER_BIN="$DOCKER"
    _docker_nopathconv() { MSYS_NO_PATHCONV=1 "$_DOCKER_BIN" "$@"; }
    DOCKER=_docker_nopathconv
    ;;
esac

# With PULL=1, pull the latest version of an image.
# Off by default: docker run pulls a missing image by itself, but reuses a local image of the
# same name and tag without noticing remote updates — pass PULL=1 to upgrade to the latest.
pull_image() {
  local image="$1"
  [[ "${PULL:-0}" == "1" ]] || return 0
  info "Pulling image $image"
  $DOCKER pull "$image" || die "Failed to pull $image."
}

# Remove a container with the same name, if any (idempotent)
rm_container_if_exists() {
  local name="$1"
  if $DOCKER ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$name"; then
    info "Removing existing container $name"
    $DOCKER rm -f "$name" >/dev/null
  fi
}

# Wait until a container is healthy (or running, if it has no healthcheck)
wait_healthy() {
  local name="$1"
  local timeout="${2:-90}"    # seconds
  local waited=0
  info "Waiting for $name to be ready (up to ${timeout}s)..."
  while (( waited < timeout )); do
    local status health
    status="$($DOCKER inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo "missing")"
    health="$($DOCKER inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null || echo "unknown")"

    if [[ "$status" != "running" ]]; then
      warn "${name} is ${status}; recent logs:"
      $DOCKER logs --tail 30 "$name" 2>&1 || true
      die "${name} is not running."
    fi

    case "$health" in
      healthy) ok "$name healthy"; return 0 ;;
      unhealthy)
        warn "${name} is unhealthy; logs:"
        $DOCKER logs --tail 30 "$name" 2>&1 || true
        die "${name} failed its health check."
        ;;
      none)
        # The image has no healthcheck: treat running as ready
        ok "${name} running (no healthcheck)"
        return 0
        ;;
    esac
    sleep 2
    waited=$((waited + 2))
  done
  warn "Timed out waiting for ${name}; last logs:"
  $DOCKER logs --tail 30 "$name" 2>&1 || true
  die "${name} was not ready within ${timeout}s."
}

# Print the service address table
print_endpoints() {
  echo ""
  echo "  ┌─────────────────────────────────────────────────────────┐"
  echo "  │ Service addresses                                       │"
  echo "  ├─────────────────────────────────────────────────────────┤"
  printf "  │ Panel UI       http://localhost:%-24s│\n" "${PANEL_PORT}/"
  printf "  │ Panel API      http://localhost:%-24s│\n" "${PANEL_PORT}/api/v1/"
  printf "  │ Knowledge API  http://localhost:%-24s│\n" "${KNOWLEDGE_PORT}/v3/"
  printf "  │ Knowledge Docs http://localhost:%-24s│\n" "${KNOWLEDGE_PORT}/docs"
  printf "  │ Memory Core    http://localhost:%-24s│\n" "${MEMORY_CORE_PORT}/"
  printf "  │ Proxy          http://localhost:%-24s│\n" "${PROXY_PORT}/"
  echo "  └─────────────────────────────────────────────────────────┘"
}

# ═══════════════════════════════════════════════════════════════
# LLM connectivity checks (same logic as verify.sh; reused by the interactive start-all.sh)
# ═══════════════════════════════════════════════════════════════

CURL="${CURL:-/usr/bin/curl}"
if [[ ! -x "$CURL" ]]; then
  if command -v curl >/dev/null 2>&1; then
    CURL="$(command -v curl)"
  else
    CURL="curl"
  fi
fi

# check_llm_openai <label> <base_url> <api_key> <model>
#   OpenAI-compatible: GET {base}/models only verifies auth + URL and uses no tokens. Returns 0 pass / 1 fail.
check_llm_openai() {
  local label="$1" base="$2" key="$3" model="$4"
  base="${base%/}"
  base="${base%/messages}"
  base="${base%/chat/completions}"
  local url="${base}/models"
  local code body_file=/tmp/llm-check.$$
  code=$("$CURL" -sS --max-time 10 -o "$body_file" -w "%{http_code}" \
    -H "Authorization: Bearer $key" "$url" 2>/dev/null || echo "000")
  local rc=0
  if [[ "$code" == "200" ]]; then
    if grep -q "\"$model\"" "$body_file" 2>/dev/null; then
      ok "$label OpenAI-protocol connection OK ($model is in the /models list)"
    else
      ok "$label OpenAI-protocol connection OK ($model is not listed in /models, but may still work)"
    fi
  elif [[ "$code" == "401" || "$code" == "403" ]]; then
    warn "$label API key is invalid (HTTP ${code}): $url"
    head -c 200 "$body_file" >&2; echo >&2
    rc=1
  elif [[ "$code" == "404" ]]; then
    warn "$label GET /models returned 404 — this provider may not have that endpoint; checking with the anthropic protocol instead"
    rm -f "$body_file"
    check_llm_anthropic "$label" "$base" "$key" "$model"
    return $?
  else
    warn "$label cannot reach ${url} (HTTP=${code}) $(head -c 100 "$body_file" 2>/dev/null)"
    rc=1
  fi
  rm -f "$body_file"
  return $rc
}

# check_llm_anthropic <label> <base_url> <api_key> <model>
#   Anthropic: POST {base}/v1/messages with max_tokens=1, using ≤ 10 tokens. Returns 0/1.
check_llm_anthropic() {
  local label="$1" base="$2" key="$3" model="$4"
  base="${base%/}"
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
    -H "x-api-key: $key" -H "Authorization: Bearer $key" \
    -H "anthropic-version: 2023-06-01" \
    -d "{\"model\":\"$model\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" \
    "$url" 2>/dev/null || echo "000")
  local rc=0
  case "$code" in
    200) ok "$label Anthropic-protocol connection OK (model $model answered)" ;;
    401|403)
      warn "$label API key is invalid (HTTP ${code}): $url"
      head -c 200 "$body_file" >&2; echo >&2
      rc=1 ;;
    404)
      warn "$label URL does not exist (HTTP 404): $url — check BASE_URL"
      rc=1 ;;
    400)
      if grep -qE "model.*not.*found|invalid.*model|model_not_found" "$body_file" 2>/dev/null; then
        warn "$label model name '$model' is invalid (HTTP 400)"
        rc=1
      else
        warn "$label HTTP 400 (probably a parameter format issue, not a connection error): $(head -c 150 "$body_file")"
        rc=0
      fi ;;
    *)
      warn "$label cannot reach ${url} (HTTP=${code}) $(head -c 100 "$body_file" 2>/dev/null)"
      rc=1 ;;
  esac
  rm -f "$body_file"
  return $rc
}

# check_llm_group <label> <base_url> <api_key> <model> <protocol>
#   The check runs on this machine, not in a container: host.docker.internal (which containers use to
#   reach a service on the host, e.g. a local LiteLLM) often doesn't resolve here, so test it as localhost.
check_llm_group() {
  local label="$1" base="$2" key="$3" model="$4" proto="${5:-openai}"
  local check_base="${base//host.docker.internal/localhost}"
  info "Checking the $label connection (protocol=${proto})..."
  case "$proto" in
    anthropic) check_llm_anthropic "$label" "$check_base" "$key" "$model" ;;
    *)         check_llm_openai    "$label" "$check_base" "$key" "$model" ;;
  esac
}

# ═══════════════════════════════════════════════════════════════
# Interactive input helpers
# ═══════════════════════════════════════════════════════════════

# prompt_with_default <label> <default>
#   Print "label [default]: " and read a line; empty input returns the default. The result goes to stdout.
prompt_with_default() {
  local label="$1" default="${2:-}"
  # The prompt goes to stderr and the result to stdout (so $(...) captures only the result)
  if [[ -n "$default" ]]; then
    printf '%s [%s]: ' "$label" "$default" >&2
  else
    printf '%s: ' "$label" >&2
  fi
  local input
  IFS= read -r input || { printf '\n' >&2; printf '%s' "$default"; return 0; }
  if [[ -z "$input" ]]; then
    printf '%s' "$default"
  else
    printf '%s' "$input"
  fi
}

# prompt_protocol <default>
#   Ask for the LLM protocol (openai/anthropic); invalid input falls back to openai.
prompt_protocol() {
  local default="${1:-openai}"
  printf 'memory LLM protocol (openai/anthropic) [%s]: ' "$default" >&2
  local input
  IFS= read -r input || { printf '\n' >&2; printf '%s' "$default"; return 0; }
  input="${input:-$default}"
  case "$input" in
    openai|anthropic) printf '%s' "$input" ;;
    *) warn "unknown protocol '$input', falling back to openai"; printf 'openai' ;;
  esac
}

# prompt_confirm <question> <default_yes:0|1>
#   Returns 0 = yes / 1 = no
prompt_confirm() {
  local question="$1" default_yes="${2:-0}"
  local hint
  if [[ "$default_yes" == "1" ]]; then hint="[Y/n]"; else hint="[y/N]"; fi
  printf '%s %s: ' "$question" "$hint" >&2
  local input
  IFS= read -r input || return 1
  case "$input" in
    [yY]|[yY][eE][sS]) return 0 ;;
    [nN]|[nN][oO])     return 1 ;;
    "")                [[ "$default_yes" == "1" ]] && return 0 || return 1 ;;
    *)                 return 1 ;;
  esac
}

# set_env_value <key> <value> <file>
#   Update or append KEY=VALUE in .env in place. Uses awk to write values verbatim, avoiding sed/perl escaping pitfalls.
set_env_value() {
  local key="$1" value="$2" file="$3"
  if grep -qE "^[[:space:]]*${key}=" "$file"; then
    local tmp="$file.tmp.$$"
    awk -v k="$key" -v v="$value" '
      $0 ~ ("^[[:space:]]*" k "=") { print k "=" v; next }
      { print }
    ' "$file" > "$tmp" && mv "$tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

# ensure_knowledge_service_key
#   The Knowledge service-to-service auth key (shared by Panel and Knowledge).
#   When empty or a placeholder, generate a random value and write it back to .env (idempotent: reused once
#   generated, so it doesn't change across restarts). The caller then injects the same value into the
#   memory-hub container twice:
#     KNOWLEDGE_SERVICE_KEY → checked by the Knowledge process
#     KNOWLEDGE_AUTH_TOKEN  → sent by the Panel process
ensure_knowledge_service_key() {
  if [[ -z "${KNOWLEDGE_SERVICE_KEY:-}" || "${KNOWLEDGE_SERVICE_KEY}" == "REPLACE_ME" ]]; then
    local rand
    if command -v openssl >/dev/null 2>&1; then
      rand="$(openssl rand -hex 24)"
    else
      rand="$(head -c 24 /dev/urandom | od -A n -t x1 | tr -d ' \n')"
    fi
    KNOWLEDGE_SERVICE_KEY="ks-svc-${rand}"
    set_env_value KNOWLEDGE_SERVICE_KEY "$KNOWLEDGE_SERVICE_KEY" "$ENV_FILE"
    info "Generated KNOWLEDGE_SERVICE_KEY and wrote it to $ENV_FILE (shared by Panel and Knowledge)"
  fi
}

# interactive_llm_setup
#   Interactively fill in the two LLM groups (memory + proxy) → connection check (with retry) → write back to .env.
#   Updates the in-memory MEMORY_LLM_* / PROXY_UPSTREAM_* variables (already exported) and persists them to .env.
interactive_llm_setup() {
  local base key model proto reuse_same

  echo ""
  info "═══ LLM setup (Enter = keep the current value) ════════════"

  # ── memory group ──
  while true; do
    base=$(prompt_with_default "memory LLM BASE_URL" "${MEMORY_LLM_BASE_URL:-}")
    key=$(prompt_with_default "memory LLM API_KEY" "${MEMORY_LLM_API_KEY:-}")
    model=$(prompt_with_default "memory LLM MODEL" "${MEMORY_LLM_MODEL:-}")
    proto=$(prompt_protocol "${MEMORY_LLM_PROTOCOL:-openai}")

    if check_llm_group "memory LLM" "$base" "$key" "$model" "$proto"; then
      MEMORY_LLM_BASE_URL="$base"
      MEMORY_LLM_API_KEY="$key"
      MEMORY_LLM_MODEL="$model"
      MEMORY_LLM_PROTOCOL="$proto"
      break
    fi
    warn "The memory LLM connection check failed."
    prompt_confirm "Enter it again?" 1 || die "Cancelled by user."
  done

  # ── proxy group ──
  # Reuse is the default (Enter = reuse) when:
  #   1) the proxy group in .env is identical to the memory group just entered;
  #   2) the proxy group is still empty / REPLACE_ME (first run, not configured yet — reusing is the easy default).
  reuse_same=0
  if [[ "${PROXY_UPSTREAM_URL:-}" == "$MEMORY_LLM_BASE_URL" && \
        "${PROXY_UPSTREAM_API_KEY:-}" == "$MEMORY_LLM_API_KEY" && \
        "${PROXY_UPSTREAM_MODEL:-}" == "$MEMORY_LLM_MODEL" ]]; then
    reuse_same=1
  elif [[ -z "${PROXY_UPSTREAM_URL:-}" || "${PROXY_UPSTREAM_URL:-}" == "REPLACE_ME" ]] && \
       [[ -z "${PROXY_UPSTREAM_API_KEY:-}" || "${PROXY_UPSTREAM_API_KEY:-}" == "REPLACE_ME" ]] && \
       [[ -z "${PROXY_UPSTREAM_MODEL:-}" || "${PROXY_UPSTREAM_MODEL:-}" == "REPLACE_ME" ]]; then
    reuse_same=1
  fi

  if prompt_confirm "Should the proxy use the same LLM settings as memory?" "$reuse_same"; then
    PROXY_UPSTREAM_URL="$MEMORY_LLM_BASE_URL"
    PROXY_UPSTREAM_API_KEY="$MEMORY_LLM_API_KEY"
    PROXY_UPSTREAM_MODEL="$MEMORY_LLM_MODEL"
    ok "The proxy uses the memory LLM settings; skipping a second check"
  else
    while true; do
      base=$(prompt_with_default "proxy UPSTREAM_URL" "${PROXY_UPSTREAM_URL:-}")
      key=$(prompt_with_default "proxy UPSTREAM_API_KEY" "${PROXY_UPSTREAM_API_KEY:-}")
      model=$(prompt_with_default "proxy UPSTREAM_MODEL" "${PROXY_UPSTREAM_MODEL:-}")

      if check_llm_group "proxy LLM" "$base" "$key" "$model" openai; then
        PROXY_UPSTREAM_URL="$base"
        PROXY_UPSTREAM_API_KEY="$key"
        PROXY_UPSTREAM_MODEL="$model"
        break
      fi
      warn "The proxy LLM connection check failed."
      prompt_confirm "Enter it again?" 1 || die "Cancelled by user."
    done
  fi

  # ── write back to .env ──
  info "Saving the LLM settings → $ENV_FILE"
  set_env_value MEMORY_LLM_BASE_URL "$MEMORY_LLM_BASE_URL" "$ENV_FILE"
  set_env_value MEMORY_LLM_API_KEY "$MEMORY_LLM_API_KEY" "$ENV_FILE"
  set_env_value MEMORY_LLM_MODEL "$MEMORY_LLM_MODEL" "$ENV_FILE"
  set_env_value MEMORY_LLM_PROTOCOL "$MEMORY_LLM_PROTOCOL" "$ENV_FILE"
  set_env_value PROXY_UPSTREAM_URL "$PROXY_UPSTREAM_URL" "$ENV_FILE"
  set_env_value PROXY_UPSTREAM_API_KEY "$PROXY_UPSTREAM_API_KEY" "$ENV_FILE"
  set_env_value PROXY_UPSTREAM_MODEL "$PROXY_UPSTREAM_MODEL" "$ENV_FILE"
  ok "LLM settings saved to $ENV_FILE"
}

# ═══════════════════════════════════════════════════════════════
# Port pre-check
# ═══════════════════════════════════════════════════════════════

# port_in_use <port>
#   Check whether a host port is LISTENing. Returns 0 = in use / 1 = free.
port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ":${port}$"
  else
    return 1  # no tool to check: treat as free and don't block startup
  fi
}

# wamf_self_ports
#   Print the host ports mapped by the running wamf containers (space separated).
#   Those ports are held by our own containers, which rm_container_if_exists recreates at startup — not a conflict.
wamf_self_ports() {
  local c p ports=""
  for c in wamf-proxy wamf-memory-hub wamf-memory-core; do
    if $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
      p="$($DOCKER port "$c" 2>/dev/null | grep -oE '[0-9]+$' | sort -u | tr '\n' ' ' || true)"
      ports="$ports $p"
    fi
  done
  printf '%s' "$ports"
}

# check_ports
#   Check the 4 target ports in one go; exit with an error if an outside process holds one.
#   Ports held by our own wamf containers are excluded (they get recreated at startup).
check_ports() {
  local self_ports port_var port conflict=0
  self_ports=" $(wamf_self_ports) "
  info "═══ Port pre-check ═════════════════════════════════════"
  for port_var in MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT PROXY_PORT; do
    port="${!port_var:-}"
    if [[ -z "$port" ]]; then continue; fi
    if [[ "$self_ports" == *" $port "* ]]; then
      info "Port $port ($port_var) is held by an old wamf container (recreated at startup), skipping"
      continue
    fi
    if port_in_use "$port"; then
      echo "${C_RED}[error]${C_RST} Port $port ($port_var) is already in use; free it or change the port in .env." >&2
      conflict=1
    else
      ok "Port $port ($port_var) is free"
    fi
  done
  (( conflict == 0 )) || die "Port conflict; free the ports and try again."
}
