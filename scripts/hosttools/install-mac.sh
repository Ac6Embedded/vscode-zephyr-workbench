#!/bin/bash
# NOTE: this script must stay compatible with the stock macOS bash 3.2:
# no associative arrays, no mapfile/readarray, no ${var,,} expansions.
BASE_DIR="$HOME/.zinstaller"
SELECTED_OS="darwin"

# Download mirror used when a primary download fails or its checksum
# mismatches. Files are stored content-addressed as
# <MIRROR_BASE_URL>/<sha256-lowercase> (bare hash, no filename).
# Override with --mirror-base-url or the ZW_MIRROR_BASE_URL environment
# variable; an empty value disables the fallback.
MIRROR_BASE_URL_DEFAULT="https://www.ac6-tools.com/downloads/zephyr-workbench/mirror/hosttools"
MIRROR_BASE_URL="${ZW_MIRROR_BASE_URL-$MIRROR_BASE_URL_DEFAULT}"

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
YAML_FILE="$SCRIPT_DIR/tools.yml"

# Default values for the options
non_root_packages=true
check_installed_bool=true
only_check_bool=false
reinstall_venv_bool=false
create_venv_bool=false
engine_selftest_bool=false
selftest_env_merge_bool=false
INSTALL_DIR=""
VENV_PATH=""

# Selective install: empty means full install. Values come from --tools and
# must belong to SELECTABLE_STEPS.
SELECTED_TOOLS_RAW=""
SELECTED_TOOLS=""
SELECTABLE_STEPS="cmake ninja gperf dtc git utilities python venv"
INFRA_STEPS=""
INFRA_NEEDED=true

# Python source: brew (default, python@$PYTHON_VERSION formula), system
# (python3 from PATH) or custom (--python-exe-path).
PYTHON_MODE="brew"
PYTHON_MODE_EFFECTIVE=""
use_system_python_bool=false
PYTHON_EXE_PATH=""
CUSTOM_PYTHON_EXE=""
CUSTOM_PYTHON_DIR=""

# Zephyr git ref used for the Python requirements files. An explicit
# --requirements-ref beats ZEPHYR_BASE.
REQUIREMENTS_REF=""
REQUIREMENTS_REF_VALUE="main"

# Track if the selected Python is too old for Zephyr
PYTHON_TOO_OLD=false
PYTHON_MIN_MAJOR=3
PYTHON_MIN_MINOR=12
PYTHON_MIN_VERSION="${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR}"

zinstaller_version="2.0"
zinstaller_md5=$(md5 -q "$BASH_SOURCE" 2>/dev/null || md5sum "$BASH_SOURCE" 2>/dev/null)
tools_yml_md5=$(md5 -q "$YAML_FILE" 2>/dev/null || md5sum "$YAML_FILE" 2>/dev/null)

PYTHON_VERSION="3.13"
NL=$'\n'

# Function to display usage information
usage() {
    cat << EOF
Usage: $(basename $0) [OPTIONS] [installDir]

OPTIONS:
  -h, --help                Show this help message and exit.
  --only-root               Only install packages that require root privileges.
  --only-check              Only check the installation status of the packages without installing them.
  --reinstall-venv          Remove existing virtual environment and create a new one.
  --create-venv             Create a Python virtual environment and install requirements, then exit.
  --venv-path <path>        Override venv location (default: <installDir>/.venv)
  --tools <a,b,...>         Install only the listed parts. Valid values:
                            cmake, ninja, gperf, dtc, git, utilities, python, venv.
                            Everything else is skipped; environment files are
                            always regenerated.
  --use-system-python       Use the python3 found on PATH instead of the
                            Homebrew formula.
  --python-exe-path <path>  Use a specific python executable (or a folder
                            containing python3/python).
  --requirements-ref <ref>  Zephyr git ref (tag or branch) used to fetch the
                            Python requirements files (default: main).
  --mirror-base-url <url>   Override the download mirror used when a primary download
                            fails or mismatches (default: Ac6 mirror). An empty value
                            disables the mirror fallback.

ARGUMENTS:
  installDir                The directory where the packages should be installed.
                            Default is \$HOME/.zinstaller.

DESCRIPTION:
  This script installs host dependencies for Zephyr project on your system.
  Everything installs through Homebrew. If no installDir is specified, the
  default directory is used.
  A failing package never stops the run: each step is recorded and reported
  in the final summary, and the script exits non-zero when something failed
  or a selected part could not be installed.
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
    --only-check)
      non_root_packages=false
      only_check_bool=true
      ;;
    --reinstall-venv)
      reinstall_venv_bool=true
      check_installed_bool=false
      ;;
    --create-venv)
      create_venv_bool=true
      check_installed_bool=false
      ;;
    --venv-path)
      shift
      VENV_PATH="$1"
      ;;
    --tools)
      shift
      SELECTED_TOOLS_RAW="$1"
      ;;
    --use-system-python)
      use_system_python_bool=true
      ;;
    --python-exe-path)
      shift
      PYTHON_EXE_PATH="$1"
      ;;
    --requirements-ref)
      shift
      REQUIREMENTS_REF="$1"
      ;;
    --portable)
      echo "WARN: --portable is deprecated and ignored on macOS (Homebrew python is the default)"
      ;;
    --engine-selftest)
      # Dev-only: exercise the step engine with mock steps and exit.
      engine_selftest_bool=true
      non_root_packages=false
      check_installed_bool=false
      ;;
    --selftest-env-merge)
      # Dev-only: run only the env.yml merge against installDir and exit.
      selftest_env_merge_bool=true
      non_root_packages=false
      check_installed_bool=false
      ;;
    --mirror-base-url)
      shift
      MIRROR_BASE_URL="$1"
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
DL_DIR="$TMP_DIR/downloads"
TOOLS_DIR="$INSTALL_DIR/tools"
ENV_FILE="$INSTALL_DIR/env.sh"
ENV_YAML_PATH="$INSTALL_DIR/env.yml"
ENV_PY_PATH="$INSTALL_DIR/env.py"
VENV_PATH_EFFECTIVE="${VENV_PATH:-$INSTALL_DIR/.venv}"

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

# Check that Python version meets the minimum requirement and set PYTHON_TOO_OLD accordingly
check_python_version_requirement() {
    local min_major="$PYTHON_MIN_MAJOR"
    local min_minor="$PYTHON_MIN_MINOR"

    local pyexe=""
    if command -v python3 >/dev/null 2>&1; then
        pyexe=python3
    elif command -v python >/dev/null 2>&1; then
        pyexe=python
    else
        pr_warn "Python not found on PATH; Zephyr requires Python >= ${PYTHON_MIN_VERSION}"
        PYTHON_TOO_OLD=true
        return 1
    fi

    local ver_str="$($pyexe -c 'import sys; print("%d.%d" % (sys.version_info.major, sys.version_info.minor))' 2>/dev/null)"
    if [[ -z "$ver_str" ]]; then
        pr_warn "Unable to determine Python version; Zephyr requires Python >= ${PYTHON_MIN_VERSION}"
        PYTHON_TOO_OLD=true
        return 1
    fi

    local maj="${ver_str%%.*}"
    local min="${ver_str#*.}"

    if (( maj > min_major )) || (( maj == min_major && min >= min_minor )); then
        PYTHON_TOO_OLD=false
        return 0
    else
        PYTHON_TOO_OLD=true
        pr_warn "Detected Python ${ver_str}; Zephyr requires version >= ${PYTHON_MIN_VERSION}"
        return 1
    fi
}

# ----------------------------------------------------------------------------
# Step engine: every install unit runs through run_step and NEVER stops the
# script. Results are collected in parallel arrays (bash 3.2 safe) and
# reported in a final summary; the exit code signals failed or
# selected-but-skipped steps.
# ----------------------------------------------------------------------------
STEP_NAMES=()
STEP_LABELS=()
STEP_STATUS=()      # success|warning|failed|skipped|not-selected
STEP_REASON=()
STEP_WARNINGS=()
CURRENT_STEP_WARNINGS=""
STEP_ERROR=""
INSTALL_FAILED_COUNT=0
INSTALL_SKIPPED_COUNT=0
INSTALL_WARNING_COUNT=0
SELECTED_SKIPPED_COUNT=0

# is_in_list <item> <"a b c">
is_in_list() {
    case " $2 " in
        *" $1 "*) return 0 ;;
    esac
    return 1
}

# Record a warning against the currently running step (degrades it to [WARN])
step_warn() {
    pr_warn "$1"
    CURRENT_STEP_WARNINGS="${CURRENT_STEP_WARNINGS}${CURRENT_STEP_WARNINGS:+$NL}$1"
}

# Set the failure reason before 'return 1' from a step body
step_error() {
    STEP_ERROR="$1"
}

record_step() {
    STEP_NAMES+=("$1")
    STEP_LABELS+=("$2")
    STEP_STATUS+=("$3")
    STEP_REASON+=("$4")
    STEP_WARNINGS+=("$5")
}

get_step_status() {
    local i
    for ((i=0; i<${#STEP_NAMES[@]}; i++)); do
        if [ "${STEP_NAMES[$i]}" = "$1" ]; then
            echo "${STEP_STATUS[$i]}"
            return 0
        fi
    done
    echo ""
    return 0
}

# When a required step was deselected, the dependent step can still run if the
# requirement is already satisfied on this machine.
probe_step_presence() {
    case "$1" in
        python)
            if [ -n "$CUSTOM_PYTHON_EXE" ] && "$CUSTOM_PYTHON_EXE" --version >/dev/null 2>&1; then
                return 0
            fi
            python3 --version >/dev/null 2>&1 && return 0
            python --version >/dev/null 2>&1 && return 0
            return 1
            ;;
    esac
    return 1
}

# run_step <name> <label> <requires: "a b"> <body-function>
# Body functions run in the CURRENT shell (they may mutate PATH and globals);
# they must use 'cmd || { step_error "reason"; return 1; }' on critical
# commands instead of exiting.
run_step() {
    local name="$1" label="$2" requires="$3" body="$4"
    local req rs ok reason st

    # 1. selection filter: deselected wins over failed prerequisites
    if [ -n "$SELECTED_TOOLS" ] && is_in_list "$name" "$SELECTABLE_STEPS" \
       && ! is_in_list "$name" "$SELECTED_TOOLS"; then
        record_step "$name" "$label" "not-selected" "not selected" ""
        return 0
    fi
    # 2. infra filter: helper tools only run when a selected part needs them
    if [ "$INFRA_NEEDED" != "true" ] && [ -n "$INFRA_STEPS" ] && is_in_list "$name" "$INFRA_STEPS"; then
        record_step "$name" "$label" "not-selected" "not needed for this selection" ""
        return 0
    fi
    # 3. requirements, with a presence probe for deselected prerequisites
    for req in $requires; do
        rs=$(get_step_status "$req")
        ok=false
        reason="requires '$req'"
        case "$rs" in
            success|warning) ok=true ;;
            not-selected)
                if probe_step_presence "$req"; then
                    ok=true
                else
                    reason="requires '$req' (not selected and not installed)"
                fi
                ;;
        esac
        if [ "$ok" != "true" ]; then
            pr_warn "Skipping $label: required step '$req' did not succeed"
            record_step "$name" "$label" "skipped" "$reason" ""
            return 0
        fi
    done
    # 4. never-stop execution
    CURRENT_STEP_WARNINGS=""
    STEP_ERROR=""
    if "$body"; then
        st=success
        [ -n "$CURRENT_STEP_WARNINGS" ] && st=warning
        record_step "$name" "$label" "$st" "" "$CURRENT_STEP_WARNINGS"
    else
        [ -n "$STEP_ERROR" ] || STEP_ERROR="step returned a non-zero exit code"
        echo "ERROR: Step '$label' failed: $STEP_ERROR"
        record_step "$name" "$label" "failed" "$STEP_ERROR" "$CURRENT_STEP_WARNINGS"
    fi
    return 0
}

compute_step_counts() {
    INSTALL_FAILED_COUNT=0
    INSTALL_SKIPPED_COUNT=0
    INSTALL_WARNING_COUNT=0
    SELECTED_SKIPPED_COUNT=0
    local i
    for ((i=0; i<${#STEP_NAMES[@]}; i++)); do
        case "${STEP_STATUS[$i]}" in
            failed)
                INSTALL_FAILED_COUNT=$((INSTALL_FAILED_COUNT+1))
                ;;
            warning)
                INSTALL_WARNING_COUNT=$((INSTALL_WARNING_COUNT+1))
                ;;
            skipped|not-selected)
                INSTALL_SKIPPED_COUNT=$((INSTALL_SKIPPED_COUNT+1))
                if [ "${STEP_STATUS[$i]}" = "skipped" ] && [ -n "$SELECTED_TOOLS" ] \
                   && is_in_list "${STEP_NAMES[$i]}" "$SELECTED_TOOLS"; then
                    SELECTED_SKIPPED_COUNT=$((SELECTED_SKIPPED_COUNT+1))
                fi
                ;;
        esac
    done
    return 0
}

print_step_summary() {
    [ ${#STEP_NAMES[@]} -gt 0 ] || return 0
    pr_title "Installation Summary"
    local i tag line w
    for ((i=0; i<${#STEP_NAMES[@]}; i++)); do
        tag='[ OK ]'
        case "${STEP_STATUS[$i]}" in
            warning) tag='[WARN]' ;;
            failed) tag='[FAIL]' ;;
            skipped|not-selected) tag='[SKIP]' ;;
        esac
        line="$tag ${STEP_LABELS[$i]}"
        [ -n "${STEP_REASON[$i]}" ] && line="$line : ${STEP_REASON[$i]}"
        echo "$line"
        if [ -n "${STEP_WARNINGS[$i]}" ]; then
            while IFS= read -r w; do
                [ -n "$w" ] && echo "         - $w"
            done <<< "${STEP_WARNINGS[$i]}"
        fi
    done
    echo "$INSTALL_FAILED_COUNT step(s) failed, $INSTALL_SKIPPED_COUNT skipped, $INSTALL_WARNING_COUNT with warnings."
    return 0
}

# ----------------------------------------------------------------------------
# tools.yml field reader: line scan, no yq needed (POSIX awk, BSD-awk safe).
# get_yaml_os_field <tool> <field>
# ----------------------------------------------------------------------------
get_yaml_os_field() {
    awk -v tool="$1" -v os="$SELECTED_OS" -v field="$2" -v sq=\' '
        $0 ~ ("^- tool: " tool "$")                        { ft=1; fo=0; next }
        ft && /^- tool: /                                  { exit }
        ft && $0 ~ ("^[ ]+" os ":[ \t]*$")                 { fo=1; next }
        ft && fo && /^[ ]+(windows|linux|darwin):[ \t]*$/  { fo=0; next }
        ft && fo && $0 ~ ("^[ ]+" field ": ") {
            line=$0
            sub("^[ ]+" field ": *", "", line)
            gsub(/"/, "", line)
            gsub(sq, "", line)
            print line
            exit
        }
    ' "$YAML_FILE"
}

# ----------------------------------------------------------------------------
# env.yml section extraction for the merge: prints the section starting at
# '<indent><key>:' up to the next line at the same or lower indentation,
# trailing blank lines trimmed. POSIX awk only.
# get_yaml_section <file> <key> <indent>
# ----------------------------------------------------------------------------
get_yaml_section() {
    [ -f "$1" ] || return 0
    awk -v key="$2" -v ind="$3" '
    BEGIN { insec = 0; nblank = 0; pfx = sprintf("%*s", ind, "") }
    {
        if (!insec) {
            if ($0 ~ ("^" pfx key ":[ \t]*$")) { insec = 1; print }
            next
        }
        if ($0 ~ /^[ \t]*$/) { nblank++; next }
        s = $0
        sub(/[^ ].*$/, "", s)
        if (length(s) <= ind) exit
        while (nblank > 0) { print ""; nblank-- }
        print
    }' "$1"
}

# Mirror contract (shared with the mirror updater script): files are stored
# content-addressed as <MIRROR_BASE_URL>/<sha256-lowercase>, bare hash, no
# filename. Prints nothing and returns 1 when the mirror is disabled or the
# manifest hash is a placeholder (not 64 hex chars): no mirror attempt then.
# Note: must stay bash 3.2 compatible (macOS default), so tr instead of ${var,,}.
get_mirror_url() {
    local h
    h=$(printf '%s' "$1" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
    [ -n "$MIRROR_BASE_URL" ] || return 1
    [ ${#h} -eq 64 ] || return 1
    case "$h" in *[!0-9a-f]*) return 1 ;; esac
    echo "${MIRROR_BASE_URL%/}/$h"
}

# fetch_url <url> <dest>: prefer wget when present, fall back to curl (always
# available on macOS, so downloads work before the utilities step installs
# wget). Diagnostics go to stderr because some callers capture stdout as the
# failure reason. Returns non-zero when nothing could fetch the file.
fetch_url() {
    local url="$1" dest="$2"
    if command -v wget >/dev/null 2>&1; then
        if wget --no-check-certificate -q "$url" -O "$dest" && [ -s "$dest" ]; then
            return 0
        fi
        rm -f "$dest"
        if command -v curl >/dev/null 2>&1; then
            pr_warn "wget failed for $(basename "$dest"); trying curl" >&2
        fi
    fi
    if command -v curl >/dev/null 2>&1; then
        if curl -fkLsS -o "$dest" "$url" 2>/dev/null && [ -s "$dest" ]; then
            return 0
        fi
        rm -f "$dest"
    fi
    return 1
}

# One download and verify attempt. Prints the failure reason on stdout.
# Returns 0 on success, 1 when the download failed, 2 on hash mismatch.
try_download_and_verify() {
    local url=$1 expected_hash=$2 file_path=$3
    local computed_hash expected_lc
    rm -f "$file_path"

    if ! fetch_url "$url" "$file_path"; then
        echo "download failed"
        return 1
    fi

    # Compute the SHA-256 hash of the downloaded file, compare case-insensitively
    computed_hash=$(shasum -a 256 "$file_path" | awk '{print $1}')
    expected_lc=$(printf '%s' "$expected_hash" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
    if [ "$computed_hash" != "$expected_lc" ]; then
        rm -f "$file_path"
        echo "hash mismatch: expected $expected_lc, computed $computed_hash"
        return 2
    fi
    return 0
}

# Function to download the file and check its SHA-256 hash, retrying from the
# mirror when the primary source fails or mismatches. Returns non-zero on
# failure (never exits: callers turn this into a step failure).
download_and_check_hash() {
    local source=$1
    local expected_hash=$2
    local filename=$3

    # Full path where the file will be saved
    local file_path="$DL_DIR/$filename"
    local primary_reason primary_status mirror_url mirror_reason mirror_status

    primary_reason=$(try_download_and_verify "$source" "$expected_hash" "$file_path")
    primary_status=$?
    if [ $primary_status -eq 0 ]; then
        echo "DL: $filename downloaded successfully"
        return 0
    fi

    if mirror_url=$(get_mirror_url "$expected_hash"); then
        pr_warn "Primary download of $filename from $source failed ($primary_reason); trying mirror: $mirror_url"
        mirror_reason=$(try_download_and_verify "$mirror_url" "$expected_hash" "$file_path")
        mirror_status=$?
        if [ $mirror_status -eq 0 ]; then
            echo "DL: $filename downloaded successfully (mirror)"
            return 0
        fi
        pr_error $mirror_status "Failed to download $filename: primary $source ($primary_reason); mirror $mirror_url ($mirror_reason)"
        return $mirror_status
    fi

    pr_error $primary_status "Failed to download $filename from $source ($primary_reason)"
    return $primary_status
}

# Plain download without hash verification. Returns non-zero on failure.
download() {
    local source=$1
    local filename=$2

    # Full path where the file will be saved
    local file_path="$DL_DIR/$filename"
    rm -f "$file_path"

    if ! fetch_url "$source" "$file_path"; then
        pr_error 1 "Failed to download $filename from $source"
        return 1
    fi
    return 0
}

install_python_venv() {
    local install_directory=$1
    local work_directory=$2
    # Check Python version requirement
    check_python_version_requirement || true

    pr_title "Zephyr Python Requirements"

    local requirements_baseurl="https://raw.githubusercontent.com/zephyrproject-rtos/zephyr/${REQUIREMENTS_REF_VALUE}/scripts"
    local requirements_dir="$work_directory/requirements"
    local venv_path="${VENV_PATH:-$install_directory/.venv}"

    # Choose requirements source: honor ZEPHYR_BASE only when no explicit
    # --requirements-ref was given.
    local requirements_file=""
    if [[ -z "$REQUIREMENTS_REF" && -n "$ZEPHYR_BASE" && -f "$ZEPHYR_BASE/scripts/requirements.txt" ]]; then
        requirements_file="$ZEPHYR_BASE/scripts/requirements.txt"
        echo "Using ZEPHYR_BASE requirements: $requirements_file"
    else
        echo "Downloading Zephyr requirements (ref: ${REQUIREMENTS_REF_VALUE})"
        local requirement_files=(
            "requirements.txt"
            "requirements-run-test.txt"
            "requirements-extras.txt"
            "requirements-compliance.txt"
            "requirements-build-test.txt"
            "requirements-base.txt"
        )
        mkdir -p "$requirements_dir"
        for requirement in "${requirement_files[@]}"; do
            if ! download "$requirements_baseurl/$requirement" "$requirement"; then
                step_error "Failed to download $requirement (Zephyr ref: ${REQUIREMENTS_REF_VALUE})"
                return 1
            fi
            mv "$DL_DIR/$requirement" "$requirements_dir/$requirement"
        done
        requirements_file="$requirements_dir/requirements.txt"
    fi

    # A half-created venv (directory without an activation script) can never
    # become usable: rebuild it instead of failing forever.
    if [[ -d "$venv_path" && ! -f "$venv_path/bin/activate" ]]; then
        pr_warn "Existing virtual environment at $venv_path is incomplete; recreating it"
        rm -rf "$venv_path"
    fi

    local venv_python=python3
    if [[ -n "$CUSTOM_PYTHON_EXE" ]]; then
        venv_python="$CUSTOM_PYTHON_EXE"
    elif ! command -v python3 >/dev/null 2>&1; then
        venv_python=python
    fi

    if [[ ! -d "$venv_path" ]]; then
        if ! "$venv_python" -m venv "$venv_path"; then
            step_error "Failed to create the virtual environment at $venv_path"
            return 1
        fi
    fi
    if [[ ! -f "$venv_path/bin/activate" ]]; then
        step_error "Virtual environment has no activation script: $venv_path"
        return 1
    fi

    source "$venv_path/bin/activate"
    echo "Upgrading pip to the latest version..."
    python -m pip install --upgrade pip --quiet || pr_warn "pip self-upgrade failed; continuing with the bundled pip"

    local parser_script="$SCRIPT_DIR/parse_python_packages.py"
    local -a python_package_specs=()

    # Ensure PyYAML is present before parsing tools.yml inside the venv.
    if ! python - <<'PY' >/dev/null 2>&1
import importlib
import sys

try:
    importlib.import_module("yaml")  # type: ignore
except ModuleNotFoundError:
    sys.exit(1)
sys.exit(0)
PY
    then
        echo "Installing PyYAML into the virtual environment..."
        python -m pip install --quiet pyyaml
    fi

    if [[ -f "$parser_script" ]]; then
        # Shared parser emits the specs list, honoring per-OS gating in tools.yml.
        local python_output=""
        if python_output=$(python "$parser_script" "$YAML_FILE" "$SELECTED_OS"); then
            local line=""
            while IFS= read -r line; do
                python_package_specs+=("$line")
            done <<<"$python_output"
        else
            echo "Failed to parse python_packages from $YAML_FILE" >&2
            python_package_specs=()
        fi
    else
        echo "Parser script not found: $parser_script" >&2
    fi

    # Attempt every package, then report the failures together: one broken
    # package never blocks the others.
    local -a venv_failed_specs=()
    for spec in "${python_package_specs[@]}"; do
        if [[ -n "$spec" && "$spec" != "null" ]]; then
            echo "Installing Python package: $spec"
            python -m pip install "$spec" --quiet || venv_failed_specs+=("$spec")
        fi
    done

    echo "Installing Zephyr's base requirements..."
    if ! python -m pip install -r "$requirements_file" --quiet; then
        step_error "Failed to install Zephyr base requirements ($requirements_file)"
        return 1
    fi

    if [ ${#venv_failed_specs[@]} -gt 0 ]; then
        step_error "Failed to install ${#venv_failed_specs[@]} Python package(s): ${venv_failed_specs[*]}"
        return 1
    fi
    return 0
}

env_script() {
cat << 'EOF'
# Please do not manually edit this script, it is intended to be sourced by other scripts to set up the environment.
# You can add environment variables and paths to env.yml via the Host Tools Manager interface.

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
if [[ -n "$PYTHON_VENV_PATH" ]]; then
    venv_activate_path="$PYTHON_VENV_PATH/bin/activate"
else
    venv_activate_path="$default_venv_activate_path"
fi

if [[ -f "$venv_activate_path" ]]; then
    source "$venv_activate_path" >/dev/null 2>&1
else
    echo "[ERROR] Virtual environment activation script not found: $venv_activate_path" >&2
fi

# --- Verify venv activation ---
if [[ -z "$VIRTUAL_ENV" ]]; then
    echo "[ERROR] Failed to activate the Python virtual environment." >&2
    echo "[INFO] Checked path: $venv_activate_path" >&2
    echo "[SUGGESTION] You may need to reinstall Host Tools or the global or local virtual environment." >&2
fi

# --- Run env.py to load environment variables and paths ---
if [[ -f "$PY_FILE" ]]; then
    # We tell env.py to output in POSIX shell mode
    eval "$(python "$PY_FILE" --shell=sh)"
else
    echo "[ERROR] Python environment loader not found: $PY_FILE" >&2
fi

# Keep the active venv Python ahead of host-tools Python after env.py updates PATH. Required for Sysbuild
if [[ -n "$VIRTUAL_ENV" ]]; then
    export PATH="$VIRTUAL_ENV/bin${PATH:+:$PATH}"
fi

EOF
}

# ----------------------------------------------------------------------------
# env.yml is REGENERATED AS A MERGE on every run whose steps did not fail,
# selective or not: skipping a tool never leaves the manifest incomplete or
# stale.
#  - Tool entries owned by parts touched by this run are rebuilt (python:
#    detected version per source mode; brew tools stay pathless, brew is on
#    PATH).
#  - Tool entries NOT touched are carried over verbatim from the previous
#    file (user path/source overrides survive), template when absent.
#  - User data always survives: extra env: keys, runners: and other: sections.
# A failed run keeps an existing file untouched.
# ----------------------------------------------------------------------------

# Which selectable part owns each env.yml tool block
env_tool_regen() {
    local id="$1" owner
    case "$id" in
        python) owner="python" ;;
        cmake)  owner="cmake" ;;
        ninja)  owner="ninja" ;;
        gperf)  owner="gperf" ;;
        dtc)    owner="dtc" ;;
        git)    owner="git" ;;
        ccache|dfu-util|wget|xz-utils) owner="utilities" ;;
        *)      owner="" ;;
    esac
    # Full run regenerates everything
    [ -z "$SELECTED_TOOLS" ] && return 0
    [ -z "$owner" ] && return 1
    is_in_list "$owner" "$SELECTED_TOOLS"
}

detect_env_python_version() {
    local out=""
    case "$PYTHON_MODE_EFFECTIVE" in
        custom)
            if [[ -n "$CUSTOM_PYTHON_EXE" ]]; then
                out=$("$CUSTOM_PYTHON_EXE" --version 2>&1 | sed -n 's/^Python //p')
            fi
            ;;
        *)
            if command -v python3 >/dev/null 2>&1; then
                out=$(python3 --version 2>&1 | sed -n 's/^Python //p')
            elif command -v python >/dev/null 2>&1; then
                out=$(python --version 2>&1 | sed -n 's/^Python //p')
            fi
            ;;
    esac
    echo "$out"
    return 0
}

# 'do_not_use: true' is the Host Tools Manager's "System" source semantics.
# Homebrew and system pythons are both pathless (they live on PATH); a custom
# python gets its real path written so sourced shells resolve it.
emit_python_tool_template() {
    local py_version
    py_version=$(detect_env_python_version)
    echo "  python:"
    case "$PYTHON_MODE_EFFECTIVE" in
        custom)
            echo "    path:"
            echo "      - \"$CUSTOM_PYTHON_DIR\""
            if [ -n "$py_version" ]; then
                echo "    version: \"$py_version\""
            fi
            echo "    do_not_use: false"
            ;;
        system)
            if [ -n "$py_version" ]; then
                echo "    version: \"$py_version\""
            fi
            echo "    do_not_use: true"
            ;;
        *)
            if [ -n "$py_version" ]; then
                echo "    version: \"$py_version\""
            fi
            echo "    do_not_use: false"
            ;;
    esac
    return 0
}

# Brew-managed tools are pathless and versionless in env.yml (brew keeps them
# on PATH and up to date).
emit_simple_tool_template() {
    echo "  $1:"
    echo "    do_not_use: false"
    return 0
}

emit_env_tool() {
    local id="$1" old_block
    echo ""
    if ! env_tool_regen "$id" && [ -s "$OLD_ENV_YML" ]; then
        old_block=$(get_yaml_section "$OLD_ENV_YML" "$id" 2)
        if [ -n "$old_block" ]; then
            echo "$old_block"
            return 0
        fi
    fi
    case "$id" in
        python) emit_python_tool_template ;;
        *)      emit_simple_tool_template "$id" ;;
    esac
    return 0
}

ENV_YAML_TOOLS="python cmake ninja git gperf dtc ccache dfu-util wget xz-utils file make"

write_env_yaml() {
    # A failed run keeps an existing manifest untouched; everything else gets
    # the merged regeneration (selective runs included, so a new python source
    # or freshly installed tool always lands in env.yml).
    local failed_so_far=0 i sec block tmp_yaml
    for ((i=0; i<${#STEP_NAMES[@]}; i++)); do
        [ "${STEP_STATUS[$i]}" = "failed" ] && failed_so_far=$((failed_so_far+1))
    done
    if [ -f "$ENV_YAML_PATH" ] && [ "$failed_so_far" -gt 0 ]; then
        pr_warn "Keeping existing environment manifest (some steps failed): $ENV_YAML_PATH"
        return 0
    fi

    OLD_ENV_YML="$TMP_DIR/env.yml.old"
    if [ -f "$ENV_YAML_PATH" ]; then
        cp "$ENV_YAML_PATH" "$OLD_ENV_YML"
    else
        : > "$OLD_ENV_YML"
    fi

    tmp_yaml="$ENV_YAML_PATH.tmp"
    {
        echo "# env.yml"
        echo "# ZInstaller Workspace Environment Manifest"
        echo "# Defines workspace tools and Python environment metadata for Zephyr Workbench"
        echo ""
        echo "global:"
        echo "  version: \"$zinstaller_version\""
        echo "  description: \"Host tools configuration for Zephyr Workbench (macOS)\""
        echo ""
        echo "# Any variable here will be added as environment variables"
        echo "env:"
        echo "  zi_base_dir: \"$INSTALL_DIR\""
        echo "  zi_tools_dir: \"\${zi_base_dir}/tools\""
        if [ -s "$OLD_ENV_YML" ]; then
            # Carry user-defined environment variables.
            get_yaml_section "$OLD_ENV_YML" env 0 \
                | grep -Ev '^env[[:space:]]*:|^[[:space:]]*(zi_base_dir|zi_tools_dir)[[:space:]]*:|^[[:space:]]*$'
        fi
        echo ""
        echo "tools:"
        for sec in $ENV_YAML_TOOLS; do
            emit_env_tool "$sec"
        done
        echo ""
        echo "python:"
        echo "  global_venv_path: \"$INSTALL_DIR/.venv\""
        echo ""
        # Carry the user-owned top-level sections (runner paths, extra tool paths).
        for sec in runners other; do
            if [ -s "$OLD_ENV_YML" ]; then
                block=$(get_yaml_section "$OLD_ENV_YML" "$sec" 0)
                if [ -n "$block" ]; then
                    echo "$block"
                    echo ""
                fi
            fi
        done
    } > "$tmp_yaml" || return 1
    mv "$tmp_yaml" "$ENV_YAML_PATH" || return 1

    echo "Created environment manifest: $ENV_YAML_PATH"
    return 0
}

write_env_py() {
	cat << 'EOF' > "$ENV_PY_PATH"
#!/usr/bin/env python3
"""
env.py - Parse env.yml and output environment setup commands
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
}

# Function to check if a package is installed and print the version
check_package() {
	local package=$1
	local version_command
	local version

	case $package in
		python) version_command="python3 --version 2>&1" ;;
		cmake) version_command="cmake --version 2>&1 | head -n 1" ;;
		ninja) version_command="ninja --version 2>&1" ;;
		git) version_command="git --version 2>&1" ;;
		gperf) version_command="gperf --version 2>&1 | head -n 1" ;;
		dtc) version_command="dtc --version 2>&1 | head -n 1" ;;
		ccache) version_command="ccache --version 2>&1 | head -n 1" ;;
		dfu-util) version_command="dfu-util --version 2>&1 | head -n 1" ;;
		wget) version_command="wget --version 2>&1 | head -n 1" ;;
		xz-utils) version_command="xz --version 2>&1 | head -n 1" ;;
		file) version_command="file --version 2>&1 | head -n 1" ;;
		make) version_command="make --version 2>&1 | head -n 1" ;;
		*) echo "$package [NOT INSTALLED]" && return 1 ;;
	esac

	# The '| head -n 1' pipes above mask a missing command's exit code, so
	# probe for the executable first.
	local probe_cmd
	probe_cmd=${version_command%% *}
	if ! command -v "$probe_cmd" >/dev/null 2>&1; then
		echo "$package [NOT INSTALLED]"
		return 1
	fi

	version=$(eval $version_command)

	if [[ $? -ne 0 || -z $version ]]; then
		echo "$package [NOT INSTALLED]"
		return 1
	else
		# Extract version number or short relevant info
		case $package in
			python) version=$(echo "$version" | sed -n 's/Python //p' | awk '{print $1}') ;;
			cmake) version=$(echo "$version" | sed -n 's/cmake version //p' | awk '{print $1}') ;;
			ninja) version=$(echo "$version") ;;
			git) version=$(echo "$version" | sed -n 's/git version //p' | awk '{print $1}') ;;
			gperf) version=$(echo "$version" | sed -n 's/GNU gperf //p' | awk '{print $1}') ;;
			dtc) version=$(echo "$version" | sed -n 's/Version: DTC //p' | awk '{print $1}') ;;
			ccache) version=$(echo "$version" | sed -n 's/ccache version //p' | awk '{print $1}') ;;
			dfu-util) version=$(echo "$version" | sed -n 's/dfu-util //p' | awk '{print $1}') ;;
			wget) version=$(echo "$version" | sed -n 's/GNU Wget //p' | awk '{print $1}') ;;
			xz-utils) version=$(echo "$version" | sed -n 's/xz (XZ Utils) //p' | awk '{print $1}') ;;
			file) version=$(echo "$version" | sed -n 's/file-//p' | awk '{print $1}') ;;
			make) version=$(echo "$version" | sed -n 's/GNU Make //p' | awk '{print $1}') ;;
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
        git
        gperf
        dtc
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

# ----------------------------------------------------------------------------
# Step bodies
# ----------------------------------------------------------------------------

# Homebrew is probed once at startup; brew steps fail with a clear reason when
# it is missing, but the rest of the run (env files, venv with system/custom
# python) still proceeds.
HOMEBREW_AVAILABLE=false
BREW_PREFIX="/usr/local"

probe_homebrew() {
    if command -v brew >/dev/null 2>&1; then
        HOMEBREW_AVAILABLE=true
    elif [ -x /opt/homebrew/bin/brew ]; then
        # GUI-launched shells often miss the brew dir on PATH
        export PATH="/opt/homebrew/bin:$PATH"
        HOMEBREW_AVAILABLE=true
    elif [ -x /usr/local/bin/brew ]; then
        export PATH="/usr/local/bin:$PATH"
        HOMEBREW_AVAILABLE=true
    fi
    if [ "$HOMEBREW_AVAILABLE" = "true" ]; then
        BREW_PREFIX=$(brew --prefix 2>/dev/null || echo "/usr/local")
        echo "Homebrew is installed ($BREW_PREFIX)."
    else
        pr_warn "Homebrew is not installed. Homebrew-provided packages cannot be installed; install it from https://brew.sh"
    fi
    return 0
}

require_homebrew() {
    if [ "$HOMEBREW_AVAILABLE" != "true" ]; then
        step_error "Homebrew is not installed. Install it from https://brew.sh then retry"
        return 1
    fi
    return 0
}

# brew install with per-formula verification: a single broken formula degrades
# the step to a warning with names instead of losing the whole batch; the step
# only fails when every formula is missing afterwards.
brew_install_formulas() {
    require_homebrew || return 1
    brew install "$@" \
        || step_warn "brew install reported an error (exit $?); verifying formulas individually"
    local -a failed_formulas=()
    local f
    for f in "$@"; do
        brew list --versions "$f" >/dev/null 2>&1 || failed_formulas+=("$f")
    done
    if [ ${#failed_formulas[@]} -gt 0 ]; then
        if [ ${#failed_formulas[@]} -eq $# ]; then
            step_error "Formula(s) failed to install: ${failed_formulas[*]}"
            return 1
        fi
        for f in "${failed_formulas[@]}"; do
            step_warn "Formula failed to install: $f"
        done
    fi
    return 0
}

step_python() {
    case "$PYTHON_MODE_EFFECTIVE" in
    brew)
        pr_title "Python (Homebrew)"
        echo "Installing Python $PYTHON_VERSION and dependencies"
        brew_install_formulas "python@$PYTHON_VERSION" "python-tk@$PYTHON_VERSION" || return 1
        # Update PATH to use the new Python version - both direct binaries and symlinks
        PYTHON_PREFIX=$(brew --prefix "python@$PYTHON_VERSION" 2>/dev/null || echo "$BREW_PREFIX/opt/python@$PYTHON_VERSION")
        export PATH="$PYTHON_PREFIX/libexec/bin:$BREW_PREFIX/bin:$PATH"
        check_python_version_requirement || true
        if [[ "$PYTHON_TOO_OLD" == true ]]; then
            step_warn "Python on PATH is older than ${PYTHON_MIN_VERSION}; Zephyr requires >= ${PYTHON_MIN_VERSION}"
        fi
        ;;
    custom)
        pr_title "Python (custom)"
        if ! "$CUSTOM_PYTHON_EXE" --version >/dev/null 2>&1; then
            step_error "Custom python is not runnable: $CUSTOM_PYTHON_EXE"
            return 1
        fi
        echo "Using custom Python: $CUSTOM_PYTHON_EXE ($("$CUSTOM_PYTHON_EXE" --version 2>&1))"
        check_python_version_requirement || true
        if [[ "$PYTHON_TOO_OLD" == true ]]; then
            step_warn "Custom Python is older than ${PYTHON_MIN_VERSION}; Zephyr requires >= ${PYTHON_MIN_VERSION}"
        fi
        ;;
    *)
        pr_title "Python (system)"
        local pyexe=""
        if command -v python3 >/dev/null 2>&1 && python3 --version >/dev/null 2>&1; then
            pyexe=python3
        elif command -v python >/dev/null 2>&1 && python --version >/dev/null 2>&1; then
            pyexe=python
        fi
        if [[ -z "$pyexe" ]]; then
            step_error "No working python3/python found on PATH"
            return 1
        fi
        echo "Using system Python: $(command -v $pyexe) ($($pyexe --version 2>&1))"
        check_python_version_requirement || true
        if [[ "$PYTHON_TOO_OLD" == true ]]; then
            step_warn "System Python is older than ${PYTHON_MIN_VERSION}; Zephyr requires >= ${PYTHON_MIN_VERSION}"
        fi
        ;;
    esac
    return 0
}

step_cmake() {
    pr_title "CMake"
    brew_install_formulas cmake || return 1
    return 0
}

step_ninja() {
    pr_title "Ninja"
    brew_install_formulas ninja || return 1
    return 0
}

step_gperf() {
    pr_title "gperf"
    brew_install_formulas gperf || return 1
    return 0
}

step_dtc() {
    pr_title "Device Tree Compiler"
    brew_install_formulas dtc || return 1
    return 0
}

step_git() {
    pr_title "Git"
    brew_install_formulas git || return 1
    return 0
}

step_utilities() {
    pr_title "Utilities"
    echo "Installing utility packages: ccache libmagic wget yq xz dfu-util libftdi hidapi"
    brew_install_formulas ccache libmagic wget yq xz dfu-util libftdi hidapi || return 1
    return 0
}

step_venv() {
    pr_title "Python VENV"
    install_python_venv "$INSTALL_DIR" "$TMP_DIR" || return 1

    if ! command -v west &> /dev/null; then
    echo "West is not available. Something is wrong !!"
    else
    echo "West is available."
    fi
    return 0
}

step_env_files() {
    env_script > "$ENV_FILE" || { step_error "Failed to write $ENV_FILE"; return 1; }
    chmod +x "$ENV_FILE"
    write_env_yaml || { step_error "Failed to write $ENV_YAML_PATH"; return 1; }
    write_env_py || { step_error "Failed to write $ENV_PY_PATH"; return 1; }
    echo "Created py script to parse yml: $ENV_PY_PATH"
    return 0
}

# ----------------------------------------------------------------------------
# Option validation (needs the helpers above)
# ----------------------------------------------------------------------------

# --tools only applies to install runs
if [[ -n "$SELECTED_TOOLS_RAW" ]]; then
    if [[ $only_check_bool == true || $create_venv_bool == true || $reinstall_venv_bool == true ]]; then
        pr_warn "--tools is ignored with --only-check, --create-venv and --reinstall-venv"
        SELECTED_TOOLS_RAW=""
    fi
fi
SELECTED_TOOLS=$(echo "$SELECTED_TOOLS_RAW" | tr ',' ' ' | tr '[:upper:]' '[:lower:]')
SELECTED_TOOLS=$(echo $SELECTED_TOOLS)
if [[ -n "$SELECTED_TOOLS" && $engine_selftest_bool != true ]]; then
    invalid_tools=""
    for t in $SELECTED_TOOLS; do
        is_in_list "$t" "$SELECTABLE_STEPS" || invalid_tools="$invalid_tools $t"
    done
    if [[ -n "$invalid_tools" ]]; then
        pr_error 1 "Unknown value(s) for --tools:$invalid_tools. Valid values: cmake, ninja, gperf, dtc, git, utilities, python, venv"
        exit 1
    fi
fi

# Python source flags are mutually exclusive
if [[ $use_system_python_bool == true && -n "$PYTHON_EXE_PATH" ]]; then
    pr_error 1 "--use-system-python and --python-exe-path are mutually exclusive"
    exit 1
fi
if [[ $use_system_python_bool == true ]]; then
    PYTHON_MODE="system"
elif [[ -n "$PYTHON_EXE_PATH" ]]; then
    PYTHON_MODE="custom"
    if [[ -d "$PYTHON_EXE_PATH" ]]; then
        if [[ -x "$PYTHON_EXE_PATH/python3" ]]; then
            CUSTOM_PYTHON_EXE="$PYTHON_EXE_PATH/python3"
        elif [[ -x "$PYTHON_EXE_PATH/python" ]]; then
            CUSTOM_PYTHON_EXE="$PYTHON_EXE_PATH/python"
        else
            pr_error 1 "--python-exe-path: no python3/python executable found in directory: $PYTHON_EXE_PATH"
            exit 1
        fi
    elif [[ -f "$PYTHON_EXE_PATH" ]]; then
        CUSTOM_PYTHON_EXE="$PYTHON_EXE_PATH"
    else
        pr_error 1 "--python-exe-path does not exist: $PYTHON_EXE_PATH"
        exit 1
    fi
    CUSTOM_PYTHON_DIR="$(cd "$(dirname "$CUSTOM_PYTHON_EXE")" && pwd)"
fi
PYTHON_MODE_EFFECTIVE="$PYTHON_MODE"

# Requirements ref: tag or branch name characters only
if [[ -n "$REQUIREMENTS_REF" ]]; then
    case "$REQUIREMENTS_REF" in
        *[!A-Za-z0-9._/-]*)
            pr_error 1 "Invalid --requirements-ref value: $REQUIREMENTS_REF (allowed characters: letters, digits, . _ / -)"
            exit 1
            ;;
        *)
            REQUIREMENTS_REF_VALUE="$REQUIREMENTS_REF"
            ;;
    esac
fi

# ----------------------------------------------------------------------------
# Dev-only selftests (no downloads, no package installs)
# ----------------------------------------------------------------------------

if [[ $engine_selftest_bool == true ]]; then
    selftest_ok() { echo "ok body ran"; }
    selftest_warn() { step_warn "something minor happened"; }
    selftest_fail() { step_error "boom"; return 1; }
    selftest_never() { echo "THIS BODY MUST NOT RUN"; }

    if [[ "${ZI_SELFTEST_PASS:-0}" != "0" ]]; then
        SELECTED_TOOLS=""
        SELECTABLE_STEPS="ok warnstep"
        INFRA_STEPS="infra"
        INFRA_NEEDED=false
        run_step ok "Step OK" "" selftest_ok
        run_step warnstep "Step Warn" "" selftest_warn
        run_step infra "Step Infra" "" selftest_never
    else
        SELECTED_TOOLS="ok warnstep failstep needsfail needsnotsel"
        SELECTABLE_STEPS="ok warnstep failstep needsfail needsnotsel notsel"
        INFRA_STEPS="infra"
        INFRA_NEEDED=false
        run_step ok "Step OK" "" selftest_ok
        run_step warnstep "Step Warn" "" selftest_warn
        run_step failstep "Step Fail" "" selftest_fail
        run_step needsfail "Step Requires Failed" "failstep" selftest_never
        run_step notsel "Step Not Selected" "" selftest_never
        run_step needsnotsel "Step Requires Unselected" "notsel" selftest_never
        run_step infra "Step Infra" "" selftest_never
    fi
    compute_step_counts
    print_step_summary
    if [[ $INSTALL_FAILED_COUNT -gt 0 || $SELECTED_SKIPPED_COUNT -gt 0 ]]; then
        exit 1
    fi
    exit 0
fi

if [[ $selftest_env_merge_bool == true ]]; then
    mkdir -p "$TMP_DIR"
    write_env_yaml
    merge_status=$?
    rm -rf "$TMP_DIR"
    exit $merge_status
fi

# ----------------------------------------------------------------------------
# Homebrew probe and python source PATH resolution
# ----------------------------------------------------------------------------

probe_homebrew
if [[ "$PYTHON_MODE" == "custom" ]]; then
    export PATH="$CUSTOM_PYTHON_DIR:$PATH"
fi

# ----------------------------------------------------------------------------
# Venv-only flows (exit on completion, honest exit codes)
# ----------------------------------------------------------------------------

if [[ $create_venv_bool == true ]]; then
    pr_title "Creating Python VENV"
    mkdir -p "$TMP_DIR" "$DL_DIR"
    check_python_version_requirement || true
    if [[ -n "$VENV_PATH" && -d "$VENV_PATH" && -f "$VENV_PATH/bin/activate" ]]; then
        echo "VENV already exists at: $VENV_PATH"
        rm -rf "$TMP_DIR"
        exit 0
    fi
    if install_python_venv "$INSTALL_DIR" "$TMP_DIR"; then
        rm -rf "$TMP_DIR"
        exit 0
    fi
    [[ -n "$STEP_ERROR" ]] && echo "ERROR: $STEP_ERROR"
    rm -rf "$TMP_DIR"
    exit 1
fi

if [[ $reinstall_venv_bool == true ]]; then
    pr_title "Reinstalling Python VENV"
    mkdir -p "$TMP_DIR" "$DL_DIR"
    check_python_version_requirement || true
    # Refuse to delete the venv when no interpreter could rebuild it
    if ! probe_step_presence python; then
        echo "ERROR: No working python executable found on PATH; existing venv left untouched."
        rm -rf "$TMP_DIR"
        exit 1
    fi
    if [[ -d "$VENV_PATH_EFFECTIVE" ]]; then
        rm -rf "$VENV_PATH_EFFECTIVE"
    fi
    if install_python_venv "$INSTALL_DIR" "$TMP_DIR"; then
        rm -rf "$TMP_DIR"
        exit 0
    fi
    [[ -n "$STEP_ERROR" ]] && echo "ERROR: $STEP_ERROR"
    rm -rf "$TMP_DIR"
    exit 1
fi

# ----------------------------------------------------------------------------
# Install roster
# ----------------------------------------------------------------------------

if [[ $non_root_packages == true ]]; then
    pr_title "Install host tools (Homebrew)"
    echo "This is MacOSX."

    mkdir -p "$TMP_DIR"
    mkdir -p "$DL_DIR"
    mkdir -p "$TOOLS_DIR"

    run_step python "Python" "" step_python
    run_step cmake "CMake" "" step_cmake
    run_step ninja "Ninja" "" step_ninja
    run_step gperf "gperf" "" step_gperf
    run_step dtc "Device Tree Compiler" "" step_dtc
    run_step git "Git" "" step_git
    run_step utilities "Utilities (ccache, libmagic, wget, yq, xz, dfu-util, libftdi, hidapi)" "" step_utilities
    run_step venv "Python virtual environment" "python" step_venv
    run_step env-files "Environment files" "" step_env_files
fi

# ----------------------------------------------------------------------------
# Install-mode tail: summary, essentials stamp, informational check, exit
# ----------------------------------------------------------------------------

if [[ $only_check_bool != true ]]; then
    compute_step_counts

    if [[ $non_root_packages == true ]]; then
        pr_title "Clean up"
        rm -rf $TMP_DIR
    fi

    print_step_summary

    if [[ $non_root_packages == true ]]; then
        # The essentials stamp: written only when nothing failed, nothing
        # selected was skipped, and the global venv is usable. Without it the
        # install keeps being reported as needing (re)installation.
        VENV_USABLE=false
        [[ -f "$VENV_PATH_EFFECTIVE/bin/activate" ]] && VENV_USABLE=true
        if [[ ${#STEP_NAMES[@]} -gt 0 && $INSTALL_FAILED_COUNT -eq 0 \
              && $SELECTED_SKIPPED_COUNT -eq 0 && "$VENV_USABLE" == true ]]; then
            cat <<EOF > "$INSTALL_DIR/zinstaller_version"
Script Version: $zinstaller_version
Script MD5: $zinstaller_md5
tools.yml MD5: $tools_yml_md5
EOF
        else
            pr_warn "Version stamp not written (failed or skipped steps, or the global venv is not available)."
        fi
        echo "Source me: . $ENV_FILE"

        if [[ $check_installed_bool == true ]]; then
            pr_title "Check Installed Packages"
            check_packages || true

            check_python_version_requirement || true
            if [[ "$PYTHON_TOO_OLD" == true ]]; then
                pr_warn "Install a recent Python (brew install python@$PYTHON_VERSION) and click on Reinstall global venv."
            fi
        fi
    fi

    if [[ $INSTALL_FAILED_COUNT -gt 0 || $SELECTED_SKIPPED_COUNT -gt 0 ]]; then
        exit 1
    fi
    exit 0
fi

# ----------------------------------------------------------------------------
# --only-check: byte-stable package listing, exit code = -missing
# ----------------------------------------------------------------------------

if [[ $only_check_bool == true ]]; then
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
