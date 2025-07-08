#!/bin/bash
SELECTED_OS="linux"

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

pr_title() {
    local width=40
    local border=$(printf '%*s' "$width" | tr ' ' '-')
    for param in "$@"; do
        # Calculate left padding to center the text
        local text_length=${#param}
        local left_padding=$(((width - text_length) / 2))
        local formatted_text="$(printf '%*s%s' "$left_padding" '' "$param")"
        echo "$border"
        echo "$formatted_text"
        echo "$border"
    done
}

pr_error() {
    local index="$1"
    local message="$2"
    echo "ERROR: $message"
    return $index
}

pr_warn() {
    local message="$1"
    echo "WARN: $message"
}

# Function to display usage information
usage() {
    cat << EOF
Usage: $0 [OPTIONS] <installDir>

OPTIONS:
  -h, --help                Show this help message and exit.

ARGUMENTS:
  installDir                The directory where the packages should be installed. 

DESCRIPTION:
  This script creates a new Python3 virtual environment for SPDX tools
EOF
    exit 1
}

# Parse arguments
while [[ "$#" -gt 0 ]]; do
  case $1 in
    -h | --help)
      usage
      ;;
    *)
      if [[ -z "$INSTALL_DIR" ]]; then
        INSTALL_DIR="$1"
      else
        echo "Unknown option or multiple installDir values: $1"
        usage
      fi
      ;;
  esac
  shift
done

if [[ -z "$INSTALL_DIR" ]]; then
  echo "Missing installDir value"
  usage
fi

if ! command -v python3 &> /dev/null; then
  echo "Missing python3, please install host tools first !"
  exit 1
fi


function install_python_venv() {
    local install_directory=$1

    pr_title "Install SPDX tools"

    python3 -m venv "$install_directory/.venv-spdx"

    if [ -f "$install_directory/.venv-spdx/bin/activate" ]; then
        source "$install_directory/.venv-spdx/bin/activate"
    elif [ -f "$install_directory/.venv-spdx/Scripts/activate" ]; then
        source "$install_directory/.venv-spdx/Scripts/activate"
    else
        echo "ERROR: Cannot find activate script in .venv-spdx" >&2
        return 1
    fi

    python3 -m pip install ntia-conformance-checker \
                         cve-bin-tool \
                         sbom2doc
}

install_python_venv "$INSTALL_DIR"