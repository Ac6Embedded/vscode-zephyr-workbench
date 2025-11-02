#!/bin/bash
# Generic macOS wrapper for tool installers
# Calls the base script (same name without '-mac') with all arguments.
# Example: pyocd-mac.sh → calls pyocd.sh

set -euo pipefail

# Get this script's directory
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"

# Derive the base script name by removing '-mac' from filename
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
BASE_SCRIPT="${SCRIPT_NAME/-mac/}"

# Call the base script, passing all arguments
bash "$SCRIPT_DIR/$BASE_SCRIPT" "$@"
