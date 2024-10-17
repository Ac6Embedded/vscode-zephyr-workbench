#!/bin/bash
BASE_DIR="$HOME/.zinstaller"
SELECTED_OS="darwin"

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
YAML_FILE="$SCRIPT_DIR/tools.yml"

# Default values for the options
root_packages=true
non_root_packages=true
check_installed_bool=true
skip_sdk_bool=false
install_sdk_bool=false
reinstall_venv_bool=false
portable=false
INSTALL_DIR=""

zinstaller_version="0.7"
zinstaller_md5=$(md5 -q "$BASH_SOURCE")
tools_yml_md5=$(md5 -q "$YAML_FILE")

# Function to display usage information
usage() {
    cat << EOF
Usage: $(basename $0) [OPTIONS] [installDir]

OPTIONS:
  -h, --help                Show this help message and exit.
  --only-root               Only install packages that require root privileges.
  --only-without-root       Only install packages that do not require root privileges.
  --only-check              Only check the installation status of the packages without installing them.
  --skip-sdk                Skip default SDK download
  --install-sdk             Additionally install the SDK after installing the packages.
  --reinstall-venv          Remove existing virtual environment and create a new one.
  --portable                Install portable Python instead of global
  --select-sdk="SDK1 SDK2"  Specify space-separated SDKs to install. E.g., 'arm aarch64'

ARGUMENTS:
  installDir                The directory where the packages should be installed. 
                            Default is \$HOME/.zinstaller.

DESCRIPTION:
  This script installs host dependencies for Zephyr project on your system.
  By default, it installs all necessary packages without installing the SDK globally.
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
    --skip-sdk)
      skip_sdk_bool=true
      ;;
    --install-sdk)
      install_sdk_bool=true
      ;;
    --reinstall-venv)
      reinstall_venv_bool=true
      root_packages=false
      check_installed_bool=false
      ;;
    --portable)
      portable=true
      ;;
    --select-sdk=*)
      selected_sdk_list="${1#*=}"
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
    local computed_hash=$(shasum -a 256 "$file_path" | awk '{print $1}')

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
    python3 -m pip install git+https://github.com/HBehrens/puncover --quiet
    python3 -m pip install anytree --quiet
    python3 -m pip install -r "$REQUIREMENTS_DIR/requirements.txt" --quiet
}

if [[ $non_root_packages == true ]]; then
    pr_title "Install non portable tools"
    echo "This is MacOSX."

    # Check homebrew is installed
    if command -v brew >/dev/null 2>&1; then
        echo "Homebrew is installed."
    else
        pr_error 2 "Homebrew is not installed. Please install it first"
    fi

    echo "Installing the following packages: cmake ninja gperf python3 python-tk ccache dtc libmagic wget git yq"
    brew install cmake ninja gperf python3 python-tk ccache dtc libmagic wget git yq

    mkdir -p "$TMP_DIR"
    mkdir -p "$DL_DIR"
    mkdir -p "$TOOLS_DIR"

    # TODO to uncomment when portable yq is supported
    # pr_title "YQ"
    YQ="yq"
    # YQ_SOURCE=$(grep -A 10 'tool: yq' $YAML_FILE | grep -A 2 "$SELECTED_OS:" | grep 'source' | awk -F": " '{print $2}')
    # YQ_SHA256=$(grep -A 10 'tool: yq' $YAML_FILE | grep -A 2 "$SELECTED_OS:" | grep 'sha256' | awk -F": " '{print $2}')
    # download_and_check_hash "$YQ_SOURCE" "$YQ_SHA256" "$YQ"
    # YQ="$DL_DIR/$YQ"
    # chmod +x $YQ

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
            echo "source_${tool}=\"$source\"" >> $MANIFEST_FILE
            echo "sha256_${tool}=\"$sha256\"" >> $MANIFEST_FILE
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
      source "$ENV_FILE" &> /dev/null
      install_python_venv "$INSTALL_DIR" "$TMP_DIR"
	    rm -rf $TMP_DIR
      exit 0
    fi

    # if [ $portable = true ]; then
    #   # Install portable packages
    #   # Python-portable ?
    # fi

    pr_title "Python VENV"
    install_python_venv "$INSTALL_DIR" "$TMP_DIR"

    if ! command -v west &> /dev/null; then
    echo "West is not available. Something is wrong !!"
    else
    echo "West is available."
    fi

    env_script() {
    cat << EOF
#!/bin/bash

base_dir="\$(dirname "\$(realpath "\${BASH_SOURCE[0]}")")"

# Default virtual environment activation script path
default_venv_activate_path="\$base_dir/.venv/bin/activate"

# Use the provided PYTHON_VENV_ACTIVATE_PATH if set and not empty, otherwise use the default path
if [[ -n "\$PYTHON_VENV_ACTIVATE_PATH" ]]; then
    venv_activate_path="\$PYTHON_VENV_ACTIVATE_PATH"
else
    venv_activate_path="\$default_venv_activate_path"
fi

# Check if the activation script exists at the specified path
if [[ -f "\$venv_activate_path" ]]; then
    # Source the virtual environment activation script
    source "\$venv_activate_path"
    echo "Activated virtual environment at \$venv_activate_path"
else
    echo "Error: Virtual environment activation script not found at \$venv_activate_path."
fi

if ! command -v west &> /dev/null; then
   echo "West is not available. Something is wrong !!"
else
   echo "West is available."
fi

EOF
    }

    env_script > $ENV_FILE
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
			python) version=$(echo "$version" | sed -n 's/Python //p' | awk '{print $1}') ;;
			cmake) version=$(echo "$version" | sed -n 's/cmake version //p' | awk '{print $1}') ;;
			ninja) version=$(echo "$version") ;;
			openssl) version=$(echo "$version" | sed -n 's/OpenSSL //p' | awk '{print $1}') ;;
			git) version=$(echo "$version" | sed -n 's/git version //p' | awk '{print $1}') ;;
			gperf) version=$(echo "$version" | sed -n 's/GNU gperf //p' | awk '{print $1}') ;;
			ccache) version=$(echo "$version" | sed -n 's/ccache version //p' | awk '{print $1}') ;;
			dfu-util) version=$(echo "$version" | sed -n 's/dfu-util //p' | awk '{print $1}') ;;
			wget) version=$(echo "$version" | sed -n 's/GNU Wget //p' | awk '{print $1}') ;;
			xz-utils) version=$(echo "$version" | sed -n 's/xz \(XZ Utils\) //p' | awk '{print $1}') ;;
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
