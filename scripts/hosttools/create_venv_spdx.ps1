param (
    [Parameter(Mandatory = $true,  Position = 0)]
    [string]$InstallDir,

    [Parameter(Mandatory = $true,  Position = 1)]
    [string]$HostToolsDir
)
$SelectedOperatingSystem = "windows"

$ScriptPath = $MyInvocation.MyCommand.Path
$ScriptDirectory = Split-Path -Parent $ScriptPath

function Print-Title {
  param (
      [string[]]$Params
  )
  
  $Width = 40
  $Border = "-" * $Width

  foreach ($Param in $Params) {
      $TextLength = $Param.Length
      $LeftPadding = [math]::Floor(($Width - $TextLength) / 2)
      $FormattedText = (" " * $LeftPadding) + $Param
      Write-Output $Border
      Write-Output $FormattedText
      Write-Output $Border
  }
}

function Print-Error {
  param (
      [int]$Index,
      [string]$Message
  )

  Write-Output "ERROR: $Message"
  return $Index
}

function Print-Warning {
  param (
      [string]$Message
  )

  Write-Output "WARN: $Message"
}

function Show-Help {
  $helpText = @"
Usage: create_venv_spdx.ps1 [options] [InstallDir]

Options:
-h, --help, /?         Show this help message and exit.

Arguments:
InstallDir             Optional. The directory where the local venv for SPDX tools.

Examples:
create_venv_spdx.ps1 "C:\my\install\path"
"@
  Write-Host $helpText
}

# Check for help flag
if ($args.Count -gt 0 -and ($args[0] -eq "-h" -or $args[0] -eq "--help" -or $args[0] -eq "/?")) {
  Show-Help
  exit
}

function Get-PythonExecutable {
    param(
        [string]$HostToolsDir
    )

    # portable copy
    $portable = Join-Path $HostToolsDir 'tools\python\python\python.exe'
    if (Test-Path $portable) {
        Write-Host "Using embedded Python: $portable"
        return $portable
    }

    # "python" in $env:Path
    $sysPython = (Get-Command python -CommandType Application -ErrorAction SilentlyContinue).Path
    if ($sysPython) {
        Write-Host "Using system Python: $sysPython"
        return $sysPython
    }

    # extra fallback
    $sysPython3 = (Get-Command python3 -CommandType Application -ErrorAction SilentlyContinue).Path
    if ($sysPython3) {
        Write-Host "Using system Python 3: $sysPython3"
        return $sysPython3
    }

    return $null
}

function Install-PythonVenv {
  param (
      [string]$InstallDirectory,
      [string]$HostToolsDir
  )

  $Python = Get-PythonExecutable -HostToolsDir $HostToolsDir
  if (-not $Python) {
      Print-Error 99 "Python was not found in: $HostToolsDir\tools\python\python.exe, please install Python or fix HostTools."
      exit 99
  }

  Print-Title "Install SPDX tools"

  & $Python -m venv "$InstallDirectory\.venv-spdx"
  . "$InstallDirectory\.venv-spdx\Scripts\Activate.ps1"

  python -m pip install ntia-conformance-checker
  python -m pip install cve-bin-tool
  python -m pip install sbom2doc
}

Install-PythonVenv -InstallDirectory $InstallDir -HostToolsDir $HostToolsDir
