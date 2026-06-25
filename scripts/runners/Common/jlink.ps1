param (
    [string]$File,      # unused: jlink is script-only ($File is empty)
    [string]$ToolsDir,  # base tools directory (.zinstaller\tools)
    [string]$TmpDir     # base temporary directory (.zinstaller\tmp)
)

# J-Link is declared script-only (os.windows: true in debug-tools.yml) so this
# script downloads the pinned SEGGER Windows installer itself, reading its URL
# from the yaml (segger-sources.windows), and runs it. The installer puts J-Link
# in C:\Program Files\SEGGER\JLink*, which the windows auto-detect globs cover.

# --- Resolve yaml + yq ---
$ScriptDir = Split-Path -Parent $PSCommandPath
$ParentDir = Split-Path -Parent $ScriptDir
$YamlFile = Join-Path $ParentDir "debug-tools.yml"

if (-not (Test-Path $YamlFile)) {
    Write-Output "ERROR: debug-tools.yml not found at $YamlFile"
    exit 1
}

$Yq = "yq.exe"
if (-not (Get-Command $Yq -ErrorAction SilentlyContinue)) {
    $YqPath = Join-Path $ToolsDir "yq\yq.exe"
    if (Test-Path $YqPath) { $Yq = $YqPath }
    else { Write-Output "ERROR: yq not found in PATH or tools directory."; exit 1 }
}

# --- Read the Windows installer URL from the yaml (no hardcoding) ---
$ExeUrl = & $Yq eval -r '.debug_tools[] | select(.tool == "jlink") | .["segger-sources"].windows' $YamlFile
$ExeUrl = ($ExeUrl | Select-Object -First 1).ToString().Trim()
if (-not $ExeUrl -or $ExeUrl -eq "" -or $ExeUrl -eq "null") {
    Write-Output "ERROR: no jlink segger-sources.windows URL found in $YamlFile"
    exit 2
}

# --- Download the installer (SEGGER requires accepting the license via POST) ---
New-Item -Path $TmpDir -ItemType Directory -Force > $null 2>&1
$ExeFile = Join-Path $TmpDir ([System.IO.Path]::GetFileName(($ExeUrl -split '\?')[0]))
Write-Output "Downloading J-Link installer: $ExeUrl"
$ProgressPreference = 'SilentlyContinue'
$postParams = @{
    accept_license_agreement = 'accepted'
    submit                   = 'Download software'
}
Invoke-WebRequest -Uri $ExeUrl -Method POST -Body $postParams -OutFile $ExeFile -ErrorAction Stop

if (-not (Test-Path $ExeFile)) {
    Write-Output "ERROR: failed to download J-Link installer."
    exit 1
}

# --- Run the SEGGER installer (it self-elevates via UAC) ---
Write-Output "Running J-Link installer: $ExeFile"
$proc = Start-Process -FilePath $ExeFile -PassThru -Wait
if ($proc.ExitCode -ne 0) {
    Write-Output "ERROR: J-Link installer exited with code $($proc.ExitCode)"
    exit $proc.ExitCode
}

Write-Output "J-Link installed."
exit 0
