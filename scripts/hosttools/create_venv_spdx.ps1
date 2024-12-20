param (
  [Parameter(Mandatory=$true)]
  [string]$InstallDir
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

function Install-PythonVenv {
  param (
      [string]$InstallDirectory
  )

  Print-Title "Install SPDX tools"

  python -m venv "$InstallDirectory\.venv-spdx"
  . "$InstallDirectory\.venv-spdx\Scripts\Activate.ps1"
  python -m pip install ntia-conformance-checker
  python -m pip install cve-bin-tool
  python -m pip install sbom2doc
}

Install-PythonVenv -InstallDirectory $InstallDir
