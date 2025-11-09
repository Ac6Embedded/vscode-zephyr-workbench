#!/bin/bash
set -euo pipefail

# Arguments
FILE="$1"       # Path to the downloaded SimplicityCommander-Mac.zip
DEST_DIR="$2"   # The main tools directory (.zinstaller/tools)
TMP_DIR="$3"    # Temporary directory (.zinstaller/tmp)

TOOL_KEY="simplicity_commander"
TOOL_DIR="${DEST_DIR}/${TOOL_KEY}"
CLI_SUBDIR="commander-cli"

echo "Installing Simplicity Commander from ${FILE}..."

# Ensure destination exists
mkdir -p "$DEST_DIR"

# Create a temporary extraction directory
WORK_DIR="$(mktemp -d "${TMP_DIR}/simplicity-XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
echo "Extracting into temporary directory: $WORK_DIR"

# --- Step 1: Extract outer ZIP ---
unzip -qq "$FILE" -d "$WORK_DIR"

# --- Step 2: Locate the CLI inner archive (Commander-cli_osx_*.zip) ---
INNER_ZIP=$(find "$WORK_DIR" -type f -iname "Commander-cli*osx*.zip" | head -n 1)

if [[ -z "$INNER_ZIP" ]]; then
    echo "ERROR: Could not find Commander-cli_osx_*.zip inside extracted folder."
    exit 1
fi

echo "Found CLI archive: $INNER_ZIP"

# --- Step 3: Extract CLI to tool directory ---
CLI_STAGE_DIR="$WORK_DIR/cli"
mkdir -p "$CLI_STAGE_DIR"

echo "Extracting CLI payload..."
unzip -qq "$INNER_ZIP" -d "$CLI_STAGE_DIR"

find "$CLI_STAGE_DIR" -type d -name "__MACOSX" -exec rm -rf {} +

rm -rf "$TOOL_DIR"
mkdir -p "$TOOL_DIR/$CLI_SUBDIR"

# Copy everything from staged CLI archive into the destination CLI subdir.
cp -R "$CLI_STAGE_DIR"/. "$TOOL_DIR/$CLI_SUBDIR/"

CLI_BASE_DIR="$TOOL_DIR/$CLI_SUBDIR"

# --- Step 4: Locate CLI binary and detect version ---
CLI_BIN_PATH=$(find "$CLI_BASE_DIR" -type f \( -name "commander-cli" -o -name "commander" \) | head -n 1)
if [[ -z "$CLI_BIN_PATH" ]]; then
    echo "ERROR: Could not find commander executable inside $CLI_BASE_DIR"
    exit 1
fi

chmod +x "$CLI_BIN_PATH"

echo "Detecting Simplicity Commander version..."
VERSION_OUTPUT=$("$CLI_BIN_PATH" --version 2>&1 || true)
VERSION=$(echo "$VERSION_OUTPUT" | awk '/Simplicity Commander/ { for (i=NF; i>0; --i) if ($i ~ /[0-9]/) { gsub(/\r/,"",$i); print $i; break } }')

if [[ -z "$VERSION" ]]; then
    echo "WARNING: Could not detect version from CLI output, falling back to manifest value."
    VERSION=""
fi

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

if [[ -z "$VERSION" || "$VERSION" == "null" ]]; then
    if [[ -f "$DBG_TOOLS_YML" ]]; then
        VERSION=$($YQ eval ".debug_tools[] | select(.tool == \"$TOOL_KEY\") | .version" "$DBG_TOOLS_YML")
        [[ "$VERSION" == "null" ]] && VERSION="000"
    else
        VERSION="000"
    fi
fi

echo "Detected Simplicity Commander version: $VERSION"

PATH_FOR_YAML="$(dirname "$CLI_BIN_PATH")"
PATH_FOR_YAML=$(echo "$PATH_FOR_YAML" | sed 's#\\#/#g')

echo "Updating env.yml for tool '$TOOL_KEY' (version: $VERSION)"
update_env_yaml_block "$TOOL_KEY" "$YQ" "$ENV_YAML" "$PATH_FOR_YAML" "$VERSION"

echo "Simplicity Commander installed successfully"
echo "   Path: $PATH_FOR_YAML"
echo "   Version: $VERSION"

exit 0
