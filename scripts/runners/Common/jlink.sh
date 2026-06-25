#!/bin/bash
set -euo pipefail

# J-Link is declared script-only (os.linux: true in debug-tools.yml) so this
# script downloads the pinned SEGGER artifacts itself, reading their URLs from
# the yaml (segger-sources.linux-deb / segger-sources.linux-tgz). It prefers the
# system .deb (dpkg -> /opt/SEGGER) and falls back to the portable .tgz extracted
# into the managed tools dir when a package install is not possible (no dpkg /
# non-Debian / no root).

# Arguments (script-only: $1 is empty, nothing was pre-downloaded)
FILE="${1:-}"       # unused
DEST_DIR="${2:-}"   # tools directory (.zinstaller/tools)
TMP_DIR="${3:-}"    # temporary directory (.zinstaller/tmp)

# --- Resolve the yaml and read the two Linux source URLs (no hardcoding) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_DIR="$(dirname "$SCRIPT_DIR")"
DBG_TOOLS_YML="$PARENT_DIR/debug-tools.yml"
YQ="yq"

DEB_URL=$($YQ eval '.debug_tools[] | select(.tool == "jlink") | .["segger-sources"]["linux-deb"]' "$DBG_TOOLS_YML")
TGZ_URL=$($YQ eval '.debug_tools[] | select(.tool == "jlink") | .["segger-sources"]["linux-tgz"]' "$DBG_TOOLS_YML")

# --- Download helper: SEGGER requires accepting the license via POST ---
fetch_segger() {   # $1=url  $2=outfile
    wget --post-data "accept_license_agreement=accepted&non_emb_ctr=confirmed" \
         --no-check-certificate --content-disposition \
         -q "$1" -O "$2"
    if file "$2" | grep -qi "html"; then
        echo "ERROR: SEGGER returned a license page instead of the binary for $1"
        return 1
    fi
}

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# --- Prefer the system .deb (root + dpkg) -> /opt/SEGGER (covered by auto-detect) ---
if [[ -n "$DEB_URL" && "$DEB_URL" != "null" ]] \
   && command -v dpkg >/dev/null 2>&1 && [[ "$(id -u)" -eq 0 ]]; then
    DEB_FILE="$WORK_DIR/$(basename "${DEB_URL%%\?*}")"
    echo "Downloading J-Link .deb: $DEB_URL"
    if fetch_segger "$DEB_URL" "$DEB_FILE" && dpkg -i "$DEB_FILE"; then
        echo "J-Link installed via dpkg (/opt/SEGGER)."
        exit 0
    fi
    echo "WARNING: .deb install failed; falling back to the portable .tgz."
else
    echo "Using the portable J-Link .tgz (no dpkg / not root / no .deb URL)."
fi

# --- Fallback: portable .tgz into the managed tools dir (no root needed) ---
if [[ -z "$TGZ_URL" || "$TGZ_URL" == "null" ]]; then
    echo "ERROR: J-Link .deb not usable and no .tgz fallback URL in $DBG_TOOLS_YML"
    exit 1
fi
TGZ_FILE="$WORK_DIR/$(basename "${TGZ_URL%%\?*}")"
echo "Downloading J-Link .tgz: $TGZ_URL"
fetch_segger "$TGZ_URL" "$TGZ_FILE"

mkdir -p "$DEST_DIR/SEGGER"
echo "Extracting J-Link into $DEST_DIR/SEGGER ..."
tar -xzf "$TGZ_FILE" -C "$DEST_DIR/SEGGER"
echo "J-Link extracted to $DEST_DIR/SEGGER"

exit 0
