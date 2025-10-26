param (
    [string]$File,       # Downloaded archive (.7z)
    [string]$ToolsDir,   # Base tools directory (e.g., .zinstaller\tools)
    [string]$TmpDir     # Base temporary directory (e.g., .zinstaller\tmp)
)


# Install or update pyOCD
pip install -U pyocd
if ($LastExitCode -eq 0) {
    Write-Output "pyOCD installation/update successful."

    # Get and display the installed version
    $pyocdVersion = pyocd --version 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Output "Current pyOCD version: $pyocdVersion"
    } else {
        Write-Output "WARNING: Could not retrieve pyOCD version."
    }
} else {
    Write-Output "ERROR: pyOCD installation failed (code $LastExitCode)"
    exit $LastExitCode
}
