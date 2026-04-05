set -euo pipefail

FILE="${1:-}"      
DEST_DIR="${2:-}"  
TMP_DIR="${3:-}"   

if [[ -n "$FILE" ]]; then
  if command -v apt-get >/dev/null 2>&1; then
    sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y "$FILE"
  elif command -v apt >/dev/null 2>&1; then
    sudo env DEBIAN_FRONTEND=noninteractive apt install -y "$FILE"
  elif command -v dpkg >/dev/null 2>&1; then
    sudo dpkg -i "$FILE"
  else
    echo "ERROR: Unsupported Linux distribution. Neither apt/apt-get nor dpkg is available."
    exit 1
  fi

  INF_DIR=$(find /opt/Tools -maxdepth 1 -type d -name "ModusToolboxProgtools-*" 2>/dev/null | sort -r | head -1)
  if [[ -z "$INF_DIR" ]]; then
    echo "ERROR: Could not find ModusToolboxProgtools installation directory under /opt/Tools."
    exit 1
  fi

  SRC_DIR="$INF_DIR/openocd"
  if [[ ! -d "$SRC_DIR" ]]; then
    echo "ERROR: openocd not found in $INF_DIR"
    exit 1
  fi
  echo "Detected vendor OpenOCD at $SRC_DIR"
fi

exit 0
