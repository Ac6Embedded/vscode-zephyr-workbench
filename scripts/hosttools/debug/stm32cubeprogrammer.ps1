param (
    [string]$File,       # Downloaded archive (.zip or .exe)
    [string]$DestDir,    # Temporary working directory
    [string]$ToolsDir    # Base tools directory (.zinstaller/tools)
)

function Extract-ArchiveFile {
    param (
        [string]$ZipFilePath,    
        [string]$DestinationDirectory
    )

    # Locate 7-Zip
    $SevenZ = "C:\Program Files\7-Zip\7z.exe"
    if (-not (Test-Path $SevenZ)) {
        Write-Output "ERROR: 7-Zip not found at $SevenZ"
        exit 1
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
$TempExtractDir = Join-Path -Path $ToolsDir -ChildPath "${ToolName}_tmp"
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

Write-Output "Running installer: $Installer /S"
$process = Start-Process -FilePath $Installer -ArgumentList "/S" -Wait -PassThru

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

# ✅ Explicitly signal success to main script
$global:LastExitCode = 0
exit 0
