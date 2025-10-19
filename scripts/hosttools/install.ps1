param (
    [string]$InstallDir = "$env:USERPROFILE",
    [switch]$OnlyCheck,
    [switch]$ReinstallVenv,
    [switch]$Portable,
    [switch]$SkipSdk,
    [string]$SelectSdk,
    [switch]$Help,
    [switch]$Version
)

$SelectedOperatingSystem = "windows"

$ScriptPath = $MyInvocation.MyCommand.Path
$ScriptDirectory = Split-Path -Parent $ScriptPath
$YamlFilePath = "$ScriptDirectory\tools.yml"

$ZinstallerVersion="2
+.0"
$ZinstallerMd5 = Get-FileHash -Path $ScriptPath -Algorithm MD5 | Select-Object -ExpandProperty Hash
$ToolsYmlMd5 = Get-FileHash -Path $YamlFilePath -Algorithm MD5 | Select-Object -ExpandProperty Hash

function Show-Help {
    $helpText = @"
Usage: install.ps1 [options] [InstallDir]

Description: Install Windows Host Dependencies for Zephyr Project

Options:
  -Help                  Show this help message and exit
  -Version               Show version and hash of the current script
  -OnlyCheck             Perform only a check for required software packages without installing
  -SkipSdk               Skip default SDK download and installation
  -InstallSdk            Additionally install the SDK after installing the packages
  -ReinstallVenv         Remove .venv folder, create a new .venv, install requirements and west
  -Portable              Install portable Python and 7z instead of global
  -SelectSdk             Specify space-separated SDKs to install. E.g., 'arm aarch64'

Arguments:
  InstallDir             Optional. The directory where the Zephyr environment will be installed. Defaults to '$env:USERPROFILE\.zinstaller'

Examples:
  install.ps1
  install.ps1 "C:\my\install\path"
  install.ps1 -OnlyCheck
  install.ps1 -ReinstallVenv
  install.ps1 "C:\my\install\path" -OnlyCheck
  install.ps1 -SelectSdk "arm aarch64"
"@
    Write-Host $helpText
}

# Check for help flag
if ($Help) {
    Show-Help
    exit
}

if ($Version) {
    Write-Output "${ZinstallerVersion}+${ZinstallerMd5}"
    exit
}

# Check if an install directory argument is provided
$InstallDirectory = Join-Path -Path $InstallDir -ChildPath ".zinstaller"

# Check if the path is relative and convert it to absolute based on the current working directory
if (-not [System.IO.Path]::IsPathRooted($InstallDirectory)) {
    $CurrentDirectory = (Get-Location).Path
    $InstallDirectory = Join-Path -Path $CurrentDirectory -ChildPath $InstallDirectory
}

Write-Output "Install directory: $InstallDirectory"

$TemporaryDirectory = "$InstallDirectory\tmp"
$ManifestFilePath = "$TemporaryDirectory\manifest.ps1"
$DownloadDirectory = "$TemporaryDirectory\downloads"
$WorkDirectory = "$TemporaryDirectory\workdir"
$ToolsDirectory = "$InstallDirectory\tools"

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
	
	if (Test-Path -Path "$InstallDirectory\.venv") {
		Remove-Item -Path "$InstallDirectory\.venv" -Recurse -Force
	}
	
    python -m venv "$InstallDirectory\.venv"
    . "$InstallDirectory\.venv\Scripts\Activate.ps1"
    python -m pip install setuptools windows-curses west wheel pyelftools --quiet
    python -m pip install anytree --quiet
    python -m pip install -r "$RequirementsBaseUrl/requirements.txt" --quiet
    python -m pip install puncover --quiet
}



if (! $OnlyCheck -or $ReinstallVenv) {

    # Create directories if they do not exist, and suppress output
    New-Item -Path $InstallDirectory -ItemType Directory -Force > $null 2>&1
    New-Item -Path $TemporaryDirectory -ItemType Directory -Force > $null 2>&1
    New-Item -Path $DownloadDirectory -ItemType Directory -Force > $null 2>&1
    New-Item -Path $WorkDirectory -ItemType Directory -Force > $null 2>&1
    New-Item -Path $ToolsDirectory -ItemType Directory -Force > $null 2>&1
    
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
                 Invoke-WebRequest -Uri $SourceUrl -OutFile $FilePath -ErrorAction Stop
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
    
        # Extract the file silently
        & $SevenZ x "$ZipFilePath" -o"$DestinationDirectory" -y -bso0 -bsp0
    
        if ($LastExitCode -eq 0) {
            Write-Output "Extraction successful: $ZipFilePath"
        } else {
            Print-Error $LastExitCode "Failed to extract $ZipFilePath"
        }
    }
    
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

    # --- Always download and replace persistent YQ ---
    $YqFolder = Join-Path -Path $ToolsDirectory -ChildPath "yq"
    $YqPath = Join-Path -Path $YqFolder -ChildPath $YqExecutable

    # Ensure yq folder exists
    New-Item -Path $YqFolder -ItemType Directory -Force > $null 2>&1

    # Always download to temporary dir, then move to tools/yq
    Download-FileWithHashCheck $YqSource $YqSha256 $YqExecutable
    Move-Item -Path (Join-Path $DownloadDirectory $YqExecutable) -Destination $YqPath -Force

    # Verify yq exists in tools folder
    Test-FileExistence -FilePath $YqPath

    # Use the persistent copy
    $Yq = $YqPath
    
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
    
    Print-Title "Wget"
    $WgetExecutableName = "wget.exe"
    $wgetVersion = "1.21.4"
    Download-FileWithHashCheck $wget_array[0] $wget_array[1] $WgetExecutableName
    Test-FileExistence -FilePath "$DownloadDirectory\$WgetExecutableName"
    
    New-Item -Path "$ToolsDirectory\wget" -ItemType Directory -Force > $null 2>&1
    Copy-Item -Path "$DownloadDirectory\$WgetExecutableName" -Destination "$ToolsDirectory\wget\$WgetExecutableName"
    
    $Wget = "$ToolsDirectory\wget\$WgetExecutableName"
    
    $UseWget = $true
    
    Print-Title "7-Zip"
    
    $SevenZInstalled = Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* | Where-Object { $_.DisplayName -like "*7-Zip*" }
    
    if ($SevenZInstalled) {
        Write-Host "7-Zip is already installed."
		$SevenZ = "C:\Program Files\7-Zip\7z.exe"
		$SevenZPath = "C:\Program Files\7-Zip"

		if (-Not (Test-Path -Path $SevenZ)) {
			#maybe 7z 32 bits installed
		    $SevenZ = "C:\Program Files (x86)\7-Zip\7z.exe"
		    $SevenZPath = "C:\Program Files (x86)\7-Zip"
        }
		
		Test-FileExistence -FilePath $SevenZ
		#if 7z installed in a non default place it will fail, you should use the portable version without -Global
    } else {
        Write-Host "7-Zip is not installed."
        Write-Host "Installing now 7z Global..."
        $SevenZInstallerName = "7z-installer.exe"
        Download-FileWithHashCheck $seven_z_array[0] $seven_z_array[1] $SevenZInstallerName
    
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
        $SevenZ = "C:\Program Files\7-Zip\7z.exe"
        $SevenZPath = "C:\Program Files\7-Zip"
        Test-FileExistence -FilePath $SevenZ
		Write-Host "7-Zip installation completed."
    }

	if ($ReinstallVenv) {
		Print-Title "Reinstalling Python VENV"
		if (Test-Path -Path "$InstallDirectory\.venv") {
            Remove-Item -Path "$InstallDirectory\.venv" -Recurse -Force
		}

		. "$InstallDirectory\env.ps1" *>$null

		Install-PythonVenv -InstallDirectory $InstallDirectory -WorkDirectory $WorkDirectory
	    Remove-Item -Path $TemporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
		exit
	}
	
    Print-Title "Gperf"
    $GperfVersion = "3.0.1"
    $GperfZipName = "gperf-${GperfVersion}-bin.zip"
    $GperfInstallDirectory = "$ToolsDirectory\gperf"
    Download-FileWithHashCheck $gperf_array[0] $gperf_array[1] $GperfZipName
    
    New-Item -Path $GperfInstallDirectory -ItemType Directory -Force > $null 2>&1
    Extract-ArchiveFile -ZipFilePath "$DownloadDirectory\$GperfZipName" -DestinationDirectory $GperfInstallDirectory
    
    Print-Title "CMake"
    $CmakeVersion = "3.28.1"
    $CmakeZipName = "cmake-${CmakeVersion}-windows-x86_64.zip"
    $CmakeFolderName = "cmake-${CmakeVersion}-windows-x86_64"
    Download-FileWithHashCheck $cmake_array[0] $cmake_array[1] $CmakeZipName
    Extract-ArchiveFile -ZipFilePath "$DownloadDirectory\$CmakeZipName" -DestinationDirectory $ToolsDirectory
	if (Test-Path -Path $ToolsDirectory\cmake) {
       Remove-Item -Path $ToolsDirectory\cmake -Recurse -Force
    }
    Rename-Item -Path "$ToolsDirectory\$CmakeFolderName" -NewName "cmake"
    
    Print-Title "Ninja"
    $NinjaZipName = "ninja-win.zip"
    $NinjaVersion = "1.11.1"
    Download-FileWithHashCheck $ninja_array[0] $ninja_array[1] $NinjaZipName
    
    $NinjaFolderPath = "$ToolsDirectory\ninja"
    New-Item -Path $NinjaFolderPath -ItemType Directory -Force > $null 2>&1
    
    Extract-ArchiveFile -ZipFilePath "$DownloadDirectory\$NinjaZipName" -DestinationDirectory $NinjaFolderPath
    
    Print-Title "Zstd"
    $ZstdZipName = "zstd-v1.5.6-win64.zip"
    Download-FileWithHashCheck $zstd_array[0] $zstd_array[1] $ZstdZipName
    Extract-ArchiveFile -ZipFilePath "$DownloadDirectory\$ZstdZipName" -DestinationDirectory $DownloadDirectory
    
    $ZstdFolderName = "zstd-v1.5.6-win64"
    $ZstdExecutable = "$DownloadDirectory\$ZstdFolderName\zstd.exe"
    
    Print-Title "DTC"
    $DtcVersion = "1.7.0-1"
    $DtcZstName = "dtc-${DtcVersion}-x86_64.pkg.tar.zst"
    $DtcZstTarName = "dtc-${DtcVersion}-x86_64.pkg.tar"
    Download-FileWithHashCheck $dtc_array[0] $dtc_array[1] $DtcZstName
    
    & $ZstdExecutable --quiet -d "$DownloadDirectory\$DtcZstName" -o "$DownloadDirectory\$DtcZstTarName"
    
    $DtcFolderPath = "$ToolsDirectory\dtc"
    New-Item -Path $DtcFolderPath -ItemType Directory -Force > $null 2>&1
    Extract-ArchiveFile -ZipFilePath "$DownloadDirectory\$DtcZstTarName" -DestinationDirectory $DtcFolderPath
    
    Print-Title "msys2"
    $Msys2ZstName = "msys2-runtime-3.5.3-4-x86_64.pkg.tar.zst"
    $Msys2ZstTarName = "msys2-runtime-3.5.3-4-x86_64.pkg.tar"
    Download-FileWithHashCheck $msys2_runtime_array[0] $msys2_runtime_array[1] $Msys2ZstName
    
    & $ZstdExecutable --quiet -d "$DownloadDirectory\$Msys2ZstName" -o "$DownloadDirectory\$Msys2ZstTarName"
    
    $Msys2FolderPath = "$DownloadDirectory\msys2"
    New-Item -Path $Msys2FolderPath -ItemType Directory -Force > $null 2>&1
    Extract-ArchiveFile -ZipFilePath "$DownloadDirectory\$Msys2ZstTarName" -DestinationDirectory $Msys2FolderPath
    
    Copy-Item -Path "$Msys2FolderPath\usr\bin\msys-2.0.dll" -Destination "$DtcFolderPath\usr\bin\msys-2.0.dll"
    
    Print-Title "libyaml"
    $LibyamlName = "libyaml-0.2.5-2-x86_64"
    $LibyamlZstName = "$LibyamlName.pkg.tar.zst"
    $LibyamlZstTarName = "$LibyamlName.pkg.tar"
    Download-FileWithHashCheck $libyaml_array[0] $libyaml_array[1] $LibyamlZstName
    
    & $ZstdExecutable --quiet -d "$DownloadDirectory\$LibyamlZstName" -o "$DownloadDirectory\$LibyamlZstTarName"
    
    $LibyamlFolderPath = "$DownloadDirectory\libyaml"
    New-Item -Path $LibyamlFolderPath -ItemType Directory -Force > $null 2>&1
    Extract-ArchiveFile -ZipFilePath "$DownloadDirectory\$LibyamlZstTarName" -DestinationDirectory $LibyamlFolderPath
    
    Copy-Item -Path "$LibyamlFolderPath\usr\bin\msys-yaml-0-2.dll" -Destination "$DtcFolderPath\usr\bin\msys-yaml-0-2.dll"
    
    Print-Title "Check DTC"
    
    $DtcExecutable = "$DtcFolderPath\usr\bin\dtc.exe"
    & $DtcExecutable --version
    
    if ($LastExitCode -eq 0) {
        Write-Output "Device tree compiler was successfully installed"
    } else {
        Print-Error $LastExitCode "Failed to install device tree compiler"
    }
    
    Print-Title "Git"
    $GitVersion = "2.45.2"
    $GitSetupFilename = "PortableGit-${GitVersion}-64-bit.7z.exe"
    Download-FileWithHashCheck $git_array[0] $git_array[1] $GitSetupFilename
    
    $GitInstallDirectory = "$ToolsDirectory\git"
    
    # Extract and wait
    Start-Process -FilePath "$DownloadDirectory\$GitSetupFilename" -ArgumentList "-o`"$ToolsDirectory\git`" -y" -Wait
    
    if(! $SkipSdk) {
      Print-Title "Default Zephyr SDK"
      $SdkVersion = "0.16.8"
      $SdkName = "zephyr-sdk-${SdkVersion}"
      if ($SelectSdk) {
		    $SdkBaseUrl = "https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v${SdkVersion}"
		    $SdkMinimalUrl = "${SdkBaseUrl}/zephyr-sdk-${SdkVersion}_windows-x86_64_minimal.7z"
		    Write-Host "Installing minimal SDK for $SdkList"
		    Download-WithoutCheck "${SdkMinimalUrl}" "${SdkName}.7z"
		    Extract-ArchiveFile -ZipFilePath "$DownloadDirectory\${SdkName}.7z" -DestinationDirectory $InstallDirectory

		    $SdkList = $SelectSdk.Split(" ")
		    
		    foreach ($sdk in $SdkList) {
			    $ToolchainName = "${sdk}-zephyr-elf"
			    if ($sdk -eq "arm") { $ToolchainName = "${sdk}-zephyr-eabi" }
			    
			    $ToolchainUrl = "${SdkBaseUrl}/toolchain_windows-x86_64_${ToolchainName}.7z"
			    Download-WithoutCheck "${ToolchainUrl}" "${ToolchainName}.7z"
			    Extract-ArchiveFile -ZipFilePath "$DownloadDirectory\${ToolchainName}.7z" -DestinationDirectory "$InstallDirectory\${SdkName}"
		    }
      } else {
		    $SdkZipName = $SdkName + "_windows-x86_64.7z"
		    Download-FileWithHashCheck $zephyr_sdk_array[0] $zephyr_sdk_array[1] $SdkZipName
		    Extract-ArchiveFile -ZipFilePath "$DownloadDirectory\$SdkZipName" -DestinationDirectory "$InstallDirectory"
      }
      
      if ($InstallSdk) {
        Print-Title "Install Default Zephyr SDK"
        & "$InstallDirectory\$SdkName\setup.cmd" /c
      }
    }
    
    Print-Title "Python"
    if($Portable) {
        $WinPythonSetupFilename = "Winpython64.exe"
        $pythonVersion = "3.13.5"
        
        Download-FileWithHashCheck $python_portable_array[0] $python_portable_array[1] $WinPythonSetupFilename

        $PythonInstallDirectory = "$ToolsDirectory\python"

        # Extract and wait
        Start-Process -FilePath "$DownloadDirectory\$WinPythonSetupFilename" -ArgumentList "-o`"$ToolsDirectory`" -y" -Wait
        if (Test-Path -Path $ToolsDirectory\python) {
            Remove-Item -Path $ToolsDirectory\python -Recurse -Force
        }
        #Rename the folder that starts with WPy64- to python
        Rename-Item -Path (Get-ChildItem -Directory -Filter "WPy64-*" -Path $ToolsDirectory | Select-Object -First 1).FullName -NewName "python"
        Copy-Item -Path "$ToolsDirectory\python\python\python.exe" -Destination "$ToolsDirectory\python\python\python3.exe"
        $PythonPath = "$ToolsDirectory\python\python;$ToolsDirectory\python\python\Scripts"
    } else {
        $PythonSetupFilename = "python_installer.exe"
        Download-FileWithHashCheck $python_array[0] $python_array[1] $PythonSetupFilename

        Start-Process -FilePath "$DownloadDirectory\$PythonSetupFilename" -ArgumentList "/quiet", "PrependPath=1" -Wait
        
        #check if python is installed
        $python = Get-Command python -ErrorAction SilentlyContinue
        if ($python) {
            Write-Output "Python is installed. Version: $(python --version)"
        } else {
            Write-Output "Python is not installed."
        }
        
        #Python should be added automatically to path thanks to PrependPath=1
        $PythonPath=""
	#Reload Path variable
	$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    }

    # Update path
    $CmakePath = "$ToolsDirectory\cmake\bin"
    $DtcPath = "$ToolsDirectory\dtc\usr\bin"
    $GperfPath = "$ToolsDirectory\gperf\bin"
    $NinjaPath = "$ToolsDirectory\ninja"
    $GitPath = "$ToolsDirectory\git\bin"
    $WgetPath = "$ToolsDirectory\wget"
    # $PythonPath & $SevenZPath already defined previously based on portable or global

    $env:PATH = "$CmakePath;$DtcPath;$GperfPath;$NinjaPath;$PythonPath;$WgetPath;$GitPath;$SevenZPath;" + $env:PATH
      
	  
    Print-Title "Python VENV"
    Install-PythonVenv -InstallDirectory $InstallDirectory

# bat script  
@"
@echo off
setlocal EnableDelayedExpansion EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "YAML_FILE=%SCRIPT_DIR%env.yml"

if not exist "%YAML_FILE%" (
    echo [ERROR] File not found: %YAML_FILE%
    exit /b 1
)

set "in_env=false"
set "ADDITIONAL_PATHS="

for /f "usebackq tokens=* delims=" %%A in ("%YAML_FILE%") do (
    set "line=%%A"
    for /f "tokens=* delims= " %%B in ("!line!") do set "line=%%B"

    rem --- Parse env section ---
    if /I "!line!"=="env:" set "in_env=true"
    if /I "!line:~0,6!"=="tools:" set "in_env=false"

    if "!in_env!"=="true" (
        if not "!line!"=="" if "!line:~0,1!" NEQ "#" (
            for /f "tokens=1* delims=:" %%K in ("!line!") do (
                set "key=%%K"
                set "val=%%L"
                for /f "tokens=* delims= " %%V in ("!val!") do set "val=%%~V"
                set "val=!val:"=!"
                set !key!=!val!
            )
        )
    )

    rem --- Parse path entries ---
    if /I "!line:~0,5!"=="path:" (
        set "value=!line:*path:=!"
        if not "!value!"=="" (
            for /f "tokens=* delims= " %%B in ("!value!") do set "value=%%~B"
            set "value=!value:"=!"
            set "p=!value:`${=%%!"
            set "p=!p:}=%%!"
            call set "expanded=!p!"
            set "ADDITIONAL_PATHS=!ADDITIONAL_PATHS!;!expanded!"
        )
    )

    if "!line:~0,1!"=="-" (
        set "item=!line:*-=!"
        for /f "tokens=* delims= " %%C in ("!item!") do set "item=%%~C"
        set "item=!item:"=!"
        set "p=!item:`${=%%!"
        set "p=!p:}=%%!"
        call set "expanded=!p!"
        set "ADDITIONAL_PATHS=!ADDITIONAL_PATHS!;!expanded!"
    )

    if /I "!line:~0,17!"=="global_venv_path:" (
        set "venv_line=!line:*global_venv_path:=!"
        for /f "tokens=* delims= " %%D in ("!venv_line!") do set "venv_line=%%~D"
        set "venv_line=!venv_line:"=!"
        set "p=!venv_line:`${=%%!"
        set "p=!p:}=%%!"
        call set "expanded=!p!"
        set "global_venv_path=!expanded!"
    )
)

set "PATH=%ADDITIONAL_PATHS%;%PATH%"

set "DEFAULT_VENV_ACTIVATE_PATH=%global_venv_path%\Scripts\activate.bat"

if defined PYTHON_VENV_ACTIVATE_PATH (
    set "VENV_ACTIVATE_PATH=%PYTHON_VENV_ACTIVATE_PATH%"
) else (
    set "VENV_ACTIVATE_PATH=%DEFAULT_VENV_ACTIVATE_PATH%"
)

if exist "%VENV_ACTIVATE_PATH%" (
    call "%VENV_ACTIVATE_PATH%"
) else (
    rem no output for missing venv
)

endlocal
    
"@ | Out-File -FilePath "$InstallDirectory\env.bat" -Encoding ASCII

#bash script
@"
#!/usr/bin/env bash

# --- Resolve the directory this script lives in ---
if [ -n "`${BASH_SOURCE-}" ]; then
    _src="`${BASH_SOURCE[0]}"
elif [ -n "`${ZSH_VERSION-}" ]; then
    _src="`${(%):-%N}"
else
    _src="`$0"
fi
base_dir="`$(cd -- "`$(dirname -- "`${_src}")" && pwd -P)"
tools_dir="`$base_dir/tools"
YAML_FILE="`$base_dir/env.yml"

[[ ! -f "`$YAML_FILE" ]] && { echo "[ERROR] File not found: `$YAML_FILE" >&2; exit 1; }

declare -A ENV_VARS
PATHS=()
GLOBAL_VENV_PATH=""
in_env=0
in_path=0

# --- Detect shell environment once (Git Bash / WSL / etc.) ---
detect_shell_env() {
    local uname_s
    uname_s="`$(uname -s 2>/dev/null)"

    if grep -qi "microsoft" /proc/version 2>/dev/null; then
        echo "WSL"
    elif [[ "`$uname_s" == CYGWIN* ]]; then
        echo "CYGWIN"
    elif [[ "`$uname_s" == MINGW64* ]]; then
        echo "MSYS2-MINGW64"
    elif [[ "`$uname_s" == MINGW32* ]]; then
        echo "MSYS2-MINGW32"
    elif [[ "`$uname_s" == MSYS* ]]; then
        if [[ "`$MSYSTEM" == "MINGW64" || "`$MSYSTEM" == "MINGW32" ]]; then
            echo "MSYS2"
        else
            echo "MSYS/GitBash"
        fi
    else
        echo "UNKNOWN"
    fi
}

# Cache environment type so detect_shell_env runs only once
ENV_TYPE="`$(detect_shell_env)"

# --- Convert Windows path to Unix path ---
to_unix_path() {
    local input="`$1"
    case "`$ENV_TYPE" in
        CYGWIN)
            cygpath -u "`$input"
            ;;
        MSYS*|MINGW*)
            cygpath -u "`$input" 2>/dev/null || \
            echo "`$input" | sed 's|\\|/|g; s|^\([A-Za-z]\):|/\L\1|'
            ;;
        WSL)
            echo "`$input" | sed 's|\\|/|g; s|^\([A-Za-z]\):|/mnt/\L\1|'
            ;;
        *)
            echo "`$input" | tr '\\' '/'
            ;;
    esac
}

# --- Helper: Trim spaces without xargs ---
trim() {
    local var="`$1"
    var="`${var#"`${var%%[![:space:]]*}"}"
    var="`${var%"`${var##*[![:space:]]}"}"
    echo "`$var"
}

# --- Parse env.yml ---
while IFS= read -r line || [[ -n "`$line" ]]; do
  line="`${line#"`${line%%[![:space:]]*}"}"
  line="`${line%"`${line##*[![:space:]]}"}"
  [[ -z "`$line" || "`$line" =~ ^# ]] && continue

  if [[ "`$line" == "env:" ]]; then in_env=1; continue; fi
  [[ "`$line" =~ ^tools: ]] && in_env=0

  if (( in_env )); then
    if [[ "`$line" =~ : ]]; then
      key="`${line%%:*}"
      val="`${line#*:}"
      val="`${val//\"/}"
      val="`$(trim "`$val")"
      [[ -n "`$key" && -n "`$val" ]] && ENV_VARS["`$key"]="`$val" && export "`$key"="`$val"
    fi
    continue
  fi

  if [[ "`$line" =~ ^path: ]]; then
    value="`${line#path:}"
    value="`${value//\"/}"
    value="`$(trim "`$value")"
    if [[ -n "`$value" ]]; then
      PATHS+=("`$value")
      in_path=0
    else
      in_path=1
    fi
    continue
  fi

  if (( in_path )); then
    if [[ "`$line" =~ ^- ]]; then
      item="`${line#-}"
      item="`${item//\"/}"
      item="`$(trim "`$item")"
      PATHS+=("`$item")
    else
      in_path=0
    fi
  fi

  if [[ "`$line" =~ ^global_venv_path: ]]; then
    venv="`${line#global_venv_path:}"
    venv="`${venv//\"/}"
    venv="`$(trim "`$venv")"
    GLOBAL_VENV_PATH="`$venv"
  fi
done < "`$YAML_FILE"

# --- Expand `${var} placeholders ---
expand_vars() {
  local s="`$1"
  for k in "`${!ENV_VARS[@]}"; do
    s="`${s//\`$\{`$k\}/`${ENV_VARS[`$k]}}"
  done
  echo "`$s"
}

# --- Build final PATH ---
for p in "`${PATHS[@]}"; do
  expanded="`$(expand_vars "`$p")"
  unix_path="`$(to_unix_path "`$expanded")"
  PATH="`$unix_path:`$PATH"
done

# --- Expand and normalize GLOBAL_VENV_PATH ---
if [[ -n "`$GLOBAL_VENV_PATH" ]]; then
  expanded_venv="`$(expand_vars "`$GLOBAL_VENV_PATH")"
  unix_venv="`$(to_unix_path "`$expanded_venv")"
  export global_venv_path="`$unix_venv"

  if [[ -d "`$unix_venv/Scripts" ]]; then
    PATH="`$unix_venv/Scripts:`$PATH"
  fi
fi

export PATH

# --- Activate Python virtual environment if available ---
default_venv_activate_path="`$global_venv_path/Scripts/activate"
[[ -n "`$PYTHON_VENV_ACTIVATE_PATH" ]] && venv_activate_path="`$PYTHON_VENV_ACTIVATE_PATH" || venv_activate_path="`$default_venv_activate_path"

if [[ -f "`$venv_activate_path" ]]; then
    source "`$venv_activate_path" >/dev/null 2>&1
else
    echo "[ERROR] Virtual environment activation script not found: `$venv_activate_path" >&2
fi
"@ | Out-File -FilePath "$InstallDirectory\env.sh" -Encoding ASCII

# (optional) make it executable for WSL, Git-Bash, etc.
try { & chmod +x "$InstallDirectory\env.sh" } catch { }
# Powershell script  
@"
# Parse env.yaml, expand `${vars}, PREPEND all path entries to `$Env:Path,
# and define `$global_venv_path (if present).
# Fast, silent, pure PowerShell - no external tools.

`$BaseDir = "`$PSScriptRoot"
`$EnvYamlPath = "`$BaseDir\env.yml"

if (-not (Test-Path `$EnvYamlPath)) {
    Write-Error "YAML file not found at: `$EnvYamlPath"
    exit 1
}

# --- Stage 1: Parse top-level env variables ---
`$inEnvBlock = `$false
`$envIndent = 0

Get-Content `$EnvYamlPath | ForEach-Object {
    `$line = `$_
    `$trimmed = `$line.TrimEnd()
    if (`$trimmed -match '^\s*(#|$)') { return }

    if (-not `$inEnvBlock -and `$trimmed -match '^\s*env\s*:\s*$') {
        `$inEnvBlock = `$true
        `$envIndent = (`$line.Length - `$line.TrimStart().Length)
        return
    }

    if (`$inEnvBlock) {
        `$indent = (`$line.Length - `$line.TrimStart().Length)
        if (`$indent -le `$envIndent) {
            `$inEnvBlock = `$false
            return
        }

        if (`$trimmed -match '^\s*([A-Za-z0-9_]+)\s*:\s*"?([^"#]+?)"?\s*$') {
            `$varName = `$Matches[1].Trim()
            `$varValue = `$Matches[2].Trim()
            Set-Variable -Name `$varName -Value `$varValue -Scope Script
        }
    }
}

# --- Stage 2: Parse all path entries ---
`$inPathBlock = `$false
`$pathIndent = 0
`$collectedPaths = @()

Get-Content `$EnvYamlPath | ForEach-Object {
    `$line = `$_
    `$trimmed = `$line.TrimEnd()
    if (`$trimmed -match '^\s*(#|$)') { return }

    if (-not `$inPathBlock) {
        # Single-line path
        if (`$trimmed -match '^\s*path\s*:\s*"?([^"#]+?)"?\s*$') {
            `$val = `$Matches[1].Trim()
            if (`$val) {
                `$expanded = [regex]::Replace(`$val, '\$\{([^}]+)\}', {
                    param(`$m)
                    `$name = `$m.Groups[1].Value
                    if (Get-Variable -Name `$name -Scope Script -ErrorAction SilentlyContinue) {
                        (Get-Variable -Name `$name -Scope Script).Value
                    } else {
                        `$m.Value
                    }
                })
                `$collectedPaths += `$expanded
            }
        }
        # Start of a block list
        elseif (`$trimmed -match '^\s*path\s*:\s*$') {
            `$inPathBlock = `$true
            `$pathIndent = (`$line.Length - `$line.TrimStart().Length)
        }
    }
    else {
        `$indent = (`$line.Length - `$line.TrimStart().Length)
        if (`$indent -le `$pathIndent -or `$trimmed -notmatch '^\s*-\s*') {
            `$inPathBlock = `$false
            return
        }

        if (`$trimmed -match '^\s*-\s*"?([^"#]+?)"?\s*$') {
            `$val = `$Matches[1].Trim()
            if (`$val) {
                `$expanded = [regex]::Replace(`$val, '\$\{([^}]+)\}', {
                    param(`$m)
                    `$name = `$m.Groups[1].Value
                    if (Get-Variable -Name `$name -Scope Script -ErrorAction SilentlyContinue) {
                        (Get-Variable -Name `$name -Scope Script).Value
                    } else {
                        `$m.Value
                    }
                })
                `$collectedPaths += `$expanded
            }
        }
    }
}

# --- Stage 3: Update `$Env:Path (prepend unique paths) ---
`$existing = `$Env:Path -split ';'
`$filtered = @()

foreach (`$p in `$collectedPaths) {
    if (-not [string]::IsNullOrWhiteSpace(`$p) -and -not (`$existing -contains `$p)) {
        `$filtered += `$p
    }
}

if (`$filtered.Count -gt 0) {
    `$Env:Path = (`$filtered -join ';') + ';' + `$Env:Path
}

# --- Stage 4: Extract and expand python.global_venv_path ---
`$inPythonBlock = `$false
`$pythonIndent = 0

Get-Content `$EnvYamlPath | ForEach-Object {
    `$line = `$_
    `$trimmed = `$line.TrimEnd()
    if (`$trimmed -match '^\s*(#|$)') { return }

    if (-not `$inPythonBlock -and `$trimmed -match '^\s*python\s*:\s*$') {
        `$inPythonBlock = `$true
        `$pythonIndent = (`$line.Length - `$line.TrimStart().Length)
        return
    }

    if (`$inPythonBlock) {
        `$indent = (`$line.Length - `$line.TrimStart().Length)
        if (`$indent -le `$pythonIndent) {
            `$inPythonBlock = `$false
            return
        }

        if (`$trimmed -match '^\s*global_venv_path\s*:\s*"?([^"#]+?)"?\s*$') {
            `$val = `$Matches[1].Trim()
            `$expanded = [regex]::Replace(`$val, '\$\{([^}]+)\}', {
                param(`$m)
                `$name = `$m.Groups[1].Value
                if (Get-Variable -Name `$name -Scope Script -ErrorAction SilentlyContinue) {
                    (Get-Variable -Name `$name -Scope Script).Value
                } else {
                    `$m.Value
                }
            })
            Set-Variable -Name "global_venv_path" -Value `$expanded -Scope Script
        }
    }
}

`$DefaultVenvActivatePath = "`${global_venv_path}\Scripts\Activate.ps1"

if (`$env:PYTHON_VENV_ACTIVATE_PATH -and `$env:PYTHON_VENV_ACTIVATE_PATH.Trim() -ne "") {
    `$VenvActivatePath = `$env:PYTHON_VENV_ACTIVATE_PATH
} else {
    `$VenvActivatePath = `$DefaultVenvActivatePath
}

# Check if the activation script exists at the specified path
if (Test-Path `$VenvActivatePath) {
    # Source the virtual environment activation script
    . "`$VenvActivatePath"
    Write-Output "Activated virtual environment at `$VenvActivatePath"
} else {
    Write-Output "Error: Virtual environment activation script not found at `$VenvActivatePath."
}
"@ | Out-File -FilePath "$InstallDirectory\env.ps1" -Encoding ASCII

@"
Script Version: $ZinstallerVersion
Script MD5: $ZinstallerMd5
tools.yml MD5: $ToolsYmlMd5
"@ | Out-File -FilePath "$InstallDirectory\zinstaller_version" -Encoding ASCII

    Write-Output "using cmd: $InstallDirectory\env.bat"
    Write-Output "using powershell: $InstallDirectory\env.ps1"

# --------------------------------------------------------------------------
# Create environment manifest (env.yml)
# --------------------------------------------------------------------------

$EnvYamlPath = "$InstallDirectory\env.yml"
$InstallDirectorySlashFormat = $InstallDirectory -replace '\\', '/'
$ToolsDirectorySlashFormat = $ToolsDirectory -replace '\\', '/'
$SevenZPathSlashFormat = $SevenZPath -replace '\\', '/'

$envYaml = @"
# env.yaml
# ZInstaller Workspace Environment Manifest
# Defines workspace tools, runners, and Zephyr compatibility metadata

global:
  version: 1.0
  description: "Host tools configuration for Zephyr Workbench"

# Any variable here will be added as environment variables
env:
  zi_base_dir: "${InstallDirectorySlashFormat}"
  zi_tools_dir: "${InstallDirectorySlashFormat}/tools"

tools:
  cmake:
    path: "`${zi_tools_dir}/cmake/bin"
    version: ${CmakeVersion}
    do_not_use: false

  dtc:
    path: "`${zi_tools_dir}/dtc/usr/bin"
    version: ${DtcVersion}
    do_not_use: false

  gperf:
    path: "`${zi_tools_dir}/gperf/bin"
    version: ${GperfVersion}
    do_not_use: false

  ninja:
    path: "`${zi_tools_dir}/ninja"
    version: ${NinjaVersion}
    do_not_use: false

  git:
    path: "`${zi_tools_dir}/git/bin"
    version: ${GitVersion}
    do_not_use: false

  seven_zip:
    path: "$SevenZPathSlashFormat"
    version: 24.08
    do_not_use: false

  python:
    path:
      - "$ToolsDirectorySlashFormat/python/python"
      - "$ToolsDirectorySlashFormat/python/python/Scripts"
    version: ${pythonVersion}
    do_not_use: false

  wget:
    path: "`${zi_tools_dir}/wget"
    version: $wgetVersion
    do_not_use: false

python:
  global_venv_path: "`${zi_base_dir}/.venv"

# If you reinstall host tools, you may need set this manually
#other:
#  EXTRA_PATH:
#    path:
#      - "path/to/custom/tool1"
#      - "path/to/custom/tool2"

"@

	$envYaml | Out-File -FilePath $EnvYamlPath -Encoding UTF8

	Write-Output "Created environment manifest: $EnvYamlPath"

    Print-Title "Clean up"
    Remove-Item -Path $TemporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}

# Define the list of default packages in a single location
$defaultPackages = @('python', 'cmake', 'ninja', 'git', 'gperf', 'dtc', 'wget', '7z')

function Check-Package {
    param (
        [string]$package
    )

    $versionCommand = $null

    switch ($package) {
        'python'   { $versionCommand = 'python --version' }
        'cmake'    { $versionCommand = 'cmake --version' }
        'ninja'    { $versionCommand = 'ninja --version' }
        'git'      { $versionCommand = 'git --version' }
        'gperf'    { $versionCommand = 'gperf --version' }
        'dtc'      { $versionCommand = 'dtc --version' }
        'wget'     { $versionCommand = 'wget.exe --version' }
        '7z'       { $versionCommand = '7z' }
        Default    { Write-Host "$package [NOT INSTALLED]"; return $false }
    }

    try {
		#check the first two lines and select the first non-empty one, because 7z has the first line empty
        $version = Invoke-Expression $versionCommand 2>&1 | Select-Object -First 2 | Where-Object { $_.Trim() -ne "" } | Select-Object -First 1

        switch ($package) {
            'python'   { if ($version -match 'Python (\S+)') { $version = $matches[1] } }
            'cmake'    { if ($version -match 'version (\S+)') { $version = $matches[1] } }
            'ninja'    { if ($version -match '(\S+)') { $version = $matches[0] } }
            'git'      { if ($version -match 'git version (\S+)') { $version = $matches[1] } }
            'gperf'    { if ($version -match 'GNU gperf (\S+)') { $version = $matches[1] } }
            'dtc'      { if ($version -match 'Version: DTC (\S+)') { $version = $matches[1] } }
            'wget'     { if ($version -match 'GNU Wget (\S+) built on') { $version = $matches[1] } }
            '7z'       { if ($version -match '7-Zip\s+(\d+\.\d+\s*\(\S+\))') { $version = $matches[1] } }
        }
    } catch {
        Write-Host "$package [NOT INSTALLED]"
        return $false
    }

    Write-Host "$package [$version]"
    return $true
}

function Check-Packages {
    param (
        [string[]]$packages = $defaultPackages
    )

    $missingCount = 0

    foreach ($pkg in $packages) {
        if (-not (Check-Package -package $pkg)) {
            $missingCount++
        }
    }

    if ($missingCount -gt 0) {
        Write-Host "$missingCount package(s) are not installed."
        return -$missingCount
    } else {
        Write-Host "All specified packages are installed."
        return 0
    }
}

Print-Title "Check Installed Packages"

#it should always be true, for now...
$checkInstalled = $true

if ($checkInstalled) {
    $returnCode = Check-Packages
    exit $returnCode
}