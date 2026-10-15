#!/bin/bash
#
# install_memory_weaverai.sh
#
# Run after install_hermes_ubuntu.sh, to:
#   1. Download @weaversoft/memory-weaverai@latest via npm into
#      $MEMORY_WEAVERAI_ROOT/wamf-memory-openclaw-plugin(default ~/.weaverai-memory-fabric/wamf-memory-openclaw-plugin)
#   2. Install the Gateway's Node.js dependencies (npm install)
#   3. Configure hermes config.yaml to use the memory_weaverai memory provider
#   4. Set the Gateway auto-start environment variables
#
# Path conventions (all under ~/.weaverai-memory-fabric/, overridable via environment variables):
#   $MEMORY_WEAVERAI_ROOT     default ~/.weaverai-memory-fabric
#   $WAMF_INSTALL_DIR          default $MEMORY_WEAVERAI_ROOT/wamf-memory-openclaw-plugin
#   $WAMF_DATA_DIR             default $MEMORY_WEAVERAI_ROOT/memory-wamf
#
# Old versions (<= 0.3.x) used ~/wamf-memory-openclaw-plugin and ~/memory-wamf;
# this script automatically migrates those two old directories to the new location before running (see Step 0).
#
# Usage:
#   Run as the target user (recommended):
#     su - <username> -c "bash ~/install_memory_weaverai.sh"
#     # or log in as that user and run directly
#     bash ~/install_memory_weaverai.sh
#
#   Run as root (image build scenario):
#     bash ~/install_memory_weaverai.sh
#     # root automatically switches to the target user via su, then fixes permissions afterwards
#
# Prerequisites:
#   - install_hermes_ubuntu.sh has finished (hermes-agent is installed)
#   - Node.js >= 22 is installed

set -e

# Dynamically determine the target install user and its HOME directory.
# Priority:
#   1. Explicit ``INSTALL_AS_USER`` environment variable (admin-script case: root runs the install but
#      wants to configure it for another user)
#   2. ``SUDO_USER`` (when invoked via ``sudo``, switch back to the original user instead of root)
#   3. ``whoami`` -- the user matching the current EUID
#
# Note: when root runs it from a direct ssh login (not sudo), neither of the first two is set,
# ``whoami`` returns ``root``. The ``id -u`` == 0 branch below recognizes this "target
# is root" case and skips the ``su - root`` recursion.
USERNAME="${INSTALL_AS_USER:-${SUDO_USER:-$(whoami)}}"
USER_HOME=$(eval echo ~$USERNAME)

# npm package name
NPM_PACKAGE="@weaversoft/memory-weaverai@latest"

# Hermes paths
HERMES_HOME="$USER_HOME/.hermes"
# HERMES_AGENT_DIR(fix: issue #18)
# Use whatever the user passes via environment variable; fall back to the traditional path when unset.
# If the directory does not exist, the later prerequisite check reports the error.
HERMES_AGENT_DIR="${HERMES_AGENT_DIR:-$HERMES_HOME/hermes-agent}"
HERMES_CONFIG="$HERMES_HOME/config.yaml"

# memory-weaverai unified root directory (all wamf-related data/code lives here)
# Overridable via the MEMORY_WEAVERAI_ROOT environment variable
MEMORY_WEAVERAI_ROOT="${MEMORY_WEAVERAI_ROOT:-$USER_HOME/.memory-weaverai}"

# wamf extraction target directory (under the unified root)
# Overridable via the WAMF_INSTALL_DIR environment variable
WAMF_INSTALL_DIR="${WAMF_INSTALL_DIR:-$MEMORY_WEAVERAI_ROOT/wamf-memory-openclaw-plugin}"

# wamf data directory (Gateway baseDir, under the unified root)
# Overridable via the WAMF_DATA_DIR environment variable
WAMF_DATA_DIR="${WAMF_DATA_DIR:-$MEMORY_WEAVERAI_ROOT/memory-wamf}"

# Old paths (used only for automatic migration)
LEGACY_INSTALL_DIR="$USER_HOME/wamf-memory-openclaw-plugin"
LEGACY_DATA_DIR="$USER_HOME/memory-wamf"

# ==================== root -> automatically switch to the target user ====================
# Consistent with install_hermes_ubuntu.sh: if run as root and the target user is not
# root, automatically su to the target user to run the actual install logic.
#
# If the current user is root and the target user is also root (``USERNAME=root``, e.g. direct ssh
# login as root to run the install), skip ``su - root`` -- otherwise it recurses forever (``su - root``
# still lands in root, hits this branch again, su's again, and never stops). See issue #20.

if [ "$(id -u)" -eq 0 ] && [ "$USERNAME" != "root" ]; then
    echo "[memory-weaverai] Running as root, switching to $USERNAME for installation..."

    # Verify prerequisites
    if [ ! -d "$HERMES_AGENT_DIR" ]; then
        echo "[ERROR] Hermes agent not found at $HERMES_AGENT_DIR"
        echo "[ERROR] Please run install_hermes_ubuntu.sh first."
        exit 1
    fi

    # Switch to the target user and run
    TEMP_SCRIPT=$(mktemp /tmp/memory-weaverai-install-XXXXXX.sh)
    cp "${BASH_SOURCE[0]}" "$TEMP_SCRIPT"
    chmod 755 "$TEMP_SCRIPT"
    su - $USERNAME -c "bash $TEMP_SCRIPT" </dev/null

    # Fix permissions
    echo "[memory-weaverai] Fixing permissions..."
    chown -R $USERNAME:$USERNAME "$USER_HOME"

    rm -f "$TEMP_SCRIPT"
    echo "[memory-weaverai] Installation completed successfully"
    exit 0
elif [ "$(id -u)" -eq 0 ]; then
    # Current user is root and the target user is also root: run the rest of the install logic directly as root,
    # without the ``su -`` switch (avoids the #20 recursion).
    echo "[memory-weaverai] Running as root; target user is also root — installing in place."
fi

# ==================== User phase (core install logic) ====================

echo "[memory-weaverai] Installing memory-weaverai plugin (user: $(whoami))..."

# Verify prerequisites
if [ ! -d "$HERMES_AGENT_DIR" ]; then
    echo "[ERROR] Hermes agent not found at $HERMES_AGENT_DIR"
    echo "[ERROR] Please run install_hermes_ubuntu.sh first."
    exit 1
fi

# Load the hermes environment (node/npm must be on PATH)
if [ -f /etc/profile.d/hermes-env.sh ]; then
    source /etc/profile.d/hermes-env.sh
fi

# Make sure the unified root directory exists
mkdir -p "$MEMORY_WEAVERAI_ROOT"

# ---------- Step 0: automatically migrate old paths (backward compatible) ----------
#
# Historical versions extracted wamf to ~/wamf-memory-openclaw-plugin and kept data in ~/memory-wamf.
# Everything now lives under ~/.weaverai-memory-fabric/; a one-time automatic migration is done here.
# Skip if already at the new location; if both old and new exist, print a warning and leave the new location untouched.

migrate_legacy_dir() {
    local legacy="$1"
    local target="$2"
    local label="$3"
    if [ ! -e "$legacy" ]; then
        return 0
    fi
    if [ -L "$legacy" ]; then
        # Old location is a symlink; just remove it
        echo "[memory-weaverai] Removing legacy symlink: $legacy"
        rm -f "$legacy"
        return 0
    fi
    if [ -e "$target" ]; then
        echo "[memory-weaverai] WARN: legacy $label dir exists at $legacy but new location $target also exists." >&2
        echo "[memory-weaverai] WARN: keeping new location; please review and remove $legacy manually if obsolete." >&2
        return 0
    fi
    echo "[memory-weaverai] Migrating legacy $label dir: $legacy -> $target"
    mkdir -p "$(dirname "$target")"
    mv "$legacy" "$target"
}

migrate_legacy_dir "$LEGACY_INSTALL_DIR" "$WAMF_INSTALL_DIR" "install"
migrate_legacy_dir "$LEGACY_DATA_DIR"    "$WAMF_DATA_DIR"    "data"

# ---------- Step 1: download the package via npm and extract it to $WAMF_INSTALL_DIR ----------

echo "[memory-weaverai] Step 1: Downloading $NPM_PACKAGE via npm..."

# Clean up the old installation
rm -rf "$WAMF_INSTALL_DIR"

# Download the package via npm install in a temporary directory
TEMP_DOWNLOAD=$(mktemp -d /tmp/memory-weaverai-download-XXXXXX)
cd "$TEMP_DOWNLOAD"
npm init -y --silent > /dev/null 2>&1
npm install "$NPM_PACKAGE" --omit=dev 2>&1 | tail -5

# After install the package is at node_modules/@weaversoft/memory-weaverai
PACK_DIR="$TEMP_DOWNLOAD/node_modules/@weaversoft/memory-weaverai"

if [ ! -d "$PACK_DIR" ]; then
    echo "[ERROR] Downloaded package directory not found at $PACK_DIR"
    rm -rf "$TEMP_DOWNLOAD"
    exit 1
fi

# Move the package contents to the target install directory
mkdir -p "$(dirname "$WAMF_INSTALL_DIR")"
cp -r "$PACK_DIR" "$WAMF_INSTALL_DIR"

echo "[memory-weaverai] Package downloaded and extracted to $WAMF_INSTALL_DIR"

# ---------- Step 2: install the Gateway Node.js dependencies ----------

echo "[memory-weaverai] Step 2: Installing Gateway dependencies..."

cd "$WAMF_INSTALL_DIR"

echo "[memory-weaverai] Running npm install (this may take a while)..."
npm install --omit=dev 2>&1 | tail -5

# Install tsx (needed to start the Gateway), preferring a local install
if ! npx tsx --version &>/dev/null; then
    npm install tsx 2>&1 | tail -2
fi

echo "[memory-weaverai] Gateway dependencies installed"

# ---------- Step 2.5: link the plugin into the hermes plugin directory ----------

echo "[memory-weaverai] Step 2.5: Linking plugin into hermes plugins directory..."

HERMES_PLUGIN_DIR="$HERMES_AGENT_DIR/plugins/memory/memory_weaverai"
PLUGIN_SRC_DIR="$WAMF_INSTALL_DIR/hermes-plugin/memory/memory_weaverai"

# Remove the old link/directory
rm -rf "$HERMES_PLUGIN_DIR"

# Create a symlink so hermes can discover the plugin
ln -sf "$PLUGIN_SRC_DIR" "$HERMES_PLUGIN_DIR"

echo "[memory-weaverai] Plugin linked: $HERMES_PLUGIN_DIR -> $PLUGIN_SRC_DIR"

# ---------- Step 3: prompt the user to enable memory_weaverai manually (config is not modified automatically) ----------

echo "[memory-weaverai] Step 3: Checking hermes config..."

# The plugin is linked into the hermes plugin directory but not enabled automatically; only a hint is shown
if [ -f "$HERMES_CONFIG" ]; then
    if sed -n '/^memory:/,/^[a-zA-Z]/p' "$HERMES_CONFIG" | grep -q "provider: memory_weaverai"; then
        echo "[memory-weaverai] memory.provider already set to memory_weaverai"
    else
        echo "[memory-weaverai] Plugin installed but NOT enabled by default."
        echo "[memory-weaverai] To enable wamf memory, add/edit in $HERMES_CONFIG:"
        echo ""
        echo "    memory:"
        echo "      provider: memory_weaverai"
        echo ""
    fi
else
    echo "[memory-weaverai] WARN: $HERMES_CONFIG not found, please run install_hermes_ubuntu.sh first"
fi

# ---------- Step 4: configure the Gateway environment variables ----------

echo "[memory-weaverai] Step 4: Setting up Gateway environment..."

# Build the Gateway start command
# Wrap with sh -c: cd into the plugin directory first, then start the Gateway (needed for ESM resolution)
#
# Resolve the absolute node path into GATEWAY_CMD (fix: issue #19)
# When Hermes or a standalone Gateway runs as a systemd service, systemd does not
# source any user shell rc file, so the PATH injected by nvm/asdf is absent.
# Resolve the absolute path with `command -v node` at install time, and use Node's native
# `--import tsx/esm` (Node >= 20.6 stable) instead of `npx tsx`,
# so the final command does not depend on the runtime PATH at all.
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
    echo "[ERROR] 'node' not found in PATH; cannot generate Gateway start command." >&2
    echo "[ERROR] If you installed Node via nvm/asdf, source the loader script first:" >&2
    echo "[ERROR]   source ~/.bashrc   # or 'nvm use <version>'" >&2
    exit 1
fi
echo "[memory-weaverai] Resolved node: $NODE_BIN"

GATEWAY_CMD="sh -c 'cd $WAMF_INSTALL_DIR && exec \"$NODE_BIN\" --import tsx/esm src/gateway/server.ts'"

# ── 4a: /etc/profile.d (SSH interactive login case) ──
# Persist environment variables into /etc/profile.d for manual `hermes` runs over SSH.
# Note: LLM-related variables (API key, model, etc.) must be configured manually by the user afterwards
ENVFILE="/etc/profile.d/memory-weaverai-env.sh"
cat << ENVEOF | sudo tee "$ENVFILE" > /dev/null
# memory-weaverai Gateway environment variables
export MEMORY_WEAVERAI_GATEWAY_CMD="$GATEWAY_CMD"
export MEMORY_WEAVERAI_GATEWAY_HOST="127.0.0.1"
export MEMORY_WEAVERAI_GATEWAY_PORT="8420"
# LLM configuration (edit as needed)
# export MEMORY_WEAVERAI_LLM_API_KEY="sk-..."
# export MEMORY_WEAVERAI_LLM_BASE_URL="https://api.openai.com/v1"
# export MEMORY_WEAVERAI_LLM_MODEL="gpt-4o"
ENVEOF

echo "[memory-weaverai] Environment variables written to $ENVFILE"

# ── 4b: ~/.hermes/.env (systemd service case) ──
# hermes-gateway started via a systemd user service does not source /etc/profile.d/*.sh,
# but hermes's run.py calls load_dotenv("~/.hermes/.env") at startup.
# So the key variables must also be written to .env, otherwise the Gateway cannot auto-start under systemd.
HERMES_ENV="$HERMES_HOME/.env"

_append_or_update_env() {
    local key="$1"
    local value="$2"
    local file="$3"
    if [ ! -f "$file" ]; then
        touch "$file"
    fi
    # Remove existing lines for the same variable (including commented-out and quoted ones), then append
    sed -i "/^${key}=/d" "$file"
    sed -i "/^# *${key}=/d" "$file"
    # python-dotenv requires values containing spaces/quotes/special characters to be wrapped in double quotes
    echo "${key}=\"${value}\"" >> "$file"
}

_append_or_update_env "MEMORY_WEAVERAI_GATEWAY_CMD" "$GATEWAY_CMD" "$HERMES_ENV"
_append_or_update_env "MEMORY_WEAVERAI_GATEWAY_HOST" "127.0.0.1"   "$HERMES_ENV"
_append_or_update_env "MEMORY_WEAVERAI_GATEWAY_PORT" "8420"         "$HERMES_ENV"

echo "[memory-weaverai] Gateway env vars also written to $HERMES_ENV (for systemd service)"

# ---------- Cleanup ----------

rm -rf "$TEMP_DOWNLOAD"

# ---------- Verify the installation ----------

echo ""
echo "=========================================="
echo "[memory-weaverai] Installation Summary"
echo "=========================================="
echo "  Root dir:       $MEMORY_WEAVERAI_ROOT"
echo "  wamf source:    $WAMF_INSTALL_DIR"
echo "  wamf data dir:  $WAMF_DATA_DIR"
echo "  Hermes config:  $HERMES_CONFIG"
echo "  Env file:       $ENVFILE"
echo ""
echo "  Installed files in wamf dir:"
ls -la "$WAMF_INSTALL_DIR"/ 2>/dev/null | head -20 || echo "  (none)"
echo ""

# Verify the hermes plugin files exist (in the extraction directory)
PLUGIN_SRC="$WAMF_INSTALL_DIR/hermes-plugin/memory/memory_weaverai"
MISSING=0
for f in __init__.py plugin.yaml client.py supervisor.py; do
    if [ ! -f "$PLUGIN_SRC/$f" ]; then
        echo "  [WARN] Missing: $PLUGIN_SRC/$f"
        MISSING=1
    fi
done

if [ "$MISSING" -eq 0 ]; then
    echo "  [OK] All hermes plugin files present"
fi

# Verify the Gateway entry point exists
if [ -f "$WAMF_INSTALL_DIR/src/gateway/server.ts" ]; then
    echo "  [OK] Gateway entry point found"
else
    echo "  [WARN] Gateway server.ts not found at $WAMF_INSTALL_DIR/src/gateway/server.ts"
fi

# Verify node_modules is installed
if [ -d "$WAMF_INSTALL_DIR/node_modules" ]; then
    echo "  [OK] Gateway node_modules installed"
else
    echo "  [WARN] Gateway node_modules not found"
fi

echo ""
echo "[memory-weaverai] Done!"
echo ""
echo "  NOTE: Before using the memory plugin, configure LLM credentials in ~/.hermes/.env:"
echo "    MEMORY_WEAVERAI_LLM_API_KEY=your-api-key"
echo "    MEMORY_WEAVERAI_LLM_BASE_URL=https://api.openai.com/v1"
echo "    MEMORY_WEAVERAI_LLM_MODEL=gpt-4o"
echo ""
echo "  (For systemd-managed hermes-gateway, ~/.hermes/.env is the authoritative config."
echo "   /etc/profile.d/ is only used for interactive SSH sessions.)"
echo ""
