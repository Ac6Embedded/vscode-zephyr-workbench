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
    elif [[ "$file" =~ \.(tar|gz|bz2|xz|zip|7z)$ ]]; then
        extract_archive "$DL_DIR/$file" "$dest_folder"
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
echo "#!/bin/bash" >"$MANIFEST_FILE"
echo "declare -A SOURCE_URLS=()" >>"$MANIFEST_FILE"
echo "declare -A SHA256_HASHES=()" >>"$MANIFEST_FILE"

generate_manifest_entries() {
    local tool="$1"
    local os="$2"
    local manifest="$3"

    local os_node
    os_node=$($YQ eval ".*[] | select(.tool == \"$tool\") | .os.$os" "$YAML_FILE")

    if [[ "$os_node" == *"source:"* ]]; then
        local source sha256
        source=$($YQ eval ".*[] | select(.tool == \"$tool\") | .os.$os.source" "$YAML_FILE")
        sha256=$($YQ eval ".*[] | select(.tool == \"$tool\") | .os.$os.sha256" "$YAML_FILE")
        if [[ "$source" != "null" && "$sha256" != "null" ]]; then
            echo "SOURCE_URLS[$tool]=\"$source\"" >>"$manifest"
            echo "SHA256_HASHES[$tool]=\"$sha256\"" >>"$manifest"
        fi
    elif [[ "$os_node" == "true" ]]; then
        echo "SOURCE_URLS[$tool]=\"SCRIPT_ONLY\"" >>"$manifest"
        echo "SHA256_HASHES[$tool]=\"SKIP\"" >>"$manifest"
    fi
}

for tool in "${TOOLS[@]}"; do
    generate_manifest_entries "$tool" "$SELECTED_OS" "$MANIFEST_FILE"
done

source "$MANIFEST_FILE"

# ---------------------- Main Installation Loop ----------------------

pr_title "Install Tools"

for tool in "${TOOLS[@]}"; do
    pr_title "$tool"
    local source="${SOURCE_URLS[$tool]}"

    if [[ "$source" == "SCRIPT_ONLY" ]]; then
        pr_info "$tool is script-only (no download needed)."
        run_install_script "$tool" ""
        continue
    fi

    local installer_filename
    installer_filename=$(get_filename_from_url "$source")
    pr_info "INSTALLER_FILENAME=$installer_filename"

    download_and_check_hash "$source" "${SHA256_HASHES[$tool]}" "$installer_filename"
    install "$tool" "$installer_filename" "$TOOLS_DIR"
done

pr_info "Cleaning temporary files..."
rm -rf "$TMP_DIR"

pr_title "All tools installed successfully"
exit 0
