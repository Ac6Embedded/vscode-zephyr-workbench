#!/bin/bash
set -euo pipefail

# Arguments
FILE="$1"       # Downloaded archive (.7z)
TOOLS_DIR="$2"  # Base tools directory (e.g., .zinstaller/tools)
TMP_DIR="$3"    # Base temporary directory (e.g., .zinstaller/tmp)

echo "Installing or updating pyOCD..."

# Install or update pyOCD
if pip install -U pyocd; then
    echo "pyOCD installation/update successful."
else
    echo "ERROR: pyOCD installation failed."
    exit 1
fi

# Get the installed version
if pyocd --version >/dev/null 2>&1; then
    VERSION=$(pyocd --version)
    echo "Current pyOCD version: ${VERSION}"
else
    echo "WARNING: Unable to retrieve pyOCD version."
fi

exit 0
