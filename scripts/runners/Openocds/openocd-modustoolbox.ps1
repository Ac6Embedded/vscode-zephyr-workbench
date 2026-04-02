param (
    [string]$File,
    [string]$ToolsDir,
    [string]$TmpDir
)

$ToolName = "openocd-modustoolbox"
$ToolDir = Join-Path -Path $ToolsDir -ChildPath ("openocds\" + $ToolName)

New-Item -Path (Join-Path $ToolsDir 'openocds') -ItemType Directory -Force > $null 2>&1

# Run the Infineon installer silently
Write-Output "Running Infineon installer silently: $File"
$process = Start-Process -FilePath $File -ArgumentList "/S" -PassThru -Wait

if ($process.ExitCode -ne 0) {
    Write-Output "ERROR: Installer failed with exit code $($process.ExitCode)"
    exit $process.ExitCode
}

# Find the openocd folder installed by the Infineon installer
$infineonBase = "C:/Infineon/Tools"
$openocdSource = Get-ChildItem -Path $infineonBase -Filter "ModusToolboxProgtools-*" -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    Select-Object -First 1

if (-not $openocdSource) {
    Write-Output "ERROR: Could not find ModusToolboxProgtools installation in $infineonBase"
    exit 1
}

$openocdPath = Join-Path $openocdSource.FullName "openocd"

if (-not (Test-Path $openocdPath)) {
    Write-Output "ERROR: openocd folder not found at $openocdPath"
    exit 1
}

# Copy openocd folder to .zinstaller
Write-Output "Copying openocd from $openocdPath to $ToolDir ..."
if (Test-Path $ToolDir) {
    Remove-Item -Path $ToolDir -Recurse -Force -ErrorAction SilentlyContinue
}
Copy-Item -Path $openocdPath -Destination $ToolDir -Recurse -Force

Write-Output "$ToolName installed successfully to $ToolDir"
$global:LastExitCode = 0
exit 0
