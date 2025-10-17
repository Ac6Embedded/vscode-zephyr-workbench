# Parse command-line arguments
param (
    [string]$D,
    [string[]]$ToolsArg
)

$Tools = $ToolsArg -split ','

$BaseDirectory = Join-Path -Path $env:USERPROFILE -ChildPath ".zinstaller"
$SelectedOperatingSystem = "windows"

$ScriptPath = $MyInvocation.MyCommand.Path
$ScriptDirectory = Split-Path -Parent $ScriptPath

function Show-Help {
    $helpText = @"
Usage: install.ps1 -D <InstallDir> -Tools <tool1>[,tool2,tool3 ...]

Arguments:
  InstallDir  The directory where the Zephyr environment will be installed. Defaults to '$env:USERPROFILE\.zinstaller'.
  Tools       The list of tools to install

Examples:
  install.ps1 -D "C:\my\install\path" openocd stm32cubeprogrammer
"@
    Write-Host $helpText
}

# Check for help flag
if ($args.Count -gt 0 -and ($args[0] -eq "-h" -or $args[0] -eq "--help" -or $args[0] -eq "/?")) {
    Show-Help
    exit
}

# Check if an install directory argument is provided
$InstallDirectory = Join-Path -Path $D -ChildPath ".zinstaller"
$TemporaryDirectory = "$InstallDirectory\tmp"
$YamlFilePath = "$ScriptDirectory\debug-tools.yml"
$DownloadDirectory = "$TemporaryDirectory\downloads"
$ManifestFilePath = "$TemporaryDirectory\debug-tools-manifest.ps1"
$WorkDirectory = "$TemporaryDirectory\workdir"
$ToolsDirectory = "$InstallDirectory\tools"

# Create directories if they do not exist, and suppress output
New-Item -Path $InstallDirectory -ItemType Directory -Force > $null 2>&1
New-Item -Path $TemporaryDirectory -ItemType Directory -Force > $null 2>&1
New-Item -Path $DownloadDirectory -ItemType Directory -Force > $null 2>&1
New-Item -Path $WorkDirectory -ItemType Directory -Force > $null 2>&1
New-Item -Path $ToolsDirectory -ItemType Directory -Force > $null 2>&1

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

$UseWget = $false

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
        # Using Invoke-WebRequest for downloading, make it silent, if not it will be very slow
        & {
            $ProgressPreference = 'SilentlyContinue'
			if ($Tool -eq "jlink") {
				$postParams = @{
					accept_license_agreement = 'accepted'
					submit = 'Download software'
				}
				Invoke-WebRequest -Uri $SourceUrl -Method POST -Body $postParams -OutFile $FilePath -ErrorAction Stop
			} else {
				Invoke-WebRequest -Uri $SourceUrl -OutFile $FilePath -ErrorAction Stop
			}
        }
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
    $Source = & $Yq eval ".*[] | select(.tool == `"`"`"$Tool`"`"`") | .os.$OperatingSystem.source" $YamlFilePath
    $Sha256 = & $Yq eval ".*[] | select(.tool == `"`"`"$Tool`"`"`") | .os.$OperatingSystem.sha256" $YamlFilePath

    # Check if the source and sha256 are not null (meaning the tool supports the OS)
    if ($Source -ne 'null' -and $Sha256 -ne 'null') {
        $ManifestEntry = @"
`$SOURCE_URLS["$Tool"]="$Source"
`$SHA256_HASHES["$Tool"]="$Sha256"
"@
        Add-Content $ManifestFilePath $ManifestEntry
    }
}

function Has-InstallScript {
    param (
        [string]$Tool
    )
    return Test-Path "$ScriptDirectory\debug\$Tool.ps1"
}

function Run-InstallScript {
    param (
        [string]$Tool,
        [string]$File
    )
    & "$ScriptDirectory\debug\$Tool.ps1" $File $ToolsDirectory $TemporaryDirectory
}

function Is-ArchiveFile {
    param (
        [string]$File
    )
    switch -Wildcard ($File) {
        "*.rar" { return $true }
        "*.7z"  { return $true }
        "*.zip" { return $true }
        default { return $false }
    }
}

function Install {
    param (
        [string]$Tool,
        [string]$File,
        [string]$DestFolder
    )

    $InstallScript = Join-Path -Path "$ScriptDirectory\debug" -ChildPath "$Tool.ps1"

    # 1️ Case: a tool-specific PowerShell script exists → run it
    if (Test-Path $InstallScript) {
        Write-Host "Running install script: $InstallScript"
        & $InstallScript $File $DestFolder $TemporaryDirectory
        if ($LastExitCode -ne 0) {
            Print-Error $LastExitCode "Installer script for $Tool failed."
            exit $LastExitCode
        }
        return
    }

    # 2️ Case: archive file → extract
    if ($File -match '\.(zip|7z|rar)$') {
        Write-Host "Extracting archive: $File"
        Extract-ArchiveFile $File $DestFolder
        return
    }

    # 3️ Case: directly executable file (.exe, .msi, .bat)
    if ($File -match '\.(exe|msi|bat)$') {
        Write-Host "Running executable installer: $File"
        & $File
        if ($LastExitCode -eq 0) {
            Write-Host "$Tool installed successfully."
        } else {
            Print-Error $LastExitCode "Executable installer for $Tool failed."
            exit $LastExitCode
        }
        return
    }

    # 4️ Anything else → unsupported
    Print-Error 2 "'$File' has an unsupported format."
    exit 2
}


function Get-FilenameFromUrl {
    param (
        [string]$Url
    )
    return [System.IO.Path]::GetFileName($Url)
}


function Extract-ArchiveFile {
    param (
        [string]$ZipFilePath,    
        [string]$DestinationDirectory
    )
    
    # Ensure the destination directory exists
    New-Item -Path $DestinationDirectory -ItemType Directory -Force > $null

    # Extract the file silently
    & $SevenZ x "$ZipFilePath" -o"$DestinationDirectory" -y -bso0 -bsp0

    if ($LastExitCode -eq 0) {
        Write-Output "Extraction successful: $ZipFilePath"
    } else {
        Print-Error $LastExitCode "Failed to extract $ZipFilePath"
    }
}


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
$ToolsList = & $Yq eval '.*[].tool' $YamlFilePath

Add-Content $ManifestFilePath '$SOURCE_URLS = @{}'
Add-Content $ManifestFilePath '$SHA256_HASHES = @{}'
# Loop through each tool and generate the entries
foreach ($Tool in $ToolsList) {
    New-ManifestEntry $Tool $SelectedOperatingSystem
}

# Source manifest to get the array of elements
. $ManifestFilePath

Print-Title "7-Zip"

$SevenZInstalled = Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* | Where-Object { $_.DisplayName -like "*7-Zip*" }

if ($SevenZInstalled) {
    Write-Host "7-Zip is already installed."
} else {
    Write-Host "7-Zip is not installed. Installing now..."
    $SevenZInstallerName = "7z.exe"
    Download-FileWithHashCheck $SOURCE_URLS["7z"] $SHA256_HASHES["7z"] $SevenZInstallerName

    $SevenZInstallerPath = Join-Path -Path $DownloadDirectory -ChildPath $SevenZInstallerName

    Start-Process -FilePath $SevenZInstallerPath -ArgumentList "/S" -Wait
    Write-Host "7-Zip installation completed."
    $SevenZInstalled = Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* | Where-Object { $_.DisplayName -like "*7-Zip*" }
    if ($SevenZInstalled) {
        Write-Host "7-Zip was installed successfully"
    } else {
        Print-Error 4 "7-Zip was not installed ! Stop here !!"
        exit 4
    }
}
$SevenZ = "C:\Program Files\7-Zip\7z.exe"
Test-FileExistence -FilePath $SevenZ

# Update path
$SevenZPath = "C:\Program Files\7-Zip"
#$WgetPath = "$ToolsDirectory\wget"

$env:PATH = "$SevenZPath;" + $env:PATH

foreach ($Tool in $Tools) {
    Write-Host "Installing $Tool"
    $InstallerFilename = Get-FilenameFromUrl -Url $SOURCE_URLS[$Tool]
    Write-Host "INSTALLER_FILENAME=$InstallerFilename"
    Download-FileWithHashCheck $SOURCE_URLS[$Tool] $SHA256_HASHES[$Tool] "$InstallerFilename"
    $Installer = Join-Path -Path $DownloadDirectory -ChildPath $InstallerFilename
    Install $Tool "$Installer" $ToolsDirectory
}

Remove-Item "$TemporaryDirectory" -Recurse -Force -ErrorAction SilentlyContinue

