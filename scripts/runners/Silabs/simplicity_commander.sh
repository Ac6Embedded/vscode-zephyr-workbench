#!/bin/bash
set -euo pipefail

# Arguments
FILE="$1"       # Path to the downloaded SimplicityCommander-Linux.zip
DEST_DIR="$2"   # The main tools directory (.zinstaller/tools)
TMP_DIR="$3"    # Temporary directory (.zinstaller/tmp)

TOOL_KEY="simplicity_commander"
TOOL_DIR="${DEST_DIR}/${TOOL_KEY}"
CLI_SUBDIR="commander-cli"

echo "Installing Simplicity Commander from ${FILE}..."

# Ensure destination exists
mkdir -p "$DEST_DIR"

# Create a temporary extraction directory
WORK_DIR="$(mktemp -d)"
echo "Extracting into temporary directory: $WORK_DIR"

# --- Step 1: Extract outer ZIP ---
unzip -qq "$FILE" -d "$WORK_DIR"

# --- Step 2: Locate the CLI inner ZIP (Commander-cli_win32_x64_*.zip or Linux equivalent) ---
INNER_TAR=$(find "$WORK_DIR" -type f -name "Commander-cli_linux_x86_64_*tar.bz" | head -n 1)

if [[ -z "$INNER_TAR" ]]; then
    echo "ERROR: Could not find Commander-cli_linux_x86_64_*tar.bz inside extracted folder."
    rm -rf "$WORK_DIR"
    exit 1
fi

echo "Found CLI archive: $INNER_TAR"

# --- Step 3: Extract CLI to tool directory ---
rm -rf "$TOOL_DIR"
mkdir -p "$TOOL_DIR"

echo "Extracting CLI into ${TOOL_DIR}..."
tar xf "$INNER_TAR" -C "$TOOL_DIR"

# --- Step 4: Detect actual version ---
CLI_EXE_PATH="${TOOL_DIR}/${CLI_SUBDIR}/commander-cli"
if [[ ! -f "$CLI_EXE_PATH" ]]; then
    echo "ERROR: commander-cli not found at expected path: $CLI_EXE_PATH"
    rm -rf "$WORK_DIR"
    exit 1
fi

chmod +x "$CLI_EXE_PATH"

echo "Detecting Simplicity Commander version..."
VERSION_OUTPUT=$("$CLI_EXE_PATH" --version 2>&1 || true)
VERSION=$(echo "$VERSION_OUTPUT" | grep -E "^Simplicity Commander" | awk '{print $3}' | tr -d '\r')

if [[ -z "$VERSION" ]]; then
    echo "WARNING: Could not detect version from CLI output, defaulting to 000"
    VERSION="000"
fi

echo "Detected Simplicity Commander version: $VERSION"

# --- Step 5: Load env-utils.sh and update env.yml ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_UTILS="$PARENT_DIR/env-utils.sh"
DBG_TOOLS_YML="$PARENT_DIR/debug-tools.yml"

if [[ -f "$ENV_UTILS" ]]; then
    source "$ENV_UTILS"
    echo "Loaded environment utilities from $ENV_UTILS"
else
    echo "ERROR: env-utils.sh not found at $ENV_UTILS"
    exit 1
fi

YQ="yq"
ZINSTALLER_BASE="$(dirname "$DEST_DIR")"
ENV_YAML="$ZINSTALLER_BASE/env.yml"

PATH_FOR_YAML="${TOOL_DIR}/${CLI_SUBDIR}"
PATH_FOR_YAML=$(echo "$PATH_FOR_YAML" | sed 's#\\#/#g')

echo "Updating env.yml for tool '$TOOL_KEY' (version: $VERSION)"
update_env_yaml_block "$TOOL_KEY" "$YQ" "$ENV_YAML" "$PATH_FOR_YAML" "$VERSION"

echo "Simplicity Commander installed successfully"
echo "   Path: $PATH_FOR_YAML"
echo "   Version: $VERSION"

# --- Step 6: Cleanup ---
rm -rf "$WORK_DIR"

exit 0
