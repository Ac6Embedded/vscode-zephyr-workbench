param (
    [string]$File,
    [string]$ToolsDir,
    [string]$TmpDir
)

$ScriptName = [System.IO.Path]::GetFileNameWithoutExtension($PSCommandPath)
$ToolName = $ScriptName
$ToolDir = Join-Path -Path $ToolsDir -ChildPath ("openocds\" + $ToolName)

New-Item -Path (Join-Path $ToolsDir 'openocds') -ItemType Directory -Force > $null 2>&1

if ($File -and $File -ne "") {
    $proc = Start-Process -FilePath $File -ArgumentList "/VERYSILENT /NORESTART /SP- /SUPPRESSMSGBOXES" -PassThru -Wait -Verb RunAs
    if ($proc.ExitCode -ne 0) {
        Write-Output "ERROR: Installer exited with code $($proc.ExitCode)"
        exit $proc.ExitCode
    }

    $InfDir = Get-ChildItem "C:\Infineon\Tools" -Directory -Filter "ModusToolboxProgtools-*" -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $InfDir) {
        Write-Output "ERROR: Could not find ModusToolboxProgtools installation directory under C:\Infineon\Tools."
        exit 1
    }

    $SourceDir = Join-Path $InfDir.FullName "openocd"
    if (-not (Test-Path $SourceDir)) {
        Write-Output "ERROR: openocd not found in $($InfDir.FullName)"
        exit 1
    }

    if (Test-Path $ToolDir) { Remove-Item -Path $ToolDir -Recurse -Force -ErrorAction SilentlyContinue }
    Copy-Item -Path $SourceDir -Destination $ToolDir -Recurse -Force
    Write-Output "Copied openocd to $ToolDir"
}

$global:LastExitCode = 0
exit 0
