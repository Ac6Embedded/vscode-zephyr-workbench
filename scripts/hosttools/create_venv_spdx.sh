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
  hostToolsDir              Folder that may contain tools/python/python.

DESCRIPTION:
  This script creates a new Python3 virtual environment for SPDX tools
EOF
    exit 1
}

# Parse arguments
while [[ "$#" -gt 0 ]]; do
  case $1 in
    -h | --help) usage ;;
    *)
      if   [[ -z "$INSTALL_DIR"    ]]; then INSTALL_DIR="$1"
      elif [[ -z "$HOST_TOOLS_DIR" ]]; then HOST_TOOLS_DIR="$1"
      else echo "Unknown option or too many values: $1"; usage
      fi
      ;;
  esac
  shift
done

if [[ -z "$INSTALL_DIR" ]]; then
  echo "Missing installDir value"
  usage
fi

if [[ -z "$HOST_TOOLS_DIR" ]]; then
  echo "Missing hostToolsDir value"
  usage
fi

if [[ -x "${HOST_TOOLS_DIR}/tools/3.13.5/bin/python" ]]; then
  PYTHON_BIN="${HOST_TOOLS_DIR}/tools/3.13.5/bin/python"
  echo found python interpreter in "${HOST_TOOLS_DIR}/tools/3.13.5/bin/python"
elif [[ -x "${HOST_TOOLS_DIR}/tools/python/python/python.exe" ]]; then
  PYTHON_BIN="${HOST_TOOLS_DIR}/tools/python/python/python.exe"
  echo "found python interpreter in ${HOST_TOOLS_DIR}/tools/python/python/python.exe"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3)"
  echo found python3 interpreter on PATH
elif command -v python  >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python)"
  echo found python interpreter on PATH
else
  echo "ERROR: No Python interpreter found in \"${HOST_TOOLS_DIR}/tools/python\" or on PATH." >&2
  exit 1
fi

[[ "${PYTHON_BIN##*.}" == "exe" ]] && USE_DIRECT_VENV_PY=1 || USE_DIRECT_VENV_PY=0


install_python_venv() {
    local install_dir=$1
    local venv_dir="$install_dir/.venv-spdx"

    pr_title "Install SPDX tools"

    "$PYTHON_BIN" -m venv "$venv_dir" || {
        echo "ERROR: venv creation failed" >&2
        return 1
    }

    if (( USE_DIRECT_VENV_PY )); then
        local venv_py="$venv_dir/Scripts/python.exe"

        "$venv_py" -m pip install --upgrade pip
        "$venv_py" -m pip install ntia-conformance-checker \
                                 cve-bin-tool \
                                 sbom2doc

    else
        if   [[ -f "$venv_dir/bin/activate"   ]]; then
            source "$venv_dir/bin/activate"
        else
            echo "ERROR: Cannot find activate script in $venv_dir" >&2
            return 1
        fi

        python3 -m pip install --upgrade pip
        python3 -m pip install ntia-conformance-checker \
                               cve-bin-tool \
                               sbom2doc
    fi
}

install_python_venv "$INSTALL_DIR"