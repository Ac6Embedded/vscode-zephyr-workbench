#!/bin/bash
set -euo pipefail

FILE="${1:-}"       # Path to the downloaded archive
DEST_DIR="${2:-}"   # Main tools directory (.zinstaller/tools)
TMP_DIR="${3:-}"    # Temporary directory

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
TOOL_NAME="${SCRIPT_NAME%-mac.sh}"
TOOL_NAME="${TOOL_NAME%.sh}"
TOOL_DIR="${DEST_DIR}/openocds/${TOOL_NAME}"

mkdir -p "${DEST_DIR}/openocds"

WORK_DIR="$(mktemp -d)"
if [[ -n "$FILE" ]]; then
  tar -xf "$FILE" -C "$WORK_DIR"

  mapfile -t TOP_DIRS < <(find "$WORK_DIR" -mindepth 1 -maxdepth 1 -type d)
  SRC_DIR=""

  if [[ ${#TOP_DIRS[@]} -eq 1 ]]; then
    SRC_DIR="${TOP_DIRS[0]}"
  elif [[ -d "$WORK_DIR/openocd" ]]; then
    SRC_DIR="$WORK_DIR/openocd"
  fi

  rm -rf "$TOOL_DIR"
  if [[ -n "$SRC_DIR" ]]; then
    mv "$SRC_DIR" "$TOOL_DIR"
  else
    mkdir -p "$TOOL_DIR"
    cp -a "$WORK_DIR/." "$TOOL_DIR/"
  fi
fi

rm -rf "$WORK_DIR"
exit 0
