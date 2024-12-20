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
Usage: create_venv.ps1 [options] [InstallDir]

Options:
-h, --help, /?         Show this help message and exit.

Arguments:
InstallDir             Optional. The directory where the Zephyr environment will be installed. Defaults to '$env:USERPROFILE\.zinstaller'.

Examples:
create_venv.ps1 "C:\my\install\path"
"@
  Write-Host $helpText
}

# Check for help flag
if ($args.Count -gt 0 -and ($args[0] -eq "-h" -or $args[0] -eq "--help" -or $args[0] -eq "/?")) {
  Show-Help
  exit
}

function Download-FileWithHashCheck {
  param (
      [string]$SourceUrl,
      [string]$ExpectedHash,
      [string]$Filename
  )

  # Full path where the file will be saved
  $FilePath = Join-Path -Path $DownloadDirectory -ChildPath $Filename

  Write-Output "Downloading: $Filename ..."

  if ($UseWget) {
      # Using wget for downloading
      & $Wget -q $SourceUrl -O $FilePath
  } else {
      # Using Invoke-WebRequest for downloading
      Invoke-WebRequest -Uri $SourceUrl -OutFile $FilePath -ErrorAction Stop
  }   
  # Check if the download was successful
  if (-Not (Test-Path -Path $FilePath)) {
      Print-Error 1 "Error: Failed to download the file."
      exit 1
  }

  # Compute the SHA-256 hash of the downloaded file
  $ComputedHash = Get-FileHash -Path $FilePath -Algorithm SHA256 | Select-Object -ExpandProperty Hash

  # Compare the computed hash with the expected hash
  if ($ComputedHash -eq $ExpectedHash) {
      Write-Output "DL: $Filename downloaded successfully"
  } else {
      Print-Error 2 "Error: Hash mismatch."
      Print-Error 2 "Expected: $ExpectedHash"
      Print-Error 2 "Computed: $ComputedHash"
      exit 2
  }
}

function Download-WithoutCheck {
  param (
      [string]$SourceUrl,
      [string]$Filename
  )

  # Full path where the file will be saved
  $FilePath = Join-Path -Path $DownloadDirectory -ChildPath $Filename

  Write-Output "Downloading: $Filename ..."

  if ($UseWget) {
      # Using wget for downloading
      & $Wget -q $SourceUrl -O $FilePath
  } else {
      # Using Invoke-WebRequest for downloading, make it silent, if not it will be very slow
      & {
           $ProgressPreference = 'SilentlyContinue'
           Invoke-WebRequest -Uri $SourceUrl -OutFile $FilePath -ErrorAction Stop
      }
  }   
  # Check if the download was successful
  if (-Not (Test-Path -Path $FilePath)) {
      Print-Error 1 "Error: Failed to download the file."
      exit 1
  }

}

function Test-FileExistence {
  param (
      [string]$FilePath  # Path to the file to check
  )
  
  if (-Not (Test-Path -Path $FilePath)) {
      Print-Error 3 "File does not exist: $FilePath"
      exit 3
  }
  else {
      Write-Output "File exists: $FilePath"
  }
}

# Function to generate manifest entries
function New-ManifestEntry {
  Param(
      [string]$Tool,
      [string]$OperatingSystem
  )
  # Using yq to parse the source and sha256 for the specific OS and tool
  $Source = & $Yq eval ".*_content[] | select(.tool == `"`"`"$Tool`"`"`") | .os.$OperatingSystem.source" $YamlFilePath
  $Sha256 = & $Yq eval ".*_content[] | select(.tool == `"`"`"$Tool`"`"`") | .os.$OperatingSystem.sha256" $YamlFilePath

  # Check if the source and sha256 are not null (meaning the tool supports the OS)
  if ($Source -ne 'null' -and $Sha256 -ne 'null') {
      $ManifestEntry = @"
`$${Tool}_array =  @('$Source','$Sha256')

"@
      Add-Content $ManifestFilePath $ManifestEntry
  }
}

function Extract-ArchiveFile {
  param (
      [string]$ZipFilePath,    
      [string]$DestinationDirectory
  )
  
  # Ensure the destination directory exists
  New-Item -Path $DestinationDirectory -ItemType Directory -Force > $null
  $SevenZ = "7z"
  # Extract the file silently
  & $SevenZ x "$ZipFilePath" -o"$DestinationDirectory" -y -bso0 -bsp0

  if ($LastExitCode -eq 0) {
      Write-Output "Extraction successful: $ZipFilePath"
  } else {
      Print-Error $LastExitCode "Failed to extract $ZipFilePath"
  }
}

function Install-PythonVenv {
  param (
      [string]$InstallDirectory
  )

  Print-Title "Zephyr Python-Requirements"
  $RequirementsDirectory = "$TemporaryDirectory\requirements"
  $RequirementsBaseUrl = "https://raw.githubusercontent.com/zephyrproject-rtos/zephyr/main/scripts"

  New-Item -Path "$RequirementsDirectory" -ItemType Directory -Force > $null 2>&1

  Download-WithoutCheck "$RequirementsBaseUrl/requirements.txt" "requirements.txt"
  Download-WithoutCheck "$RequirementsBaseUrl/requirements-run-test.txt" "requirements-run-test.txt"
  Download-WithoutCheck "$RequirementsBaseUrl/requirements-extras.txt" "requirements-extras.txt"
  Download-WithoutCheck "$RequirementsBaseUrl/requirements-compliance.txt" "requirements-compliance.txt"
  Download-WithoutCheck "$RequirementsBaseUrl/requirements-build-test.txt" "requirements-build-test.txt"
  Download-WithoutCheck "$RequirementsBaseUrl/requirements-base.txt" "requirements-base.txt"
  Move-Item -Path "$DownloadDirectory/require*.txt" -Destination "$RequirementsDirectory"

  python -m venv "$InstallDirectory\.venv"
  . "$InstallDirectory\.venv\Scripts\Activate.ps1"
  python -m pip install setuptools wheel windows-curses west pyelftools --quiet
  python -m pip install git+https://github.com/HBehrens/puncover --quiet
  python -m pip install anytree --quiet
  python -m pip install -r "$RequirementsDirectory\requirements.txt" --quiet
}

$TemporaryDirectory = "$InstallDir\.zinstaller"
$YamlFilePath = "$ScriptDirectory\tools.yml"
$ManifestFilePath = "$TemporaryDirectory\manifest.ps1"
$DownloadDirectory = "$TemporaryDirectory\downloads"
$WorkDirectory = "$TemporaryDirectory\workdir"

New-Item -Path $TemporaryDirectory -ItemType Directory -Force > $null 2>&1
New-Item -Path $DownloadDirectory -ItemType Directory -Force > $null 2>&1
New-Item -Path $WorkDirectory -ItemType Directory -Force > $null 2>&1

# Download and verify yq
Print-Title "YQ"
$YqExecutable = "yq.exe"

# Read the content of the YAML file
$YamlContent = Get-Content -Path $YamlFilePath

# Initialize variables to store the source and sha256 values
$YqSource = ""
$YqSha256 = ""

# Flag variables to track the position in the file
$FoundTool = $false
$FoundOS = $false

# Iterate through each line of the YAML content
foreach ($Line in $YamlContent) {
  if ($Line -match "^\s*- tool: yq") {
      $FoundTool = $true
  } elseif ($FoundTool -and $Line -match "^\s*${SelectedOperatingSystem}:") {
      $FoundOS = $true
  } elseif ($FoundOS -and $Line -match "^\s*source:") {
      $YqSource = $Line -split "source:\s*" | Select-Object -Last 1
  } elseif ($FoundOS -and $Line -match "^\s*sha256:") {
      $YqSha256 = $Line -split "sha256:\s*" | Select-Object -Last 1
      break
  }
}

Download-FileWithHashCheck $YqSource $YqSha256 $YqExecutable
$Yq = Join-Path -Path $DownloadDirectory -ChildPath $YqExecutable
Test-FileExistence -FilePath $Yq

Print-Title "Parse YAML and generate manifest"
"# Automatically generated by Zinstaller on Powershell" | Out-File -FilePath $ManifestFilePath

# List all tools from the YAML file
$ToolsList = & $Yq eval '.*_content[].tool' $YamlFilePath

# Loop through each tool and generate the entries
foreach ($Tool in $ToolsList) {
  New-ManifestEntry $Tool $SelectedOperatingSystem
}

# Source manifest to get the array of elements
. $ManifestFilePath

# Source environment
Write-Output "ENV_FILE: $env:ENV_FILE"
$ScriptDir = Split-Path -Path "$env:ENV_FILE" -Parent
$EnvScript = Join-Path -Path "$ScriptDir" -ChildPath "env.ps1"
. $EnvScript *>$null

Install-PythonVenv -InstallDirectory $InstallDir -WorkDirectory $WorkDirectory

Remove-Item -Path $TemporaryDirectory -Recurse -Force