param (
    [string]$File,      # Path to the downloaded nrfutil.exe
    [string]$ToolsDir,   # Base tools directory (e.g., .zinstaller\tools)
    [string]$TmpDir     # Base temporary directory (e.g., .zinstaller\tmp)
)

$ToolName = "nrfutil"
$ToolDir = Join-Path -Path $ToolsDir -ChildPath $ToolName
$DestFile = Join-Path -Path $ToolDir -ChildPath "nrfutil.exe"

Write-Output "Installing $ToolName from $File..."

New-Item -Path $ToolDir -ItemType Directory -Force > $null 2>&1
Copy-Item -Path $File -Destination $DestFile -Force

if (Test-Path $DestFile) {
    Write-Output "$ToolName installed successfully to: $DestFile"
} else {
    Write-Output "ERROR: Failed to install $ToolName."
    exit 1
}

try {
    icacls $DestFile /grant Everyone:RX > $null 2>&1
} catch {
    Write-Output "Warning: Could not set permissions on $DestFile (non-fatal)."
}

# Install nrfutil device dependencies
& $DestFile install device --force

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
$env:TOOL = $ToolName
$Version = & $Yq eval -r '.debug_tools[] | select(.tool == strenv(TOOL)) | .version // "000"' $YamlFile
$Version = ($Version | Select-Object -First 1).ToString().Trim()

if (-not $Version -or $Version -eq "") {
    $Version = "000"
}

Write-Output "Detected version for ${ToolName}: $Version"

$PathForYaml = "$ToolDir"
$PathForYaml = $PathForYaml -replace '\\', '/'

Update-EnvYamlBlock -ToolName "nrfutil" -YqPath $Yq -EnvYamlPath $EnvYaml -ToolPath "$PathForYaml" -Version $Version

# Ensure success exit code
$global:LastExitCode = 0
exit 0
