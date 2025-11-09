param (
    [string]$File,       # Downloaded archive (.7z)
    [string]$ToolsDir,   # Base tools directory (e.g., .zinstaller\tools)
    [string]$TmpDir     # Base temporary directory (e.g., .zinstaller\tmp)
)

function Extract-ArchiveFile {
    param (
        [string]$ArchivePath,
        [string]$DestinationDirectory
    )

    # Locate 7-Zip
    $SevenZ = "C:\Program Files\7-Zip\7z.exe"
    if (-not (Test-Path $SevenZ)) {
        $SevenZ = "C:\Program Files (x86)\7-Zip\7z.exe"
    }
    if (-not (Test-Path $SevenZ)) {
        Write-Output "ERROR: 7-Zip not found at standard locations."
        exit 1
    }

    # Ensure the destination directory exists
    New-Item -Path $DestinationDirectory -ItemType Directory -Force > $null

    Write-Output "Extracting archive: $ArchivePath → $DestinationDirectory"
    & $SevenZ x "$ArchivePath" -o"$DestinationDirectory" -y -bso0 -bsp0

    if ($LastExitCode -eq 0) {
        Write-Output "Extraction successful: $ArchivePath"
    } else {
        Write-Output "ERROR: Extraction failed for $ArchivePath (code $LastExitCode)"
        exit $LastExitCode
    }
}

# --- Main logic ---

$ToolName = "openocd"

# Final tools directory
$ToolDir = Join-Path -Path $ToolsDir -ChildPath $ToolName

# Temp extraction directory (under tmp)
$TempExtractDir = Join-Path -Path $TmpDir -ChildPath $ToolName

Write-Output "Preparing to install OpenOCD-Zephyr..."
Write-Output "File: $File"
Write-Output "Destination tools directory: $ToolDir"
Write-Output "Temporary extraction directory: $TempExtractDir"

# Ensure directories exist
New-Item -Path $TempExtractDir -ItemType Directory -Force > $null 2>&1
New-Item -Path $ToolDir -ItemType Directory -Force > $null 2>&1

# Extract archive to temp
Extract-ArchiveFile "$File" "$TempExtractDir"

# --- Move the extracted content correctly (archive contains 'openocd' folder) ---
$ExtractedOpenOcdDir = Join-Path $TempExtractDir "openocd"

if (Test-Path $ExtractedOpenOcdDir) {
    Write-Output "Moving contents of: $ExtractedOpenOcdDir → $ToolDir (overwrite existing files)"

    # Copy contents with overwrite (safe replacement)
    Copy-Item -Path (Join-Path $ExtractedOpenOcdDir '*') -Destination $ToolDir -Recurse -Force

    # Remove the original extracted folder
    Remove-Item -Path $ExtractedOpenOcdDir -Recurse -Force -ErrorAction SilentlyContinue
} else {
    # Fallback: if no 'openocd' wrapper, copy everything
    Write-Output "No 'openocd' wrapper folder found; copying all extracted files to $ToolDir..."
    Copy-Item -Path (Join-Path $TempExtractDir '*') -Destination $ToolDir -Recurse -Force
}

# Clean up temporary extraction directory
if (Test-Path $TempExtractDir) {
    Write-Output "Cleaning up temporary directory..."
    Remove-Item -Path $TempExtractDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output "OpenOCD-Zephyr installed successfully to: $ToolDir"

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

$PathForYaml = "$ToolsDir/openocd/bin"
$PathForYaml = $PathForYaml -replace '\\', '/'

Update-EnvYamlBlock -ToolName "openocd" -YqPath $Yq -EnvYamlPath $EnvYaml -ToolPath "$PathForYaml" -Version $Version

# Explicitly signal success
$global:LastExitCode = 0
exit 0
