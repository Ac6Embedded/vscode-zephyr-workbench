#!/bin/bash
BASE_DIR="$HOME/.zinstaller"
SELECTED_OS="linux"

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
YAML_FILE="$SCRIPT_DIR/debug-tools.yml"

# Default values for the options
INSTALL_DIR=""
TOOLS=()

# Function to display usage information
usage() {
  echo "Usage: $0 -D installDir <tools1> [tools2 ...]"
}

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

pr_info() {
    local message="$1"
    echo "INFO: $message"
}


pr_warn() {
    local message="$1"
    echo "WARN: $message"
}

# Parse arguments
while [[ "$#" -gt 0 ]]; do
  case $1 in
    -h | --help)
      usage
      exit 0
      ;;
    -D)
      if [[ "$#" -lt 2 ]]; then
        echo "Error: -D option requires an argument."
        usage
      fi
      INSTALL_DIR="$2/.zinstaller"
      shift 2 
      ;;
    *)
      TOOLS+=("$1")
      shift
      ;;
  esac
done

# Check if installDir is provided, otherwise set it to BASE_DIR
if [[ -z "$INSTALL_DIR" ]]; then
    INSTALL_DIR=$BASE_DIR
fi

# Check if at least one tool is provided
if [[ ${#TOOLS[@]} -eq 0 ]]; then
  usage
  pr_error 1 "Please indicate the tool to install."
  exit 1
fi

TMP_DIR="$INSTALL_DIR/tmp"
MANIFEST_FILE="$TMP_DIR/manifest-debug-tools.sh"
DL_DIR="$TMP_DIR/downloads"
TOOLS_DIR="$INSTALL_DIR/tools"

# Function to get the filename from URL
get_filename_from_url() {
    local url="$1"

    # Use basename to extract the filename
    local filename=$(basename "$url")

    # Remove any query string or fragments from the filename
    filename=${filename%%\?*}
    filename=${filename%%\#*}

    echo "$filename"
}


# Function to download the file and check its SHA-256 hash
download_and_check_hash() {
    local source=$1
    local expected_hash=$2
    local filename=$3

    # Full path where the file will be saved
    local file_path="$DL_DIR/$filename"

    # Download the file using wget
    wget -q "$source" -O "$file_path"

    # Check if the download was successful
    if [ ! -f "$file_path" ]; then
        pr_error 1 "Failed to download the file."
        exit 1
    fi

    # Compute the SHA-256 hash of the downloaded file
    local computed_hash=$(sha256sum "$file_path" | awk '{print $1}')

    # Compare the computed hash with the expected hash
    if [ "$computed_hash" == "$expected_hash" ]; then
        pr_info "DL: $filename downloaded successfully"
    else
        pr_error 2 "Hash mismatch."
        pr_error 2 "Expected: $expected_hash"
        pr_error 2 "Computed: $computed_hash"
        exit 2
    fi
}

# Function to extract any archive
extract_archive() {
    local archive_file="$1"
    local dest_folder="$2"

    if [[ ! -f "$archive_file" ]]; then
        pr_error 1 "Archive file '$archive_file' not found."
        exit 1
    fi

    if [[ ! -d "$dest_folder" ]]; then
        pr_error 1 "Destination folder '$dest_folder' not found."
        exit 1
    fi

    if [[ "$archive_file" == *.tar.gz || "$archive_file" == *.tgz ]]; then
        pr_info "Extracting tar.gz archive... $archive_file to $dest_folder"
        tar -xzvf "$archive_file" -C "$dest_folder"
    elif [[ "$archive_file" == *.tar.bz2 || "$archive_file" == *.tbz2 ]]; then
        pr_info "Extracting tar.bz2 archive... $archive_file to $dest_folder"
        tar -xjvf "$archive_file" -C "$dest_folder"
    elif [[ "$archive_file" == *.tar.xz || "$archive_file" == *.txz ]]; then
        pr_info "Extracting tar.xz archive... $archive_file to $dest_folder"
        tar -xJvf "$archive_file" -C "$dest_folder"
    elif [[ "$archive_file" == *.rar ]]; then
        pr_info "Extracting rar archive... $archive_file to $dest_folder"
        unrar x "$archive_file" "$dest_folder/"
    elif [[ "$archive_file" == *.7z ]]; then
        pr_info "Extracting 7z archive... $archive_file to $dest_folder"
        7z x "$archive_file" -o"$dest_folder"
    elif [[ "$archive_file" == *.zip ]]; then
        pr_info "Extracting zip archive... $archive_file to $dest_folder"
        unzip -q "$archive_file" -d "$dest_folder"
    else
        pr_error 2 "Unsupported archive format for file '$archive_file'."
        exit 2
    fi
}

install_package() {
    local package_file="$1"

    if [[ ! -f "$package_file" ]]; then
        pr_error 1 "Package file '$package_file' not found."
        exit 1
    fi

    if [[ "$package_file" == *.deb ]]; then
        pr_info "Installing DEB archive... $package_file"
        dpkg -i "$package_file"
    elif [[ "$package_file" == *.rpm ]]; then
        pr_info "Installing RPM archive... $package_file"
        rpm -i "$package_file"
    else
        pr_error 2 "Unsupported package format for file '$package_file'."
        exit 2
    fi
}

has_install_script() {
    local tool="$1"
    if [ -f "$SCRIPT_DIR/debug/${tool}.sh" ]; then
        return 0
    fi
    return 1
}

run_install_script() {
    local tool="$1"
    local file="$2"
    bash "$SCRIPT_DIR/debug/$tool.sh" $file $TOOLS_DIR $TMP_DIR
}

is_archive() {
    local file="$1"
    case "$file" in
        *tar|*.tar.gz|*.tgz|*.tar.bz2|*.tbz2|*.tar.xz|*.txz|*.rar|*.7z|*.zip)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

is_package() {
    local file="$1"
    case "$file" in
        *.deb|*.rpm)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

install() {
    local tool="$1"
    local file="$2"
    local dest_folder="$3"
    if has_install_script "$tool"; then
        run_install_script "$tool" "$file" "$dest_folder"
    elif is_archive "$file"; then
        extract_archive "$file" "$dest_folder"
    elif is_package "$file"; then
        install_package "$file"
    else
        pr_error 2 "'$file' has an unsupported format."
        return 2
    fi
}

# Function to generate array entries if the tool supports the specified OS
function generate_manifest_entries {
    local tool=$1
    local SELECTED_OS=$2
    local manifest=$3

    # Using yq to parse the source and sha256 for the specific OS and tool
    source=$($YQ eval ".*[] | select(.tool == \"$tool\") | .os.$SELECTED_OS.source" $YAML_FILE)
    sha256=$($YQ eval ".*[] | select(.tool == \"$tool\") | .os.$SELECTED_OS.sha256" $YAML_FILE)

    echo "source=$source"

    # Check if the source and sha256 are not null (meaning the tool supports the OS)
    if [ "$source" != "null" ] && [ "$sha256" != "null" ]; then
        echo "SOURCE_URLS[${tool}]=\"$source\"" >> $manifest
        echo "SHA256_HASHES[${tool}]=\"$sha256\"" >> $manifest
    fi
}


mkdir -p "$TMP_DIR"
mkdir -p "$DL_DIR"
mkdir -p "$TOOLS_DIR"

YQ="yq"
YQ_SOURCE=$(grep -A 10 'tool: yq' $YAML_FILE | grep -A 2 "$SELECTED_OS:" | grep 'source' | awk -F": " '{print $2}')
YQ_SHA256=$(grep -A 10 'tool: yq' $YAML_FILE | grep -A 2 "$SELECTED_OS:" | grep 'sha256' | awk -F": " '{print $2}')
download_and_check_hash "$YQ_SOURCE" "$YQ_SHA256" "$YQ"
YQ="$DL_DIR/$YQ"
chmod +x $YQ

# Start generating the manifest file
pr_title "Parse tools definitions and generate manifest"

# Loop through each tool and generate the entries
echo "#!/bin/bash" > $MANIFEST_FILE
echo "declare -A SOURCE_URLS=()" >> $MANIFEST_FILE
echo "declare -A SHA256_HASHES=()" >> $MANIFEST_FILE
for tool in ${TOOLS[@]}; do
    generate_manifest_entries $tool $SELECTED_OS $MANIFEST_FILE
done

source $MANIFEST_FILE

for tool in ${TOOLS[@]}; do
    pr_title "$tool"
    INSTALLER_FILENAME=$(get_filename_from_url ${SOURCE_URLS[$tool]})
    echo "INSTALLER_FILENAME=$INSTALLER_FILENAME"
    download_and_check_hash ${SOURCE_URLS[$tool]} ${SHA256_HASHES[$tool]} "$INSTALLER_FILENAME"
    install "$tool" "$DL_DIR/$INSTALLER_FILENAME" "$TOOLS_DIR"
done

rm -rf $TMP_DIR