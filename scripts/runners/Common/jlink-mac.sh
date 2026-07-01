#!/bin/bash
set -euo pipefail

# J-Link is declared script-only (os.darwin: true in debug-tools.yml) so this
# script downloads the pinned SEGGER macOS .pkg itself, reading its URL from the
# yaml (segger-sources.darwin), and installs it into /Applications/SEGGER, which
# the darwin auto-detect globs already cover.

# Arguments (script-only: $1 is empty, nothing was pre-downloaded)
FILE="${1:-}"       # unused
DEST_DIR="${2:-}"   # tools directory (.zinstaller/tools)
TMP_DIR="${3:-}"    # temporary directory (.zinstaller/tmp)

# --- Resolve the yaml and read the macOS source URL (no hardcoding) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_DIR="$(dirname "$SCRIPT_DIR")"
DBG_TOOLS_YML="$PARENT_DIR/debug-tools.yml"
YQ="yq"

PKG_URL=$($YQ eval '.debug_tools[] | select(.tool == "jlink") | .["segger-sources"].darwin' "$DBG_TOOLS_YML")
if [[ -z "$PKG_URL" || "$PKG_URL" == "null" ]]; then
    echo "ERROR: no jlink segger-sources.darwin URL found in $DBG_TOOLS_YML"
    exit 2
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

PKG_FILE="$WORK_DIR/$(basename "${PKG_URL%%\?*}")"
echo "Downloading J-Link .pkg: $PKG_URL"
# SEGGER requires accepting the license via POST
wget --post-data "accept_license_agreement=accepted&non_emb_ctr=confirmed" \
     --no-check-certificate --content-disposition \
     -q "$PKG_URL" -O "$PKG_FILE"
if file "$PKG_FILE" | grep -qi "html"; then
    echo "ERROR: SEGGER returned a license page instead of the binary for $PKG_URL"
    exit 1
fi

echo "Installing J-Link package: $PKG_FILE"
sudo installer -pkg "$PKG_FILE" -target /

exit 0
