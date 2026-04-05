set -euo pipefail

FILE="${1:-}"       
DEST_DIR="${2:-}"   
TMP_DIR="${3:-}"    

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
TOOL_NAME="${SCRIPT_NAME%-mac.sh}"
TOOL_DIR="${DEST_DIR}/openocds/${TOOL_NAME}"

mkdir -p "${DEST_DIR}/openocds"

if [[ -n "$FILE" ]]; then
  
  sudo installer -pkg "$FILE" -target /

  INF_DIR=$(find /Applications -maxdepth 1 -type d -name "ModusToolboxProgtools-*" 2>/dev/null | sort -r | head -1)
  if [[ -z "$INF_DIR" ]]; then
    echo "ERROR: Could not find ModusToolboxProgtools installation directory under /Applications."
    exit 1
  fi

  SRC_DIR="$INF_DIR/openocd"
  if [[ ! -d "$SRC_DIR" ]]; then
    echo "ERROR: openocd not found in $INF_DIR"
    exit 1
  fi

  rm -rf "$TOOL_DIR"
  cp -a "$SRC_DIR" "$TOOL_DIR"
fi

exit 0
