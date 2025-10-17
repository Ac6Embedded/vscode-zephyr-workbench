param (
    [string]$File,      # Path or URL to the J-Link installer
    [string]$DestDir,   # Base tools directory (.zinstaller/tools)
    [string]$ToolsDir   # Temporary directory (unused here)
)

$ToolName = "jlink"
$ToolDir = Join-Path -Path $DestDir -ChildPath $ToolName
$InstallerFile = Join-Path -Path $ToolsDir -ChildPath "JLink_Windows_Installer.exe"

# Ensure destination directory exists
New-Item -Path $ToolDir -ItemType Directory -Force > $null 2>&1

# --- 1️ If $File is a local file, use it directly ---
if (Test-Path $File) {
    Write-Output "Local J-Link installer detected: $File"
    Copy-Item -Path $File -Destination $InstallerFile -Force
}

# --- 2️ Otherwise, try to download from SEGGER (accepting license) ---
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

# --- 3️ Invalid input case ---
else {
    Write-Output "ERROR: Invalid installer source: $File"
    exit 1
}

# --- 4️ Run the installer silently ---
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

# --- 5️ Verify installation path ---
$ProgramFiles64 = ${env:ProgramW6432}
$ProgramFiles32 = ${env:ProgramFiles(x86)}

$SearchPaths = @()

# Collect base SEGGER directories from both architectures
if ($ProgramFiles64) {
    $SearchPaths += (Join-Path $ProgramFiles64 "SEGGER")
}
if ($ProgramFiles32) {
    $SearchPaths += (Join-Path $ProgramFiles32 "SEGGER")
}

# Fallbacks, in case env vars are missing
$SearchPaths += @(
    "C:\Program Files\SEGGER",
    "C:\Program Files (x86)\SEGGER"
)

$JLinkExe = $null

foreach ($BaseDir in $SearchPaths) {
    if (Test-Path $BaseDir) {
        # Find all subfolders matching "JLink_*"
        $JLinkDirs = Get-ChildItem -Path $BaseDir -Directory | Where-Object { $_.Name -like "JLink_V*" }

        if ($JLinkDirs.Count -gt 0) {
            # Sort by version number (natural order)
            $LatestDir = $JLinkDirs | Sort-Object Name -Descending | Select-Object -First 1
            $Candidate = Join-Path $LatestDir.FullName "JLink.exe"

            if (Test-Path $Candidate) {
                $JLinkExe = $Candidate
                break
            }
        }
    }
}

if ($JLinkExe) {
    Write-Output "Detected latest J-Link version:"
    Write-Output " -> $JLinkExe"
} else {
    Write-Output "WARNING: No J-Link installation found."
    Write-Output "Checked directories:"
    $SearchPaths | ForEach-Object { Write-Output " - $_" }
}

exit 0
