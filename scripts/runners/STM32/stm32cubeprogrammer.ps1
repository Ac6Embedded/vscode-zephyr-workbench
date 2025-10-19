param (
    [string]$File,       # Downloaded archive (.zip or .exe)
    [string]$ToolsDir,    # Base tools directory (.zinstaller/tools) / not used here as it will be installed in Program Files
    [string]$TmpDir    # Temporary directory (.zinstaller/tmp)
)

function Extract-ArchiveFile {
    param (
        [string]$ZipFilePath,    
        [string]$DestinationDirectory
    )

    # --- Locate 7-Zip ---
    $SevenZ = "C:\Program Files\7-Zip\7z.exe"

    if (-not (Test-Path $SevenZ)) {
        # Try the (x86) path
        $SevenZ = "C:\Program Files (x86)\7-Zip\7z.exe"
    }

    if (-not (Test-Path $SevenZ)) {
        # Try locating 7z in PATH
        $SevenZCmd = Get-Command 7z.exe -ErrorAction SilentlyContinue
        if ($SevenZCmd) {
            $SevenZ = $SevenZCmd.Source
            Write-Output "Found 7-Zip in PATH: $SevenZ"
        }
    }

    if (-not (Test-Path $SevenZ)) {
        Write-Output "ERROR: 7-Zip not found in Program Files or PATH."
        exit 1
    } else {
        Write-Output "Using 7-Zip: $SevenZ"
    }

    # Ensure the destination directory exists
    New-Item -Path $DestinationDirectory -ItemType Directory -Force > $null

    Write-Output "Extracting archive: $ZipFilePath → $DestinationDirectory"
    & $SevenZ x "$ZipFilePath" -o"$DestinationDirectory" -y -bso0 -bsp0

    if ($LastExitCode -eq 0) {
        Write-Output "Extraction successful: $ZipFilePath"
    } else {
        Write-Output "ERROR: Extraction failed for $ZipFilePath (code $LastExitCode)"
        exit $LastExitCode
    }
}

# --- Main logic ---

$ToolName = "stm32cubeprogrammer"
$TempExtractDir = Join-Path -Path $TmpDir -ChildPath "${ToolName}_tmp"
$InstallerName = "SetupSTM32CubeProgrammer_win64.exe"

# Ensure extraction directory exists
New-Item -Path $TempExtractDir -ItemType Directory -Force > $null 2>&1

Write-Output "Preparing to install STM32CubeProgrammer..."
Write-Output "File: $File"
Write-Output "Temporary extraction directory: $TempExtractDir"

# If the file is a ZIP, extract first; otherwise, assume it’s a direct .exe installer
if ($File -match "\.zip$") {
    Extract-ArchiveFile "$File" "$TempExtractDir"
    $Installer = Join-Path -Path $TempExtractDir -ChildPath $InstallerName
} else {
    $Installer = $File
}

if (-not (Test-Path $Installer)) {
    Write-Output "ERROR: Installer not found: $Installer"
    exit 1
}

Write-Output "Running installer: $Installer"
$process = Start-Process -FilePath $Installer -ArgumentList -Wait -PassThru

if ($process.ExitCode -eq 0) {
    Write-Output "STM32CubeProgrammer installed successfully."
} else {
    Write-Output "ERROR: Installer exited with code $($process.ExitCode)"
    exit $process.ExitCode
}

# Clean up extraction directory
if (Test-Path $TempExtractDir) {
    Write-Output "Cleaning up temporary directory..."
    Remove-Item -Path $TempExtractDir -Recurse -Force -ErrorAction SilentlyContinue
}

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

$PathForYaml = 'C:\Program Files\STMicroelectronics\STM32Cube\STM32CubeProgrammer\bin'
$PathForYaml = $PathForYaml -replace '\\', '/'

Update-EnvYamlBlock -ToolName "stm32cubeprogrammer" -YqPath $Yq -EnvYamlPath $EnvYaml -ToolPath "$PathForYaml" -Version $Version

# Explicitly signal success to main script
$global:LastExitCode = 0
exit 0
