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

$TemporaryExtractedDirectory = Join-Path -Path $ToolsDir -ChildPath "stm32cubeprogrammer"

New-Item -Path $TemporaryExtractedDirectory -ItemType Directory -Force > $null 2>&1
Write-Output "Extracting $File... into $TemporaryExtractedDirectory"
Extract-ArchiveFile "$File" "$TemporaryExtractedDirectory"

Write-Output "Run installer..."
$Installer = Join-Path -Path $TemporaryExtractedDirectory -ChildPath "SetupSTM32CubeProgrammer_win64.exe"
& $Installer
