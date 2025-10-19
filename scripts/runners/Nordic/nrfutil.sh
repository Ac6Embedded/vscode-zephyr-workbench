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

echo "${TOOL_NAME} installation complete."
exit 0
