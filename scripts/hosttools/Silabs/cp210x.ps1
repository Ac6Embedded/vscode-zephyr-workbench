param (
    [string]$File,
    [string]$DestDir,
    [string]$TmpDir     # Base temporary directory (e.g., .zinstaller\tmp)
)

function Extract-ArchiveFile {
    param (
        [string]$ZipFilePath,    
        [string]$DestinationDirectory
    )
    
    # Ensure the destination directory exists
    New-Item -Path $DestinationDirectory -ItemType Directory -Force > $null

    # Extract the file silently
    & $SevenZ x "$ZipFilePath" -o"$DestinationDirectory" -y -bso0 -bsp0

    if ($LastExitCode -eq 0) {
        Write-Output "Extraction successful: $ZipFilePath"
    } else {
        Write-Output "ERROR: Failed to extract $ZipFilePath"
        return $LastExitCode
    }
}

$TemporaryExtractedDirectory = Join-Path -Path $TmpDir -ChildPath "cp210x"

New-Item -Path $TemporaryExtractedDirectory -ItemType Directory -Force > $null 2>&1
Write-Output "Extracting $File... into $TemporaryExtractedDirectory"
Extract-ArchiveFile "$File" "$TemporaryExtractedDirectory"

# Verify the INF file exists before installation
$InfFile = Join-Path -Path $TemporaryExtractedDirectory -ChildPath "silabser.inf"
if (Test-Path $InfFile) {
    Write-Output "Installing driver from Windows Update..."
    # Prepare the arguments to pass to the new PowerShell process
    $arguments = "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "pnputil /add-driver `"$InfFile`" /install"

    # Start the process with elevated permissions
    $process = Start-Process powershell -Verb runAs -ArgumentList $arguments -PassThru -Wait
    if ($process.ExitCode -eq 0) {
        Write-Output "Driver installation successful"
    } else {
        Write-Output "Failed to install driver"
    }

} else {
    Write-Error "ERROR: Driver INF file not found at $InfFile"
    exit 1
}

