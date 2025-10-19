#!/bin/bash
set -e

FILE="$1"       # Path to the downloaded nrfutil binary
DEST_DIR="$2"   # Base tools directory (.zinstaller/tools)
TOOLS_DIR="$3"  # Not used (kept for compatibility)

TOOL_NAME="nrfutil"
TOOL_DIR="${DEST_DIR}/${TOOL_NAME}"
DEST_FILE="${TOOL_DIR}/nrfutil"

echo "Installing ${TOOL_NAME} from ${FILE}..."

# Ensure destination directory exists
mkdir -p "${TOOL_DIR}"

# Copy binary to destination
cp -f "${FILE}" "${DEST_FILE}"

# Verify copy success
if [ -f "${DEST_FILE}" ]; then
    echo "${TOOL_NAME} installed successfully to: ${DEST_FILE}"
else
    echo "ERROR: Failed to install ${TOOL_NAME}."
    exit 1
fi

# Make sure it's executable
chmod +x "${DEST_FILE}" || {
    echo "WARNING: Could not make ${DEST_FILE} executable (non-fatal)."
}

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

exit 0
