#!/bin/bash
SELECTED_OS="linux"

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
YAML_FILE="$SCRIPT_DIR/tools.yml"

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
  This script creates a new Python3 virtual environment for Zephyr build system
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

TMP_DIR="$INSTALL_DIR/.zinstaller"
MANIFEST_FILE="$TMP_DIR/manifest.sh"
DL_DIR="$TMP_DIR/downloads"

mkdir -p "$TMP_DIR"
mkdir -p "$DL_DIR"

source "$ENV_FILE" &> /dev/null 

if ! command -v python3 &> /dev/null; then
  echo "Missing python3, please install host tools first !"
  exit 1
fi

pr_title "YQ"
YQ="yq"
YQ_SOURCE=$(grep -A 10 'tool: yq' $YAML_FILE | grep -A 2 "$SELECTED_OS:" | grep 'source' | awk -F": " '{print $2}')
YQ_SHA256=$(grep -A 10 'tool: yq' $YAML_FILE | grep -A 2 "$SELECTED_OS:" | grep 'sha256' | awk -F": " '{print $2}')
download_and_check_hash "$YQ_SOURCE" "$YQ_SHA256" "$YQ"
YQ="$DL_DIR/$YQ"
chmod +x $YQ

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

pr_title "Python Requirements"
REQUIREMENTS_NAME="requirements-3.6.0"
REQUIREMENTS_ZIP_NAME="$REQUIREMENTS_NAME".zip
download_and_check_hash ${python_requirements[source]} ${python_requirements[sha256]} "$REQUIREMENTS_ZIP_NAME"
unzip -o "$DL_DIR/$REQUIREMENTS_ZIP_NAME" -d "$TMP_DIR/"

pr_title "Python VENV"
python3 -m venv $INSTALL_DIR/.venv
source $INSTALL_DIR/.venv/bin/activate
python3 -m pip install setuptools west py
python3 -m pip install -r "$TMP_DIR/$REQUIREMENTS_NAME/requirements.txt" --quiet

rm -rf $TMP_DIR