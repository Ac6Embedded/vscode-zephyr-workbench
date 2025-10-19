param (
    [string]$File,      # Path or URL to the J-Link installer
    [string]$ToolsDir,   # Base tools directory (.zinstaller/tools)
    [string]$TmpDir   # Temporary directory (.zinstaller/tmp)
)

$ToolName = "jlink"
$ToolDir = Join-Path -Path $ToolsDir -ChildPath $ToolName
$InstallerFile = Join-Path -Path $TmpDir -ChildPath "JLink_Windows_Installer.exe"

# Ensure destination directory exists
New-Item -Path $ToolDir -ItemType Directory -Force > $null 2>&1

# Local or download ---
if (Test-Path $File) {
    Write-Output "Local J-Link installer detected: $File"
    Copy-Item -Path $File -Destination $InstallerFile -Force
}
elseif ($File -match "^https://www\.segger\.com/downloads/jlink/") {
    Write-Output "Downloading J-Link from SEGGER (license auto-accepted)..."
    try {
        $PostParams = @{
            accept_license_agreement = 'accepted'
            submit                   = 'Download software'
        }
        Invoke-WebRequest -Uri $File -Method POST -Body $PostParams -OutFile $InstallerFile -ErrorAction Stop
        Write-Output "Downloaded J-Link installer successfully."
    } catch {
        Write-Output "ERROR: Failed to download J-Link installer from SEGGER."
        exit 1
    }
}
else {
    Write-Output "ERROR: Invalid installer source: $File"
    exit 1
}

# Run the installer silently ---
Write-Output "Installing SEGGER J-Link silently..."
try {
    Start-Process -FilePath $InstallerFile -ArgumentList "/S" -Wait -NoNewWindow
    if ($LastExitCode -eq 0) {
        Write-Output "J-Link installed successfully."
    } else {
        Write-Output "ERROR: J-Link installation failed with exit code $LastExitCode"
        exit $LastExitCode
    }
} catch {
    Write-Output "ERROR: Failed to execute J-Link installer."
    exit 1
}

# Locate installation path ---
$ProgramFiles64 = ${env:ProgramW6432}
$ProgramFiles32 = ${env:ProgramFiles(x86)}

$SearchPaths = @()
if ($ProgramFiles64) { $SearchPaths += (Join-Path $ProgramFiles64 "SEGGER") }
if ($ProgramFiles32) { $SearchPaths += (Join-Path $ProgramFiles32 "SEGGER") }
$SearchPaths += "C:\Program Files\SEGGER", "C:\Program Files (x86)\SEGGER"

$JLinkExe = $null
$LatestDir = $null

foreach ($BaseDir in $SearchPaths) {
    if (Test-Path $BaseDir) {
        $JLinkDirs = Get-ChildItem -Path $BaseDir -Directory | Where-Object { $_.Name -like "JLink_V*" }
        if ($JLinkDirs.Count -gt 0) {
            $LatestDir = $JLinkDirs | Sort-Object Name -Descending | Select-Object -First 1
            $Candidate = Join-Path $LatestDir.FullName "JLink.exe"
            if (Test-Path $Candidate) {
                $JLinkExe = $Candidate
                break
            }
        }
    }
}

if (-not $JLinkExe) {
    Write-Output "WARNING: No J-Link installation found."
    $SearchPaths | ForEach-Object { Write-Output " - $_" }
    exit 0
}

Write-Output "Detected latest J-Link version:"
Write-Output " -> $JLinkExe"


# --- Source env-utils.ps1 ---
$ScriptDir = Split-Path -Parent $PSCommandPath
$ParentDir = Split-Path -Parent $ScriptDir
$EnvUtils = Join-Path $ParentDir "env-utils.ps1"

if (Test-Path $EnvUtils) {
    . $EnvUtils
    Write-Output "Loaded environment utilities from $EnvUtils"
} else {
    Write-Output "ERROR: env-utils.ps1 not found at $EnvUtils"
    exit 1
}

$Yq = "yq.exe"
$ZInstallerBase = Split-Path -Parent $ToolsDir
$EnvYaml = Join-Path -Path $ZInstallerBase -ChildPath "env.yml"
# $EnvPs1 = Join-Path -Path $ZInstallerBase -ChildPath "env.ps1"
# $EnvCmd = Join-Path -Path $ZInstallerBase -ChildPath "env.cmd"
# $EnvSh = Join-Path -Path $ZInstallerBase -ChildPath "env.sh"

$Version = ($LatestDir.Name -replace '^JLink_', '')
$PathForYaml = $LatestDir.FullName -replace '\\', '/'
# $JLinkPathPs1 = $PathForYaml -replace '/', '\'
# $PathForSh = $PathForYaml  # already in forward-slash format

# Update-EnvPs1PathBlock -ToolName "jlink" -EnvPs1Path $EnvPs1 -ToolPath $JLinkPathPs1
Update-EnvYamlBlock -ToolName "jlink" -YqPath $Yq -EnvYamlPath $EnvYaml -ToolPath $PathForYaml -Version $Version
# Update-EnvCmdPathBlock -ToolName "jlink" -EnvCmdPath $EnvCmd -ToolPath $JLinkPathPs1

# Update-EnvShPathBlock -ToolName "jlink" -EnvShPath $EnvSh -ToolPath $PathForSh

exit 0
