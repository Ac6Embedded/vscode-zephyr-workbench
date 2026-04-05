param (
    [string]$File,
    [string]$ToolsDir,
    [string]$TmpDir
)

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

    Write-Output "Detected vendor OpenOCD at $SourceDir"
}

$global:LastExitCode = 0
exit 0
