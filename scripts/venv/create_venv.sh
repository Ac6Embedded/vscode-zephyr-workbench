#!/bin/bash
set -e

SELECTED_OS="linux"

# Resolve the directory of this script
SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

# --- Utility Functions ---

pr_title() {
    local width=40
    local border
    border=$(printf '%*s' "$width" | tr ' ' '-')
    for param in "$@"; do
        local text_length=${#param}
        local left_padding=$(((width - text_length) / 2))
        local formatted_text
        formatted_text="$(printf '%*s%s' "$left_padding" '' "$param")"
        echo "$border"
        echo "$formatted_text"
        echo "$border"
    done
}

pr_error() {
    local index="$1"
    local message="$2"
    echo "ERROR: $message" >&2
    exit "$index"
}

usage() {
    cat << EOF
Usage: $0 [OPTIONS] <installDir>

OPTIONS:
  -h, --help        Show this help message and exit.

ARGUMENTS:
  installDir        Directory where Zephyr environment will be installed.

DESCRIPTION:
  This script creates a Python3 virtual environment for Zephyr's build system.
EOF
    exit 1
}

# --- Parse Arguments ---
while [[ "$#" -gt 0 ]]; do
  case $1 in
    -h | --help)
      usage
      ;;
    *)
      if [[ -z "$INSTALL_DIR" ]]; then
        INSTALL_DIR="$1"
      else
        echo "Unknown or multiple installDir values: $1"
        usage
      fi
      ;;
  esac
  shift
done

if [[ -z "$INSTALL_DIR" ]]; then
  echo "Missing installDir argument"
  usage
fi

TMP_DIR="$INSTALL_DIR/.zinstaller"
DL_DIR="$TMP_DIR/downloads"
REQ_DIR="$TMP_DIR/requirements"

mkdir -p "$TMP_DIR" "$DL_DIR" "$REQ_DIR"

# --- Check dependencies ---
if ! command -v python3 &> /dev/null; then
  pr_error 1 "Missing python3 — please install Python 3 first."
fi

if ! command -v wget &> /dev/null; then
  pr_error 1 "Missing wget — please install wget first."
fi

# --- Helper for downloading files ---
download() {
    local source=$1
    local filename=$2
    local dest="$DL_DIR/$filename"

    echo "Downloading: $filename"
    wget --no-check-certificate -q "$source" -O "$dest"

    if [[ ! -f "$dest" ]]; then
        pr_error 1 "Download failed: $source"
    fi
}

# --- Python venv installer ---
install_python_venv() {
    local install_dir=$1

    pr_title "Zephyr Python Environment Setup"

    local requirements_baseurl="https://raw.githubusercontent.com/zephyrproject-rtos/zephyr/main/scripts"

    # Download Zephyr's Python requirement files
    local req_files=(
        "requirements.txt"
        "requirements-run-test.txt"
        "requirements-extras.txt"
        "requirements-compliance.txt"
        "requirements-build-test.txt"
        "requirements-base.txt"
    )

    for f in "${req_files[@]}"; do
        download "$requirements_baseurl/$f" "$f"
        mv "$DL_DIR/$f" "$REQ_DIR/"
    done

    echo "Creating Python virtual environment in $install_dir/.venv ..."
    python3 -m venv "$install_dir/.venv"

    echo "Activating virtual environment..."
    # shellcheck disable=SC1091
    source "$install_dir/.venv/bin/activate"

    echo "Installing Python dependencies..."
    python3 -m pip install --upgrade pip setuptools wheel yaml
    python3 -m pip install west pyelftools anytree puncover
    python3 -m pip install -r "$REQ_DIR/requirements.txt"

    echo "Python virtual environment setup complete."
}

# --- Main Execution ---
pr_title "Zephyr Environment Setup"

install_python_venv "$INSTALL_DIR"

echo "Cleaning up temporary files..."
rm -rf "$TMP_DIR"

pr_title "Setup Complete"
echo "Zephyr Python environment installed successfully in: $INSTALL_DIR"
