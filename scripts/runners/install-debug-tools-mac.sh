#!/bin/bash
set -euo pipefail

BASE_DIR="$HOME/.zinstaller"
SELECTED_OS="darwin"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
YAML_FILE="$SCRIPT_DIR/debug-tools.yml"

INSTALL_DIR=""
TOOLS=()

# ---------------------- Utility Functions ----------------------

usage() {
    echo "Usage: $0 -D <installDir> <tool1> [tool2 ...]"
    echo "Example: $0 -D ~/zephyr openocd pyocd"
}

pr_title() {
    local width=40
    local border
    border=$(printf '%*s' "$width" | tr ' ' '-')
    for param in "$@"; do
        local text_length=${#param}
        local left_padding=$(((width - text_length) / 2))
        local formatted_text
        formatted_text=$(printf '%*s%s' "$left_padding" '' "$param")
        echo "$border"
        echo "$formatted_text"
        echo "$border"
    done
}

pr_info()  { echo "INFO: $1"; }
pr_warn()  { echo "WARN: $1"; }
pr_error() { echo "ERROR: $1" >&2; return "${2:-1}"; }

# ---------------------- Parse Arguments ----------------------

while [[ "$#" -gt 0 ]]; do
    case "$1" in
        -h | --help) usage; exit 0 ;;
        -D)
            [[ "$#" -lt 2 ]] && { pr_error "-D requires a path"; usage; exit 1; }
            INSTALL_DIR="$2/.zinstaller"
            shift 2
            ;;
        *)
            TOOLS+=("$1")
            shift
            ;;
    esac
done

if [[ -z "$INSTALL_DIR" ]]; then
    INSTALL_DIR="$BASE_DIR"
fi

if [[ ${#TOOLS[@]} -eq 0 ]]; then
    usage
    pr_error "No tools specified" 1
    exit 1
fi

TMP_DIR="$INSTALL_DIR/tmp"
DL_DIR="$TMP_DIR/downloads"
TOOLS_DIR="$INSTALL_DIR/tools"
MANIFEST_FILE="$TMP_DIR/manifest-debug-tools.sh"

mkdir -p "$TMP_DIR" "$DL_DIR" "$TOOLS_DIR"

# ---------------------- Core Functions ----------------------

get_filename_from_url() {
    local url="$1"
    local filename
    filename=$(basename "$url")
    filename=${filename%%\?*}
    filename=${filename%%\#*}
    echo "$filename"
}

download_and_check_hash() {
    local source="$1"
    local expected_hash="$2"
    local filename="$3"
    local file_path="$DL_DIR/$filename"

    pr_info "Downloading: $filename ..."
    wget -q "$source" -O "$file_path"

    if [[ ! -f "$file_path" ]]; then
        pr_error "Download failed for $filename" 1
        exit 1
    fi

    local computed_hash
    computed_hash=$(shasum -a 256 "$file_path" | awk '{print $1}')

    if [[ "$expected_hash" == "SKIP" ]]; then
        pr_info "Hash check skipped for $filename"
    elif [[ "$computed_hash" == "$expected_hash" ]]; then
        pr_info "DL: $filename downloaded successfully"
    else
        pr_error "Hash mismatch for $filename" 2
        echo "Expected: $expected_hash"
        echo "Computed: $computed_hash"
        exit 2
    fi
}

extract_archive() {
    local archive_file="$1"
    local dest_folder="$2"

    [[ ! -f "$archive_file" ]] && pr_error "Archive not found: $archive_file" 1 && exit 1

    case "$archive_file" in
        *.tar.gz | *.tgz) tar -xzf "$archive_file" -C "$dest_folder" ;;
        *.tar.bz2 | *.tbz2) tar -xjf "$archive_file" -C "$dest_folder" ;;
        *.tar.xz | *.txz) tar -xJf "$archive_file" -C "$dest_folder" ;;
        *.zip) unzip -q "$archive_file" -d "$dest_folder" ;;
        *.7z) 7z x "$archive_file" -o"$dest_folder" ;;
        *) pr_error "Unsupported archive format: $archive_file" 2 && exit 2 ;;
    esac
}

get_tool_group() {
    local tool="$1"
    local group
    group=$($YQ eval ".debug_tools[] | select(.tool == \"$tool\") | .group" "$YAML_FILE")
    [[ -z "$group" || "$group" == "null" ]] && group="Common"
    echo "$group"
}

has_install_script() {
    local tool="$1"
    local group
    group=$(get_tool_group "$tool")
    local script_path="$SCRIPT_DIR/$group/${tool}-mac.sh"

    [[ -f "$script_path" ]]
}

run_install_script() {
    local tool="$1"
    local file="$2"
    local group
    group=$(get_tool_group "$tool")
    local script_path="$SCRIPT_DIR/$group/${tool}-mac.sh"

    if [[ -f "$script_path" ]]; then
        pr_info "Running install script: $script_path"
        bash "$script_path" "$file" "$TOOLS_DIR" "$TMP_DIR"
    else
        pr_warn "No install script found for $tool ($script_path)"
    fi
}

install() {
    local tool="$1"
    local file="$2"
    local dest_folder="$3"

    if [[ "$file" == "SCRIPT_ONLY" ]]; then
        run_install_script "$tool" ""
#    elif has_install_script "$tool"; then
#        run_install_script "$tool" "$file"
#    elif [[ "$file" =~ \.(tar|gz|bz2|xz|zip|7z)$ ]]; then
#        extract_archive "$file" "$dest_folder"
    else
        run_install_script "$tool" "$file"
    fi
}

# ---------------------- Generate Manifest ----------------------

YQ="yq"
if ! command -v "$YQ" >/dev/null 2>&1; then
    pr_error "yq not found in PATH. Please install yq before running this script." 1
    exit 1
fi

pr_title "Parse tools definitions and generate manifest"
source_cases=()
sha_cases=()

for tool in "${TOOLS[@]}"; do
    os_node=$($YQ eval ".*[] | select(.tool == \"$tool\") | .os.$SELECTED_OS" "$YAML_FILE")
    source_entry=""
    sha_entry=""

    if [[ "$os_node" == *"source:"* ]]; then
        source_entry=$($YQ eval ".*[] | select(.tool == \"$tool\") | .os.$SELECTED_OS.source" "$YAML_FILE")
        sha_entry=$($YQ eval ".*[] | select(.tool == \"$tool\") | .os.$SELECTED_OS.sha256" "$YAML_FILE")
        if [[ "$source_entry" == "null" || "$sha_entry" == "null" ]]; then
            source_entry=""
            sha_entry=""
        fi
    elif [[ "$os_node" == "true" ]]; then
        source_entry="SCRIPT_ONLY"
        sha_entry="SKIP"
    fi

    if [[ -n "$source_entry" || -n "$sha_entry" ]]; then
        source_cases+=("    $(printf %q "$tool")) printf '%s\\n' $(printf %q "$source_entry") ;;")
        sha_cases+=("    $(printf %q "$tool")) printf '%s\\n' $(printf %q "$sha_entry") ;;")
    fi
done

{
    echo "#!/bin/bash"
    echo "get_source_url() {"
    echo "  case \"\$1\" in"
    if [[ ${#source_cases[@]} -gt 0 ]]; then
        printf '%s\n' "${source_cases[@]}"
    fi
    echo "    *) return 1 ;;"
    echo "  esac"
    echo "}"
    echo
    echo "get_sha256_hash() {"
    echo "  case \"\$1\" in"
    if [[ ${#sha_cases[@]} -gt 0 ]]; then
        printf '%s\n' "${sha_cases[@]}"
    fi
    echo "    *) return 1 ;;"
    echo "  esac"
    echo "}"
} >"$MANIFEST_FILE"

source "$MANIFEST_FILE"

# ---------------------- Main Installation Loop ----------------------

pr_title "Install Tools"

for tool in "${TOOLS[@]}"; do
    pr_title "$tool"
    source=$(get_source_url "$tool" 2>/dev/null || true)

    if [[ "$source" == "SCRIPT_ONLY" ]]; then
        pr_info "$tool is script-only (no download needed)."
        run_install_script "$tool" ""
        continue
    fi

    sha256=$(get_sha256_hash "$tool" 2>/dev/null || true)

    if [[ -z "$source" ]]; then
        pr_error "No source defined for $tool on $SELECTED_OS" 1
        continue
    fi

    installer_filename=$(get_filename_from_url "$source")
    pr_info "INSTALLER_FILENAME=$installer_filename"

    download_and_check_hash "$source" "$sha256" "$installer_filename"
    install "$tool" "$DL_DIR/$installer_filename" "$TOOLS_DIR"
done

pr_info "Cleaning temporary files..."
rm -rf "$TMP_DIR"

pr_title "All tools installed successfully"
exit 0
