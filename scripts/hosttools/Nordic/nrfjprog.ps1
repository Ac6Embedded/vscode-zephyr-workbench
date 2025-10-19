param (
    [string]$File,
    [string]$ToolsDir,   # Base tools directory (e.g., .zinstaller\tools)
    [string]$TmpDir     # Base temporary directory (e.g., .zinstaller\tmp)
)

function Extract-ArchiveFile {
    param (
        [string]$ZipFilePath,
        [string]$DestinationDirectory
    )

    New-Item -Path $DestinationDirectory -ItemType Directory -Force > $null

    Write-Output "Extracting $ZipFilePath into $DestinationDirectory ..."
    & $SevenZ x "$ZipFilePath" -o"$DestinationDirectory" -y -bso0 -bsp0

    if ($LastExitCode -eq 0) {
        Write-Output "Extraction successful: $ZipFilePath"
    } else {
        Write-Output "ERROR: Extraction failed for $ZipFilePath"
        exit $LastExitCode
    }
}

# Determine working directory for extraction if needed
$ExtractDir = Join-Path -Path $ToolsDir -ChildPath "nrfjprog_tmp"
New-Item -Path $ExtractDir -ItemType Directory -Force > $null 2>&1

# Determine if the downloaded file is an archive or a direct executable
if ($File -match "\.zip$") {
    Write-Output "Archive detected: $File"
    Extract-ArchiveFile "$File" "$ExtractDir"
    
    # Try to locate the actual installer inside the extracted contents
    $ExePath = Get-ChildItem -Path $ExtractDir -Filter "nrf-command-line-tools-*.exe" -Recurse | Select-Object -First 1
    if (-not $ExePath) {
        Write-Output "ERROR: Could not find installer in extracted folder."
        exit 1
    }
} else {
    # Direct executable
    $ExePath = Get-Item $File
}

Write-Output "Running installer: $($ExePath.FullName) /S (waiting for completion...)"

# Start the process and wait for it to finish
$process = Start-Process -FilePath $ExePath.FullName -ArgumentList "/S" -PassThru -Wait

# Check the installer’s exit code
if ($process.ExitCode -eq 0) {
    Write-Output "nRF Command Line Tools installed successfully."
} else {
    Write-Output "ERROR: Installation failed with exit code $($process.ExitCode)"
    exit $process.ExitCode
}

# Cleanup temporary extraction directory
Remove-Item -Path $ExtractDir -Recurse -Force -ErrorAction SilentlyContinue

# --- Source env-utils.ps1 &  debug-tools.yml and get yq & version ---
$ScriptDir = Split-Path -Parent $PSCommandPath
$ParentDir = Split-Path -Parent $ScriptDir
$EnvUtils = Join-Path $ParentDir "env-utils.ps1"
$YamlFile = Join-Path $ParentDir "debug-tools.yml"
$ZInstallerBase = Split-Path -Parent $ToolsDir
$EnvYaml = Join-Path -Path $ZInstallerBase -ChildPath "env.yml"

if (Test-Path $EnvUtils) {
    . $EnvUtils
    Write-Output "Loaded environment utilities from $EnvUtils"
} else {
    Write-Output "ERROR: env-utils.ps1 not found at $EnvUtils"
    exit 1
}

if (-not (Test-Path $YamlFile)) {
    Write-Output "ERROR: debug-tools.yml not found at $YamlFile"
    exit 1
}

$Yq = "yq.exe"
if (-not (Get-Command $Yq -ErrorAction SilentlyContinue)) {
    $YqPath = Join-Path $ToolsDir "yq\yq.exe"
    if (Test-Path $YqPath) {
        $Yq = $YqPath
    } else {
        Write-Output "ERROR: yq not found in PATH or tools directory."
        exit 1
    }
}

# Extract version using yq and normalize
$ToolName = [System.IO.Path]::GetFileNameWithoutExtension($PSCommandPath)

$env:TOOL = $ToolName
$Version = & $Yq eval -r '.debug_tools[] | select(.tool == strenv(TOOL)) | .version // "000"' $YamlFile
$Version = ($Version | Select-Object -First 1).ToString().Trim()

if (-not $Version -or $Version -eq "") {
    $Version = "000"
}

Write-Output "Detected version for ${ToolName}: $Version"

$PathForYaml = "C:/Program Files/Nordic Semiconductor/nrf-command-line-tools/bin"
$PathForYaml = $PathForYaml -replace '\\', '/'

Update-EnvYamlBlock -ToolName "nrfjprog" -YqPath $Yq -EnvYamlPath $EnvYaml -ToolPath "$PathForYaml" -Version $Version

exit 0