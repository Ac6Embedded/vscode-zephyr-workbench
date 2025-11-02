#!/bin/bash
set -euo pipefail


# --- Check if JLink is installed ---
if ! command -v JLinkExe &> /dev/null; then
    echo ""
    echo "ERROR: JLink is not installed or not in the PATH. Please install JLink first."
    echo ""
    exit 1
fi

# Arguments
FILE="$1"       # Path to the downloaded archive
DEST_DIR="$2"   # The main tools directory (.zinstaller/tools)
TMP_DIR="$3"    # Temporary directory (not needed but kept for consistency)

TOOL_NAME="nrf-command-line-tools"
TOOL_DIR="${DEST_DIR}/${TOOL_NAME}"

echo "Installing ${TOOL_NAME} from ${FILE}..."

# Ensure destination exists
mkdir -p "$DEST_DIR"

# Create a temporary extraction directory
WORK_DIR="$(mktemp -d)"
echo "Extracting into temporary directory: $WORK_DIR"

# Extract the archive silently
tar -xzf "$FILE" -C "$WORK_DIR"

# Find the extracted folder (handles versioned names)
EXTRACTED_DIR=$(find "$WORK_DIR" -mindepth 1 -maxdepth 1 -type d -name "nrf-command-line-tools*" | head -n 1)

if [[ -z "$EXTRACTED_DIR" ]]; then
    echo "ERROR: Could not find extracted folder for ${TOOL_NAME}"
    rm -rf "$WORK_DIR"
    exit 1
fi

echo "Renaming extracted folder: $(basename "$EXTRACTED_DIR") → ${TOOL_NAME}"

# Remove any old installation
rm -rf "$TOOL_DIR"

# Move and rename the extracted directory
mv "$EXTRACTED_DIR" "$TOOL_DIR"

# --- Resolve directories ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_UTILS="$PARENT_DIR/env-utils.sh"
DBG_TOOLS_YML="$PARENT_DIR/debug-tools.yml"

# --- Load environment utilities ---
if [[ -f "$ENV_UTILS" ]]; then
    source "$ENV_UTILS"
    echo "Loaded environment utilities from $ENV_UTILS"
else
    echo "ERROR: env-utils.sh not found at $ENV_UTILS"
    exit 1
fi

# --- Determine tool name automatically ---
# Extract the script name without path or extension, e.g. install_jlink.sh → install_jlink
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
TOOL_NAME="${SCRIPT_NAME%.*}"                # Remove extension (.sh)
TOOL_NAME="${TOOL_NAME#install_}"            # Remove "install_" prefix if present

# --- Set up variables ---
YQ="yq"
ZINSTALLER_BASE="$(dirname "$DEST_DIR")"
ENV_YAML="$ZINSTALLER_BASE/env.yml"

# --- Get version from YAML (default to "000" if missing) ---
VERSION=$($YQ eval ".debug_tools[] | select(.tool == \"$TOOL_NAME\") | .version" "$DBG_TOOLS_YML")
# Fallback if not found
if [[ -z "$VERSION" || "$VERSION" == "null" ]]; then
  VERSION="000"
fi


PATH_FOR_YAML="$TOOL_DIR/bin"

# --- Update env.yml ---
echo "Updating env.yml for tool '$TOOL_NAME' (version: $VERSION)"
update_env_yaml_block "$TOOL_NAME" "$YQ" "$ENV_YAML" "$PATH_FOR_YAML" "$VERSION"

echo "${TOOL_NAME} installed successfully to: ${TOOL_DIR}"

# Cleanup
rm -rf "$WORK_DIR"

exit 0
