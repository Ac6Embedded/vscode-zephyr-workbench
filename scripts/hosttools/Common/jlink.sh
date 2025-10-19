#!/bin/bash
set -e

# Arguments from installer framework
FILE="$1"        # Path to the downloaded archive (e.g. .../JLink_Linux_V878_x86_64.tgz)
DEST_DIR="$2"    # Base tools directory (~/.zinstaller/tools)
TMP_DIR="$3"     # Temporary directory (~/.zinstaller/tmp)

TOOL_NAME="jlink"
INSTALL_DIR="$DEST_DIR/$TOOL_NAME"

echo "Installing $TOOL_NAME from $FILE..."

# Ensure required directories exist
mkdir -p "$INSTALL_DIR"
mkdir -p "$TMP_DIR/jlink_extract"

# Verify input file exists
if [[ ! -f "$FILE" ]]; then
    echo "ERROR: File not found: $FILE"
    exit 1
fi

# Extract to temporary directory
echo "Extracting archive..."
tar -xzf "$FILE" -C "$TMP_DIR/jlink_extract"

# Detect the extracted directory (usually something like JLink_Linux_V878_x86_64/)
EXTRACTED_DIR=$(find "$TMP_DIR/jlink_extract" -maxdepth 1 -type d -name "JLink_*" | head -n 1)

if [[ -z "$EXTRACTED_DIR" ]]; then
    echo "ERROR: Could not locate extracted J-Link folder."
    exit 1
fi

echo "Found extracted directory: $EXTRACTED_DIR"

# Move (or copy) contents into the tools folder, normalize name
echo "Moving extracted files into $INSTALL_DIR..."
rm -rf "$INSTALL_DIR"/*
cp -r "$EXTRACTED_DIR"/* "$INSTALL_DIR/"

# Optional: ensure binaries are executable
find "$INSTALL_DIR" -type f -iname "JLink*" -exec chmod +x {} \;

# Verify main executable exists
JLINK_BIN="$INSTALL_DIR/JLinkExe"
if [[ ! -f "$JLINK_BIN" ]]; then
    echo "WARNING: $JLINK_BIN not found. Installation may be incomplete."
else
    echo "Verified: $JLINK_BIN"
fi

# Cleanup
rm -rf "$TMP_DIR/jlink_extract"

echo "$TOOL_NAME installed successfully to $INSTALL_DIR"
exit 0
