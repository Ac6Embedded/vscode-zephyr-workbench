param (
    [Parameter(Mandatory = $true)]
    [string]$InstallDir
)

$ScriptPath = $MyInvocation.MyCommand.Path
$ScriptDirectory = Split-Path -Parent $ScriptPath
$SelectedOperatingSystem = "windows"

function Print-Title {
    param (
        [string[]]$Params
    )

    $Width = 40
    $Border = "-" * $Width

    foreach ($Param in $Params) {
        $TextLength = $Param.Length
        $LeftPadding = [math]::Floor(($Width - $TextLength) / 2)
        $FormattedText = (" " * $LeftPadding) + $Param
        Write-Output $Border
        Write-Output $FormattedText
        Write-Output $Border
    }
}

function Print-Error {
    param (
        [int]$Index,
        [string]$Message
    )
    Write-Output "ERROR: $Message"
    exit $Index
}

function Print-Warning {
    param (
        [string]$Message
    )
    Write-Output "WARN: $Message"
}

function Show-Help {
    $helpText = @"
Usage: create_venv.ps1 [options] [InstallDir]

Options:
-h, --help, /?         Show this help message and exit.

Arguments:
InstallDir             The directory where the Zephyr environment will be installed.

Examples:
create_venv.ps1 "C:\my\install\path"
"@
    Write-Host $helpText
}

# Handle help flag
if ($args.Count -gt 0 -and ($args[0] -eq "-h" -or $args[0] -eq "--help" -or $args[0] -eq "/?")) {
    Show-Help
    exit
}

function Download-File {
    param (
        [string]$SourceUrl,
        [string]$DestinationPath
    )

    Write-Output "Downloading: $SourceUrl -> $DestinationPath"
    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $SourceUrl -OutFile $DestinationPath -UseBasicParsing -ErrorAction Stop
    } catch {
        Print-Error 1 "Failed to download $SourceUrl. $_"
    }

    if (-Not (Test-Path -Path $DestinationPath)) {
        Print-Error 1 "File not found after download: $DestinationPath"
    }
}

function Extract-ArchiveFile {
    param (
        [string]$ZipFilePath,
        [string]$DestinationDirectory
    )

    if (-Not (Test-Path $ZipFilePath)) {
        Print-Error 3 "Archive not found: $ZipFilePath"
    }

    New-Item -Path $DestinationDirectory -ItemType Directory -Force > $null
    $SevenZ = "7z"
    & $SevenZ x "$ZipFilePath" -o"$DestinationDirectory" -y -bso0 -bsp0

    if ($LastExitCode -eq 0) {
        Write-Output "Extraction successful: $ZipFilePath"
    } else {
        Print-Error $LastExitCode "Failed to extract $ZipFilePath"
    }
}

function Install-PythonVenv {
    param (
        [string]$InstallDirectory
    )

    Print-Title "Zephyr Python Environment Setup"
    $RequirementsDirectory = "$TemporaryDirectory\requirements"
    $RequirementsBaseUrl = "https://raw.githubusercontent.com/zephyrproject-rtos/zephyr/main/scripts"

    New-Item -Path "$RequirementsDirectory" -ItemType Directory -Force > $null 2>&1

    # Download requirements files
    $RequirementFiles = @(
        "requirements.txt",
        "requirements-run-test.txt",
        "requirements-extras.txt",
        "requirements-compliance.txt",
        "requirements-build-test.txt",
        "requirements-base.txt"
    )

    foreach ($File in $RequirementFiles) {
        Download-File "$RequirementsBaseUrl/$File" "$RequirementsDirectory\$File"
    }

    Write-Output "Creating Python virtual environment..."
    python -m venv "$InstallDirectory\.venv"

    Write-Output "Activating virtual environment..."
    . "$InstallDirectory\.venv\Scripts\Activate.ps1"

    Write-Output "Installing Python dependencies..."
    python -m pip install --upgrade pip setuptools wheel
    python -m pip install windows-curses west pyelftools anytree pyyaml
    python -m pip install puncover
    python -m pip install -r "$RequirementsDirectory\requirements.txt"

    Write-Output "Python virtual environment setup complete."
}

# === MAIN EXECUTION ===
Print-Title "Zephyr Environment Setup"

$TemporaryDirectory = "$InstallDir\.zinstaller"
$DownloadDirectory = "$TemporaryDirectory\downloads"
$WorkDirectory = "$TemporaryDirectory\workdir"

# Create working directories
New-Item -Path $TemporaryDirectory -ItemType Directory -Force > $null 2>&1
New-Item -Path $DownloadDirectory -ItemType Directory -Force > $null 2>&1
New-Item -Path $WorkDirectory -ItemType Directory -Force > $null 2>&1

# Install Python venv and Zephyr requirements
Install-PythonVenv -InstallDirectory $InstallDir

# Cleanup
Write-Output "Cleaning up temporary files..."
Remove-Item -Path $TemporaryDirectory -Recurse -Force

Print-Title "Setup Complete"
Write-Output "Zephyr environment installed successfully in: $InstallDir"
