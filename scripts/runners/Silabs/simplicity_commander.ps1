param (
    [string]$File,       # Downloaded Simplicity Commander ZIP
    [string]$ToolsDir,   # Base tools directory (e.g., .zinstaller\tools)
    [string]$TmpDir      # Temporary directory (e.g., .zinstaller\tmp)
)

function Extract-ArchiveFile {
    param (
        [string]$ZipFilePath,
        [string]$DestinationDirectory
    )

    if (-not (Test-Path $ZipFilePath)) {
        Write-Output "ERROR: Cannot find archive: $ZipFilePath"
        exit 1
    }

    # Ensure full absolute paths
    $ZipFilePath = (Resolve-Path $ZipFilePath).Path
    $DestinationDirectory = (Resolve-Path $DestinationDirectory).Path

    New-Item -Path $DestinationDirectory -ItemType Directory -Force > $null

    Write-Output "Extracting '$ZipFilePath' into '$DestinationDirectory' ..."
    & $SevenZ x "`"$ZipFilePath`"" "-o$DestinationDirectory" -y -bso0 -bsp0

    if ($LastExitCode -eq 0) {
        Write-Output "Extraction successful: $ZipFilePath"
    } else {
        Write-Output "ERROR: Extraction failed for $ZipFilePath (exit code: $LastExitCode)"
        exit $LastExitCode
    }
}

# --- Paths setup ---
$ExtractDir = Join-Path -Path $TmpDir -ChildPath "simplicity_tmp"
New-Item -Path $ExtractDir -ItemType Directory -Force > $null 2>&1

# --- Locate 7z (auto-detect) ---
$SevenZ = "7z.exe"
$SevenZPath = Join-Path $ToolsDir "7z\7z.exe"
if (Test-Path $SevenZPath) {
    $SevenZ = $SevenZPath
} elseif (-not (Get-Command $SevenZ -ErrorAction SilentlyContinue)) {
    Write-Output "ERROR: 7z.exe not found in PATH or tools directory."
    exit 1
}

# --- Step 1: Extract outer ZIP ---
if ($File -notmatch "\.zip$") {
    Write-Output "ERROR: Expected a ZIP file for Simplicity Commander, got $File"
    exit 1
}

Write-Output "Extracting main archive: $File ..."
Extract-ArchiveFile "$File" "$ExtractDir"

# --- Step 2: Locate Commander CLI inner ZIP (name varies) ---
$InnerZip = Get-ChildItem -Path $ExtractDir -Recurse -Filter "Commander-cli_win32_x64_*.zip" | Select-Object -First 1
if (-not $InnerZip) {
    Write-Output "ERROR: Could not find Commander-cli_win32_x64_*.zip inside extracted folder."
    exit 1
}

$InnerZipPath = $InnerZip.FullName
if (-not (Test-Path $InnerZipPath)) {
    Write-Output "ERROR: Inner ZIP not found at expected location: $InnerZipPath"
    exit 1
}

Write-Output "Found CLI archive: $InnerZipPath"

# --- Step 3: Extract CLI into tools directory ---
$CommanderDir = Join-Path -Path $ToolsDir -ChildPath "simplicity_commander"
New-Item -Path $CommanderDir -ItemType Directory -Force > $null 2>&1

Write-Output "Extracting CLI to $CommanderDir ..."
Extract-ArchiveFile "$InnerZipPath" "$CommanderDir"

# --- Step 4: Cleanup ---
Remove-Item -Path $ExtractDir -Recurse -Force -ErrorAction SilentlyContinue

# --- Step 5: Load env-utils.ps1 and update env.yml ---
$ScriptDir = Split-Path -Parent $PSCommandPath
$ParentDir = Split-Path -Parent $ScriptDir
$EnvUtils = Join-Path $ParentDir "env-utils.ps1"
$YamlFile = Join-Path $ParentDir "debug-tools.yml"
$ZInstallerBase = Split-Path -Parent $ToolsDir
$EnvYaml = Join-Path -Path $ZInstallerBase -ChildPath "env.yml"

if (Test-Path $EnvUtils) {
    . $EnvUtils
    Write-Output "Loaded environment utilities from $EnvUtils"
} else {
    Write-Output "ERROR: env-utils.ps1 not found at $EnvUtils"
    exit 1
}

if (-not (Test-Path $YamlFile)) {
    Write-Output "ERROR: debug-tools.yml not found at $YamlFile"
    exit 1
}

# --- Locate yq (auto-detect) ---
$Yq = "yq.exe"
$YqPath = Join-Path $ToolsDir "yq\yq.exe"
if (Test-Path $YqPath) {
    $Yq = $YqPath
} elseif (-not (Get-Command $Yq -ErrorAction SilentlyContinue)) {
    Write-Output "ERROR: yq not found in PATH or tools directory."
    exit 1
}

# --- Step 6: Detect actual version from commander-cli.exe ---
$CommanderCliExe = Join-Path $CommanderDir "Simplicity Commander CLI\commander-cli.exe"
if (-not (Test-Path $CommanderCliExe)) {
    Write-Output "ERROR: commander-cli.exe not found at expected location: $CommanderCliExe"
    exit 1
}

Write-Output "Detecting Simplicity Commander version..."
$VersionOutput = & $CommanderCliExe --version 2>&1
$VersionLine = $VersionOutput | Select-String -Pattern "^Simplicity Commander\s+(.+)$" | Select-Object -First 1

if ($VersionLine -and $VersionLine.Matches.Groups[1].Value) {
    $Version = $VersionLine.Matches.Groups[1].Value.Trim()
} else {
    Write-Output "WARNING: Could not detect version from CLI output, defaulting to 000"
    $Version = "000"
}

Write-Output "Detected version from CLI: $Version"

# --- Step 7: Update env.yml ---
$CommanderDir = $CommanderDir + "\Simplicity Commander CLI"
$PathForYaml = $CommanderDir -replace '\\', '/'
Update-EnvYamlBlock -ToolName "simplicity_commander" -YqPath $Yq -EnvYamlPath $EnvYaml -ToolPath "$PathForYaml" -Version $Version

Write-Output "Simplicity Commander CLI installed successfully at: $PathForYaml"
Write-Output "Version: $Version"
exit 0
