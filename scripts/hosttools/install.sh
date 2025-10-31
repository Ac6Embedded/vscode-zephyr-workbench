#!/bin/bash
BASE_DIR="$HOME/.zinstaller"
SELECTED_OS="linux"

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
YAML_FILE="$SCRIPT_DIR/tools.yml"

# Default values for the options
root_packages=true
non_root_packages=true
check_installed_bool=true
reinstall_venv_bool=false
portable_python=false
INSTALL_DIR=""

zinstaller_version="2.0"
zinstaller_md5=$(md5sum "$BASH_SOURCE")
tools_yml_md5=$(md5sum "$YAML_FILE")

# Function to display usage information
usage() {
    cat << EOF
Usage: $(basename $0) [OPTIONS] [installDir]

OPTIONS:
  -h, --help                Show this help message and exit.
  --only-root               Only install packages that require root privileges.
  --only-without-root       Only install packages that do not require root privileges.
  --only-check              Only check the installation status of the packages without installing them.
  --reinstall-venv          Remove existing virtual environment and create a new one.

ARGUMENTS:
  installDir                The directory where the packages should be installed. 
                            Default is \$HOME/.zinstaller.

DESCRIPTION:
  This script installs host dependencies for Zephyr project on your system.
  By default, it installs all necessary packages.
  If no installDir is specified, the default directory is used.
EOF
}

# Parse arguments
while [[ "$#" -gt 0 ]]; do
  case $1 in
    -h | --help)
      usage
	  exit 0
      ;;
    --only-root)
      non_root_packages=false
      check_installed_bool=false
      ;;
    --only-without-root)
      root_packages=false
      check_installed_bool=false
      ;;
    --only-check)
      root_packages=false
      non_root_packages=false
      ;;
    --reinstall-venv)
      reinstall_venv_bool=true
      root_packages=false
      check_installed_bool=false
      ;;
    *)
      if [[ -z "$INSTALL_DIR" ]]; then
        if [[ "$1" = /* ]]; then
            # $1 is already an absolute path
            INSTALL_DIR="$1/.zinstaller"
        else
            # $1 is a relative path, convert it to an absolute path
            INSTALL_DIR="$(pwd)/$1/.zinstaller"
        fi
      else
        echo "Unknown option or multiple installDir values: $1"
        usage
	    exit 1
      fi
      ;;
  esac
  shift
done

# Check if installDir is provided, otherwise set it to BASE_DIR
if [[ -z "$INSTALL_DIR" ]]; then
    INSTALL_DIR=$BASE_DIR
fi

echo "Installing in $INSTALL_DIR"

TMP_DIR="$INSTALL_DIR/tmp"
MANIFEST_FILE="$TMP_DIR/manifest.sh"
DL_DIR="$TMP_DIR/downloads"
TOOLS_DIR="$INSTALL_DIR/tools"
ENV_FILE="$INSTALL_DIR/env.sh"

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

# Function to download the file and check its SHA-256 hash
download_and_check_hash() {
    local source=$1
    local expected_hash=$2
    local filename=$3

    # Full path where the file will be saved
    local file_path="$DL_DIR/$filename"

    # Download the file using wget
    wget --no-check-certificate -q "$source" -O "$file_path"

    # Check if the download was successful
    if [ ! -f "$file_path" ]; then
        pr_error 1 "Error: Failed to download the file."
        exit 1
    fi

    # Compute the SHA-256 hash of the downloaded file
    local computed_hash=$(sha256sum "$file_path" | awk '{print $1}')

    # Compare the computed hash with the expected hash
    if [ "$computed_hash" == "$expected_hash" ]; then
        echo "DL: $filename downloaded successfully"
    else
        pr_error 2 "Error: Hash mismatch."
        pr_error 2 "Expected: $expected_hash"
        pr_error 2 "Computed: $computed_hash"
        exit 2
    fi
}

# Function to download the file and check its SHA-256 hash
download() {
    local source=$1
    local filename=$2

    # Full path where the file will be saved
    local file_path="$DL_DIR/$filename"

    # Download the file using wget
    wget --no-check-certificate -q "$source" -O "$file_path"

    # Check if the download was successful
    if [ ! -f "$file_path" ]; then
        pr_error 1 "Error: Failed to download the file."
        exit 1
    fi
}

install_python_venv() {
    local install_directory=$1
    local work_directory=$2

    pr_title "Zephyr Python Requirements"

    REQUIREMENTS_DIR="$TMP_DIR/requirements"
    REQUIREMENTS_BASEURL="https://raw.githubusercontent.com/zephyrproject-rtos/zephyr/main/scripts"
    
    mkdir -p "$REQUIREMENTS_DIR"

    download "$REQUIREMENTS_BASEURL/requirements.txt" "requirements.txt"
    download "$REQUIREMENTS_BASEURL/requirements-run-test.txt" "requirements-run-test.txt"
    download "$REQUIREMENTS_BASEURL/requirements-extras.txt" "requirements-extras.txt"
    download "$REQUIREMENTS_BASEURL/requirements-compliance.txt" "requirements-compliance.txt"
    download "$REQUIREMENTS_BASEURL/requirements-build-test.txt" "requirements-build-test.txt"
    download "$REQUIREMENTS_BASEURL/requirements-base.txt" "requirements-base.txt"
    mv "$DL_DIR/requirements.txt" "$REQUIREMENTS_DIR"
    mv "$DL_DIR/requirements-run-test.txt" "$REQUIREMENTS_DIR"
    mv "$DL_DIR/requirements-extras.txt" "$REQUIREMENTS_DIR"
    mv "$DL_DIR/requirements-compliance.txt" "$REQUIREMENTS_DIR"
    mv "$DL_DIR/requirements-build-test.txt" "$REQUIREMENTS_DIR"
    mv "$DL_DIR/requirements-base.txt" "$REQUIREMENTS_DIR"

    python3 -m venv "$install_directory/.venv"
    source "$install_directory/.venv/bin/activate"
    python3 -m pip install setuptools wheel west --quiet
    python3 -m pip install anytree --quiet
    python3 -m pip install -r "$REQUIREMENTS_DIR/requirements.txt" --quiet
    python3 -m pip install puncover --quiet
}

if [[ $root_packages == true ]]; then
    pr_title "Install non portable tools"

    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        case "$ID" in
        ubuntu)
            echo "This is Ubuntu."
            if [ $(lsb_release -rs | awk -F. '{print $1$2}') -ge 2004 ]; then
                echo "Ubuntu version is equal to or higher than 20.04"
            else
                pr_error 3 "Ubuntu version lower than 20.04 are not supported"
                exit 3
            fi
            portable_python=true
            sudo apt-get update
            sudo apt -y install --no-install-recommends git cmake ninja-build gperf ccache dfu-util device-tree-compiler wget python3-dev python3-pip python3-setuptools python3-tk python3-wheel xz-utils file make gcc gcc-multilib g++-multilib libsdl2-dev libmagic1 unzip
            ;;
        fedora)
            echo "This is Fedora."
            portable_python=false
            sudo dnf upgrade -y
            sudo dnf group install -y "Development Tools" "C Development Tools and Libraries"
            sudo dnf install -y cmake ninja-build gperf dfu-util dtc wget which python3-pip python3-tkinter xz file python3-devel SDL2-devel
            ;;
        clear-linux-os)
            echo "This is Clear Linux."
            portable_python=false
            sudo swupd update
            sudo swupd bundle-add c-basic dev-utils dfu-util dtc os-core-dev python-basic python3-basic python3-tcl
            ;;
        arch)
            echo "This is Arch Linux."
            portable_python=false
            sudo pacman -Syu --noconfirm
            sudo pacman -S --noconfirm git cmake ninja gperf ccache dfu-util dtc wget python-pip python-setuptools python-wheel tk xz file make
            ;;
        *)
            pr_error 3 "Distribution is not recognized."
            exit 3
            ;;
        esac
        else
        pr_error 3 "/etc/os-release file not found. Cannot determine distribution."
        exit 3
    fi
fi

if [[ $non_root_packages == true ]]; then
    mkdir -p "$TMP_DIR"
    mkdir -p "$DL_DIR"
    mkdir -p "$TOOLS_DIR"

    pr_title "YQ"
    YQ_FILENAME="yq"
    YQ_SOURCE=$(grep -A 10 'tool: yq' $YAML_FILE | grep -A 2 "$SELECTED_OS:" | grep 'source' | awk -F": " '{print $2}')
    YQ_SHA256=$(grep -A 10 'tool: yq' $YAML_FILE | grep -A 2 "$SELECTED_OS:" | grep 'sha256' | awk -F": " '{print $2}')

    # Download and verify
    download_and_check_hash "$YQ_SOURCE" "$YQ_SHA256" "$YQ_FILENAME"

    # Install it permanently in tools/yq/
    mkdir -p "$TOOLS_DIR/yq"
    mv "$DL_DIR/$YQ_FILENAME" "$TOOLS_DIR/yq/yq"
    chmod +x "$TOOLS_DIR/yq/yq"

    # Update variable for later usage
    YQ="$TOOLS_DIR/yq/yq"

    # Start generating the manifest file
    echo "#!/bin/bash" > $MANIFEST_FILE

    # Function to generate array entries if the tool supports the specified OS
    function generate_manifest_entries {
        local tool=$1
        local SELECTED_OS=$2

        # Using yq to parse the source and sha256 for the specific OS and tool
        source=$($YQ eval ".*_content[] | select(.tool == \"$tool\") | .os.$SELECTED_OS.source" $YAML_FILE)
        sha256=$($YQ eval ".*_content[] | select(.tool == \"$tool\") | .os.$SELECTED_OS.sha256" $YAML_FILE)

        # Check if the source and sha256 are not null (meaning the tool supports the OS)
        if [ "$source" != "null" ] && [ "$sha256" != "null" ]; then
            echo "declare -A ${tool}=()" >> $MANIFEST_FILE
            echo "${tool}[source]=\"$source\"" >> $MANIFEST_FILE
            echo "${tool}[sha256]=\"$sha256\"" >> $MANIFEST_FILE
        fi
    }

    pr_title "Parse YAML and generate manifest"

    # List all tools from the YAML file
    tools=$($YQ eval '.*_content[].tool' $YAML_FILE)

    # Loop through each tool and generate the entries
    for tool in $tools; do
        generate_manifest_entries $tool $SELECTED_OS
    done

    source $MANIFEST_FILE

    if [[ $reinstall_venv_bool == true ]]; then
      pr_title "Reinstalling Python VENV"
      if [ -d "$INSTALL_DIR/.venv" ]; then
        rm -rf "$INSTALL_DIR/.venv"
      fi
      # Prefer portable Python in tools if present; otherwise rely on system python3
      TOOLS_PY=$(find "$INSTALL_DIR/tools" -maxdepth 2 -type f -name python3 2>/dev/null | head -n 1)
      if [[ -x "$TOOLS_PY" ]]; then
        export PATH="$(dirname "$TOOLS_PY"):$PATH"
      fi
      install_python_venv "$INSTALL_DIR" "$TMP_DIR"
      rm -rf "$TMP_DIR"
      exit 0
    fi

	if [ $portable_python = true ]; then
        openssl_lib_bool=true
        if [ $openssl_lib_bool = true ]; then
        pr_title "OpenSSL"
        OPENSSL_FOLDER_NAME="openssl-1.1.1t"
        OPENSSL_ARCHIVE_NAME="${OPENSSL_FOLDER_NAME}.tar.bz2"
        download_and_check_hash ${openssl[source]} ${openssl[sha256]} "$OPENSSL_ARCHIVE_NAME"
        tar xf "$DL_DIR/$OPENSSL_ARCHIVE_NAME" -C "$TOOLS_DIR"
        openssl_path="$INSTALL_DIR/tools/$OPENSSL_FOLDER_NAME/usr/local/bin"
        openssl_lib_path="$INSTALL_DIR/tools/$OPENSSL_FOLDER_NAME/usr/local/lib"
        export LD_LIBRARY_PATH="$openssl_lib_path:$LD_LIBRARY_PATH"
        export PATH="$openssl_path:$PATH"
        fi

        pr_title "Python"
        PYTHON_FOLDER_NAME="3.13.5"
        PYTHON_ARCHIVE_NAME="cpython-${PYTHON_FOLDER_NAME}-linux-x86_64.tar.gz"
        download_and_check_hash ${python_portable[source]} ${python_portable[sha256]} "$PYTHON_ARCHIVE_NAME"
        tar xf "$DL_DIR/$PYTHON_ARCHIVE_NAME" -C "$TOOLS_DIR"
        python_path="$INSTALL_DIR/tools/$PYTHON_FOLDER_NAME/bin"
        export PATH="$python_path:$PATH"
    fi

    pr_title "Ninja"
    NINJA_ARCHIVE_NAME="ninja-linux.zip"
    download_and_check_hash ${ninja[source]} ${ninja[sha256]} "$NINJA_ARCHIVE_NAME"
    mkdir -p "$TOOLS_DIR/ninja"
    unzip -o "$DL_DIR/$NINJA_ARCHIVE_NAME" -d "$TOOLS_DIR/ninja"

    pr_title "CMake"
    CMAKE_FOLDER_NAME="cmake-3.29.2-linux-x86_64"
    CMAKE_ARCHIVE_NAME="${CMAKE_FOLDER_NAME}.tar.gz"
    download_and_check_hash ${cmake[source]} ${cmake[sha256]} "$CMAKE_ARCHIVE_NAME"
    tar xf "$DL_DIR/$CMAKE_ARCHIVE_NAME" -C "$TOOLS_DIR"
	
    cmake_path="$INSTALL_DIR/tools/$CMAKE_FOLDER_NAME/bin"
    ninja_path="$INSTALL_DIR/tools/ninja"
    
    export PATH="$ninja_path:$cmake_path:/usr/local/bin:$PATH"
    
    pr_title "Python VENV"
    install_python_venv "$INSTALL_DIR" "$TMP_DIR"

    if ! command -v west &> /dev/null; then
    echo "West is not available. Something is wrong !!"
    else
    echo "West is available."
    fi

    env_script() {
    cat << 'EOF'
#!/bin/bash
# --- Resolve the directory this script lives in ---
if [ -n "${BASH_SOURCE-}" ]; then
    _src="${BASH_SOURCE[0]}"
elif [ -n "${ZSH_VERSION-}" ]; then
    _src="${(%):-%N}"
else
    _src="$0"
fi
base_dir="$(cd -- "$(dirname -- "${_src}")" && pwd -P)"
tools_dir="$base_dir/tools"
YAML_FILE="$base_dir/env.yml"
PY_FILE="$base_dir/env.py"

[[ ! -f "$YAML_FILE" ]] && { echo "[ERROR] File not found: $YAML_FILE" >&2; exit 1; }

GLOBAL_VENV_PATH=""

# --- Helper: Trim spaces without xargs ---
trim() {
    local var="$1"
    var="${var#"${var%%[![:space:]]*}"}"
    var="${var%"${var##*[![:space:]]}"}"
    echo "$var"
}

# --- Parse env.yml ---
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [[ -z "$line" || "$line" =~ ^# ]] && continue
  if [[ "$line" =~ ^global_venv_path: ]]; then
    venv="${line#global_venv_path:}"
    venv="${venv//\"/}"
    venv="$(trim "$venv")"
    GLOBAL_VENV_PATH="$venv"
  fi
done < "$YAML_FILE"

# --- Activate Python virtual environment if available ---
default_venv_activate_path="$GLOBAL_VENV_PATH/bin/activate"
[[ -n "$PYTHON_VENV_ACTIVATE_PATH" ]] && venv_activate_path="$PYTHON_VENV_ACTIVATE_PATH" || venv_activate_path="$default_venv_activate_path"

if [[ -f "$venv_activate_path" ]]; then
    source "$venv_activate_path" >/dev/null 2>&1
else
    echo "[ERROR] Virtual environment activation script not found: $venv_activate_path" >&2
fi

# --- Run env.py to load environment variables and paths ---
if [[ -f "$PY_FILE" ]]; then
    # We tell env.py to output in POSIX shell mode
    eval "$(python "$PY_FILE" --shell=sh)"
else
    echo "[ERROR] Python environment loader not found: $PY_FILE" >&2
fi

EOF
}

    env_script > $ENV_FILE
	
	# --------------------------------------------------------------------------
	# Create environment manifest (env.yml)
	# --------------------------------------------------------------------------

	ENV_YAML_PATH="$INSTALL_DIR/env.yml"
	
	cat << EOF > "$ENV_YAML_PATH"
# env.yaml
# ZInstaller Workspace Environment Manifest
# Defines workspace tools and Python environment metadata for Zephyr Workbench

global:
  version: "$zinstaller_version"
  description: "Host tools configuration for Zephyr Workbench (Linux)"

# Any variable here will be added as environment variables
env:
  zi_base_dir: "$INSTALL_DIR"
  zi_tools_dir: "\${zi_base_dir}/tools"
EOF

if [ $openssl_lib_bool = true ]; then
	cat << EOF >> "$ENV_YAML_PATH"
  LD_LIBRARY_PATH: "$openssl_path/usr/local/lib:\$LD_LIBRARY_PATH"
EOF

fi
cat << EOF >> "$ENV_YAML_PATH"
tools:
  cmake:
    path: "\${zi_tools_dir}/$CMAKE_FOLDER_NAME/bin"
    version: "3.29.2"
    do_not_use: false

  ninja:
    path: "\${zi_tools_dir}/ninja"
    version: "1.12.1"
    do_not_use: false
EOF

if [ "$portable_python" = true ]; then
	# Detect the installed Python version (from system or portable)
	if command -v python3 >/dev/null 2>&1; then
		PYTHON_VERSION=$(python3 --version 2>&1 | grep -oP 'Python \K[^\s]+')
	else
		PYTHON_VERSION=""
	fi
	
if [ "$portable_python" = true ]; then
	cat << EOF >> "$ENV_YAML_PATH"

  python:
    path:
      - "\${zi_base_dir}/$PYTHON_FOLDER_NAME/bin"
    version: "$PYTHON_VERSION"
    do_not_use: false
EOF
fi

	cat << EOF >> "$ENV_YAML_PATH"

  openssl:
    path: "\${zi_tools_dir}/$OPENSSL_FOLDER_NAME/usr/local/bin"
    version: "1.1.1t"
    do_not_use: false

python:
  global_venv_path: "$INSTALL_DIR/.venv"

EOF
else
	cat << EOF >> "$ENV_YAML_PATH"

python:
  global_venv_path: "$INSTALL_DIR/.venv"

EOF
fi

echo "Created environment manifest: $ENV_YAML_PATH"

	# --------------------------------------------------------------------------
	# Create python script to parse environement yml (env.py)
	# --------------------------------------------------------------------------

	ENV_PY_PATH="$INSTALL_DIR/env.py"
	
	cat << 'EOF' > "$ENV_PY_PATH"
#!/usr/bin/env python3
"""
env.py - Parse env.yaml and output environment setup commands
for PowerShell, CMD (.bat), or POSIX shells (Bash, Zsh, etc.)

Features:
  - Cross-platform: Windows, Linux, macOS, WSL, MSYS2, Cygwin
  - Converts Windows paths to Unix-style under WSL/MSYS2/Cygwin
  - Expands ${VAR}, * and ? wildcards
  - Sets both $env:VAR and $VAR in PowerShell
  - Prepends project paths; appends auto-detect paths
"""

import os
import sys
import yaml
import re
import platform
import glob


# -----------------------------
# YAML parsing helpers
# -----------------------------
def load_yaml(path):
    """Load YAML safely."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f)
    except Exception as e:
        sys.stderr.write(f"Error reading {path}: {e}\n")
        sys.exit(1)


def expand_vars(value, env_vars):
    """Expand ${var} using YAML env vars or system env."""
    if not isinstance(value, str):
        return value
    pattern = re.compile(r"\$\{([^}]+)\}")
    return pattern.sub(lambda m: env_vars.get(m.group(1), os.environ.get(m.group(1), m.group(0))), value)


# -----------------------------
# Environment detection and path conversion
# -----------------------------
def detect_env_type():
    """Detect whether running under MSYS2, Cygwin, or WSL (quiet and safe)."""
    env = os.environ
    if "MSYSTEM" in env:
        return "MSYS2"
    if "CYGWIN" in env.get("OSTYPE", "").upper() or "CYGWIN" in env.get("TERM", "").upper():
        return "CYGWIN"
    if "WSL_DISTRO_NAME" in env or "WSL_INTEROP" in env:
        return "WSL"
    if platform.system() != "Windows":
        return "POSIX"

    try:
        with os.popen("uname -s 2>/dev/null") as proc:
            uname = proc.read().strip().upper()
        if "CYGWIN" in uname:
            return "CYGWIN"
        if "MINGW" in uname or "MSYS" in uname:
            return "MSYS2"
        if "LINUX" in uname:
            with open("/proc/version", "r", encoding="utf-8") as f:
                if "MICROSOFT" in f.read().upper():
                    return "WSL"
    except Exception:
        pass

    return "WINDOWS"


def detect_platform():
    """Return simplified platform key for auto-detect section."""
    system = platform.system().lower()
    if "windows" in system:
        return "windows"
    if "darwin" in system or "mac" in system:
        return "darwin"
    if "linux" in system:
        return "linux"
    return "unknown"


def to_unix_path(path: str, env_type: str = None) -> str:
    """Convert Windows paths to Unix-style; keep POSIX unchanged."""
    if not path:
        return path
    if platform.system() != "Windows":
        return path.replace("\\", "/")

    env_type = env_type or detect_env_type()
    norm = path.replace("\\", "/")

    if len(norm) >= 2 and norm[1] == ":":
        drive = norm[0].lower()
        rest = norm[2:]
        if env_type == "WSL":
            norm = f"/mnt/{drive}{rest}"
        else:  # MSYS2 / Cygwin
            norm = f"/{drive}{rest}"

    return norm


# -----------------------------
# Data collection from YAML
# -----------------------------
def collect_paths(data, env_vars):
    """Collect active paths from tools, runners, other, and auto-detect."""
    paths = []
    autodetect_paths = []

    def add_path(val, target_list):
        """Expand variables, wildcards, and append to target list."""
        if isinstance(val, list):
            for p in val:
                add_path(p, target_list)
            return

        expanded_value = expand_vars(val, env_vars)
        if not isinstance(expanded_value, str):
            return

        # Expand * and ? wildcards (glob)
        if "*" in expanded_value or "?" in expanded_value:
            matches = sorted(glob.glob(expanded_value), reverse=True)
            if matches:
                target_list.extend(matches)
            else:
                target_list.append(expanded_value)  # keep literal if no match
        else:
            target_list.append(expanded_value)

    # Tools
    for t in data.get("tools", {}).values():
        if isinstance(t, dict) and not t.get("do_not_use", False):
            add_path(t.get("path"), paths)

    # Runners
    for r in data.get("runners", {}).values():
        if isinstance(r, dict) and not r.get("do_not_use", False):
            add_path(r.get("path"), paths)

    # Other
    for o in data.get("other", {}).values():
        if isinstance(o, dict):
            add_path(o.get("path"), paths)

    # --- Auto-detect section ---
    ad = data.get("auto-detect", {})
    if isinstance(ad, dict):
        platform_key = detect_platform()
        for name, group in ad.items():
            if isinstance(group, dict):
                os_paths = group.get(platform_key)
                if os_paths:
                    add_path(os_paths, autodetect_paths)

    return paths, autodetect_paths


# -----------------------------
# Shell detection and output emitters
# -----------------------------
def detect_shell():
    """Detect or override the target shell."""
    for arg in sys.argv:
        if arg.startswith("--shell="):
            return arg.split("=", 1)[1].lower()

    if platform.system() != "Windows":
        return "sh"

    parent_proc = os.environ.get("ComSpec", "").lower()
    if "cmd.exe" in parent_proc:
        return "cmd"

    if os.environ.get("PSExecutionPolicyPreference") or os.environ.get("PSModulePath"):
        return "powershell"

    return "powershell"


def output_powershell(env_vars, paths, autodetect_paths):
    """Emit PowerShell commands (prepends normal paths, appends autodetect)."""
    for k, v in env_vars.items():
        expanded = expand_vars(v, env_vars)
        print(f"$env:{k} = \"{expanded}\"")
        print(f"${k} = \"{expanded}\"")

    # Prepend normal paths
    for p in paths:
        norm = os.path.normpath(p)
        print(f"$env:PATH = \"{norm};$env:PATH\"")

    # Append autodetect paths
    for p in autodetect_paths:
        norm = os.path.normpath(p)
        print(f"$env:PATH = \"$env:PATH;{norm}\"")

    print("Write-Output 'Environment variables and paths loaded from env.yml.'")


def output_cmd(env_vars, paths, autodetect_paths):
    """Emit CMD-compatible commands."""
    for k, v in env_vars.items():
        expanded = expand_vars(v, env_vars)
        print(f"set \"{k}={expanded}\"")

    # Prepend normal paths
    for p in paths:
        norm = os.path.normpath(p)
        print(f"set \"PATH={norm};%PATH%\"")

    # Append autodetect paths
    for p in autodetect_paths:
        norm = os.path.normpath(p)
        print(f"set \"PATH=%PATH%;{norm}\"")

    print("echo Environment variables and paths loaded from env.yml.")


def output_sh(env_vars, paths, autodetect_paths):
    """Emit Bash/Zsh-compatible exports with Unix-style paths (fast)."""
    env_type = detect_env_type()

    for k, v in env_vars.items():
        expanded = expand_vars(v, env_vars)
        expanded = to_unix_path(expanded, env_type)
        print(f"export {k}='{expanded}'")

    # Prepend normal paths
    for p in paths:
        norm = to_unix_path(os.path.normpath(p), env_type)
        print(f"export PATH=\"{norm}:${{PATH:+$PATH:}}\"")

    # Append autodetect paths
    for p in autodetect_paths:
        norm = to_unix_path(os.path.normpath(p), env_type)
        print(f"export PATH=\"${{PATH:+$PATH:}}{norm}\"")

    print("echo Environment variables and paths loaded from env.yml.")


# -----------------------------
# Main entry point
# -----------------------------
def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    yaml_path = os.path.join(base_dir, "env.yaml")
    if not os.path.exists(yaml_path):
        yaml_path = os.path.join(base_dir, "env.yml")
    if not os.path.exists(yaml_path):
        sys.stderr.write("Error: env.yaml or env.yml not found.\n")
        sys.exit(1)

    data = load_yaml(yaml_path)
    env_vars = data.get("env", {})
    paths, autodetect_paths = collect_paths(data, env_vars)

    shell = detect_shell()
    if shell == "powershell":
        output_powershell(env_vars, paths, autodetect_paths)
    elif shell == "cmd":
        output_cmd(env_vars, paths, autodetect_paths)
    else:
        output_sh(env_vars, paths, autodetect_paths)


if __name__ == "__main__":
    main()

EOF

    echo "Created py script to parse yml: $ENV_PY_PATH"

    cat <<EOF > "$INSTALL_DIR/zinstaller_version"
Script Version: $zinstaller_version
Script MD5: $zinstaller_md5
tools.yml MD5: $tools_yml_md5
EOF
    echo "Source me: . $ENV_FILE"
    
    pr_title "Clean up"
    rm -rf $TMP_DIR
fi

# Function to check if a package is installed and print the version
check_package() {
	local package=$1
	local version_command
	local version

	case $package in
		python) version_command="python3 --version 2>&1" ;;
		cmake) version_command="cmake --version 2>&1 | head -n 1" ;;
		ninja) version_command="ninja --version 2>&1" ;;
		openssl) version_command="openssl version 2>&1" ;;
		git) version_command="git --version 2>&1" ;;
		gperf) version_command="gperf --version 2>&1 | head -n 1" ;;
		ccache) version_command="ccache --version 2>&1 | head -n 1" ;;
		dfu-util) version_command="dfu-util --version 2>&1 | head -n 1" ;;
		wget) version_command="wget --version 2>&1 | head -n 1" ;;
		xz-utils) version_command="xz --version 2>&1 | head -n 1" ;;
		file) version_command="file --version 2>&1 | head -n 1" ;;
		make) version_command="make --version 2>&1 | head -n 1" ;;
		*) echo "$package [NOT INSTALLED]" && return 1 ;;
	esac

	version=$(eval $version_command)

	if [[ $? -ne 0 || -z $version ]]; then
		echo "$package [NOT INSTALLED]"
		return 1
	else
		# Extract version number or short relevant info
		case $package in
			python) version=$(echo "$version" | grep -oP 'Python \K[^\s]+') ;;
			cmake) version=$(echo "$version" | grep -oP 'cmake version \K[^\s]+') ;;
			ninja) version=$(echo "$version") ;;
			openssl) version=$(echo "$version" | grep -oP 'OpenSSL \K[^\s]+') ;;
			git) version=$(echo "$version" | grep -oP 'git version \K[^\s]+') ;;
			gperf) version=$(echo "$version" | grep -oP 'GNU gperf \K[^\s]+') ;;
			ccache) version=$(echo "$version" | grep -oP 'ccache version \K[^\s]+') ;;
			dfu-util) version=$(echo "$version" | grep -oP 'dfu-util \K[^\s]+') ;;
			wget) version=$(echo "$version" | grep -oP 'GNU Wget \K[^\s]+') ;;
			xz-utils) version=$(echo "$version" | grep -oP 'xz \(XZ Utils\) \K[^\s]+') ;;
			file) version=$(echo "$version" | grep -oP 'file-\K[^\s]+') ;;
			make) version=$(echo "$version" | grep -oP 'GNU Make \K[^\s]+') ;;
		esac
		echo "$package [$version]"
		return 0
	fi
}


check_packages() {
    # Default list of packages to check if no argument is passed
    default_packages=(
        python
        cmake
        ninja
        openssl
        git
        gperf
        ccache
        dfu-util
        wget
        xz-utils
        file
        make
    )

    # Use provided packages if any, otherwise use the default list
    if [ $# -gt 0 ]; then
        packages=($@)
    else
        packages=("${default_packages[@]}")
    fi

    # Initialize a counter for missing packages
    missing_count=0

    # Loop through each package and check if it is installed
    for pkg in "${packages[@]}"; do
        check_package $pkg || missing_count=$((missing_count + 1))
    done

    # Return minus the number of missing packages, or 0 if none are missing
    if [ $missing_count -gt 0 ]; then
        return -$missing_count
    else
        return 0
    fi
}

if [[ $check_installed_bool == true ]]; then
    pr_title "Check Installed Packages"

    check_packages

    RETURN_CODE=$?

    if [ $RETURN_CODE -eq 0 ]; then
    echo "All specified packages are installed."
    else
        MISSING_PACKAGES=$(( -RETURN_CODE ))
        pr_error $RETURN_CODE "$MISSING_PACKAGES package(s) are not installed."
    fi

    exit $RETURN_CODE
fi
