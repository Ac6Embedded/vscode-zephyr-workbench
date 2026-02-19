param (
    [string]$File,
    [string]$ToolsDir,
    [string]$TmpDir
)

function Extract-ArchiveFile {
    param (
        [string]$ArchivePath,
        [string]$DestinationDirectory
    )

    $SevenZ = "C:\Program Files\7-Zip\7z.exe"
    if (-not (Test-Path $SevenZ)) { $SevenZ = "C:\Program Files (x86)\7-Zip\7z.exe" }
    if (-not (Test-Path $SevenZ)) {
        Write-Output "ERROR: 7-Zip not found at standard locations."
        exit 1
    }

    New-Item -Path $DestinationDirectory -ItemType Directory -Force > $null
    & $SevenZ x "$ArchivePath" -o"$DestinationDirectory" -y -bso0 -bsp0
    if ($LastExitCode -ne 0) {
        Write-Output "ERROR: Extraction failed for $ArchivePath (code $LastExitCode)"
        exit $LastExitCode
    }
}

$ScriptName = [System.IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
$ToolName = $ScriptName
$ToolDir = Join-Path -Path $ToolsDir -ChildPath ("openocds\" + $ToolName)
$TempExtractDir = Join-Path -Path $TmpDir -ChildPath $ToolName

New-Item -Path (Join-Path $ToolsDir 'openocds') -ItemType Directory -Force > $null 2>&1
New-Item -Path $TempExtractDir -ItemType Directory -Force > $null 2>&1

if ($File -and $File -ne "") {
    Extract-ArchiveFile "$File" "$TempExtractDir"

    $TopDirs = @(Get-ChildItem -Path $TempExtractDir -Directory -ErrorAction SilentlyContinue)
    $SourceDir = $null

    if ($TopDirs.Count -eq 1) {
        $SourceDir = $TopDirs[0].FullName
    } else {
        $OpenocdDir = Join-Path $TempExtractDir 'openocd'
        if (Test-Path $OpenocdDir) { $SourceDir = $OpenocdDir }
    }

    if (Test-Path $ToolDir) { Remove-Item -Path $ToolDir -Recurse -Force -ErrorAction SilentlyContinue }

    if ($SourceDir) {
        Move-Item -Path $SourceDir -Destination $ToolDir -Force
    } else {
        New-Item -Path $ToolDir -ItemType Directory -Force > $null 2>&1
        Copy-Item -Path (Join-Path $TempExtractDir '*') -Destination $ToolDir -Recurse -Force
    }
}

if (Test-Path $TempExtractDir) {
    Remove-Item -Path $TempExtractDir -Recurse -Force -ErrorAction SilentlyContinue
}

$global:LastExitCode = 0
exit 0
