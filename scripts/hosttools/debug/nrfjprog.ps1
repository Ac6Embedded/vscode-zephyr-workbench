param (
    [string]$File,
    [string]$DestDir,
    [string]$ToolsDir
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
$ExtractDir = Join-Path -Path $DestDir -ChildPath "nrfjprog_tmp"
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
