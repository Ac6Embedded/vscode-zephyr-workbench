#!/bin/bash
set -euo pipefail

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

echo "${TOOL_NAME} installed successfully to: ${TOOL_DIR}"

# Cleanup
rm -rf "$WORK_DIR"

exit 0
