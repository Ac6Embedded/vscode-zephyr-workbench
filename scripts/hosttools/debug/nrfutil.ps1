param (
    [string]$File,      # Path to the downloaded nrfutil.exe
    [string]$DestDir,   # Base tools directory (.zinstaller/tools)
    [string]$ToolsDir   # Not used in this case, but kept for compatibility
)

$ToolName = "nrfutil"
$ToolDir = Join-Path -Path $DestDir -ChildPath $ToolName
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

# Ensure success exit code
$global:LastExitCode = 0
exit 0
