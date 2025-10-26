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

$ZinstallerVersion="2.0"
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

set "SCRIPT_DIR=%~dp0"
set "YAML_FILE=%SCRIPT_DIR%env.yml"
set "PY_FILE=%SCRIPT_DIR%env.py"

if not exist "%YAML_FILE%" (
    echo [ERROR] File not found: %YAML_FILE%
    exit /b 1
)

set "in_env=false"
set "ADDITIONAL_PATHS="

REM Extract global_venv_path from env.yml
for /f "tokens=1* delims=:" %%A in ('findstr /c:"global_venv_path" "%YAML_FILE%"') do (
    set "global_venv_path=%%B"
)

REM Check if global_venv_path was set
if not defined global_venv_path (
    echo [ERROR] Failed to extract global_venv_path from %YAML_FILE%
    exit /b 1
)

REM Remove leading/trailing spaces and quotes
set "global_venv_path=%global_venv_path: =%"
set "global_venv_path=%global_venv_path:"=%"

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

:: === Run env.py and apply its output ===
for /f "usebackq delims=" %%L in (``python "%PY_FILE%" --shell=cmd``) do (
    if not "%%L"=="" call %%L
)
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
PY_FILE="`$base_dir/env.py"

[[ ! -f "`$YAML_FILE" ]] && { echo "[ERROR] File not found: `$YAML_FILE" >&2; exit 1; }

GLOBAL_VENV_PATH=""

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
  if [[ "`$line" =~ ^global_venv_path: ]]; then
    venv="`${line#global_venv_path:}"
    venv="`${venv//\"/}"
    venv="`$(trim "`$venv")"
    GLOBAL_VENV_PATH="`$venv"
  fi
done < "`$YAML_FILE"

# --- Expand and normalize GLOBAL_VENV_PATH ---
if [[ -n "`$GLOBAL_VENV_PATH" ]]; then
  unix_venv="`$(to_unix_path "`$GLOBAL_VENV_PATH")"
  export global_venv_path="`$unix_venv"
fi

# --- Activate Python virtual environment if available ---
default_venv_activate_path="`$global_venv_path/Scripts/activate"
[[ -n "`$PYTHON_VENV_ACTIVATE_PATH" ]] && venv_activate_path="`$PYTHON_VENV_ACTIVATE_PATH" || venv_activate_path="`$default_venv_activate_path"

if [[ -f "`$venv_activate_path" ]]; then
    source "`$venv_activate_path" >/dev/null 2>&1
else
    echo "[ERROR] Virtual environment activation script not found: `$venv_activate_path" >&2
fi

# --- Run env.py to load environment variables and paths ---
if [[ -f "`$PY_FILE" ]]; then
    # We tell env.py to output in POSIX shell mode
    eval "`$(python "`$PY_FILE" --shell=sh)"
else
    echo "[ERROR] Python environment loader not found: `$PY_FILE" >&2
fi

"@ | Out-File -FilePath "$InstallDirectory\env.sh" -Encoding ASCII

# (optional) make it executable for WSL, Git-Bash, etc.
try { & chmod +x "$InstallDirectory\env.sh" } catch { }
# Powershell script  
@"
# --- Paths ---
`$BaseDir = "`$PSScriptRoot"
`$EnvYamlPath = Join-Path `$BaseDir "env.yml"
`$EnvPyPath = Join-Path `$BaseDir "env.py"

if (-not (Test-Path `$EnvYamlPath)) {
    Write-Error "YAML file not found at: `$EnvYamlPath"
    exit 1
}

# --- Parse YAML manually using PowerShell ---
# Simple YAML parser for basic key/value and nested sections
`$Yaml = @{}
`$CurrentSection = `$null

Get-Content `$EnvYamlPath | ForEach-Object {
    `$Line = `$_.Trim()

    # Skip comments and empty lines
    if (`$Line -match '^(#|$)') { return }

    # Section header (e.g. "python:")
    if (`$Line -match '^([A-Za-z0-9_]+):\s*$') {
        `$CurrentSection = `$matches[1]
        if (-not `$Yaml.ContainsKey(`$CurrentSection)) {
            `$Yaml[`$CurrentSection] = @{}
        }
        return
    }

    # Key-value pairs (e.g. "global_venv_path: "C:/path"")
    if (`$Line -match '^\s*([A-Za-z0-9_]+):\s*"?([^"#]+?)"?\s*$') {
        `$Key = `$matches[1]
        `$Value = `$matches[2].Trim()
        if (`$CurrentSection) {
            `$Yaml[`$CurrentSection][`$Key] = `$Value
        } else {
            `$Yaml[`$Key] = `$Value
        }
    }
}

# --- Extract the venv path ---
`$global_venv_path = `$Yaml["python"]["global_venv_path"]

if (-not `$global_venv_path) {
    Write-Error "global_venv_path not found in YAML file."
    exit 1
}

# --- Determine venv activation path ---
`$DefaultVenvActivatePath = Join-Path `$global_venv_path "Scripts\Activate.ps1"

if (`$env:PYTHON_VENV_ACTIVATE_PATH -and `$env:PYTHON_VENV_ACTIVATE_PATH.Trim() -ne "") {
    `$VenvActivatePath = `$env:PYTHON_VENV_ACTIVATE_PATH
} else {
    `$VenvActivatePath = `$DefaultVenvActivatePath
}

# --- Activate venv ---
if (Test-Path `$VenvActivatePath) {
    . "`$VenvActivatePath"
    Write-Output "Activated virtual environment at `$VenvActivatePath"
} else {
    Write-Output "Error: Virtual environment activation script not found at `$VenvActivatePath."
}

python `$EnvPyPath --shell=powershell | Out-String | Invoke-Expression
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
  global_venv_path: "${InstallDirectorySlashFormat}/.venv"

"@

	$envYaml | Out-File -FilePath $EnvYamlPath -Encoding UTF8

	Write-Output "Created environment manifest: $EnvYamlPath"

# --------------------------------------------------------------------------
# Create python script to parse environement yml (env.py)
# --------------------------------------------------------------------------

$EnvPyPath = "$InstallDirectory\env.py"

$envPy = @"
#!/usr/bin/env python3
"""
env.py - Parse env.yaml and output environment setup commands
for PowerShell, CMD (.bat), or POSIX shells (Bash, Zsh, etc.)

Features:
  - Cross-platform: Windows, Linux, macOS, WSL, MSYS2, Cygwin
  - Converts Windows paths to Unix-style under WSL/MSYS2/Cygwin
  - Expands `${VAR}, * and ? wildcards
  - Sets both `$env:VAR and `$VAR in PowerShell
  - Prepends project paths; appends auto-detect paths
"""

import os
import sys
import yaml
import re
import platform
import glob


# -----------------------------
# YAML parsing helpers
# -----------------------------
def load_yaml(path):
    """Load YAML safely."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f)
    except Exception as e:
        sys.stderr.write(f"Error reading {path}: {e}\n")
        sys.exit(1)


def expand_vars(value, env_vars):
    """Expand `${var} using YAML env vars or system env."""
    if not isinstance(value, str):
        return value
    pattern = re.compile(r"\$\{([^}]+)\}")
    return pattern.sub(lambda m: env_vars.get(m.group(1), os.environ.get(m.group(1), m.group(0))), value)


# -----------------------------
# Environment detection and path conversion
# -----------------------------
def detect_env_type():
    """Detect whether running under MSYS2, Cygwin, or WSL (quiet and safe)."""
    env = os.environ
    if "MSYSTEM" in env:
        return "MSYS2"
    if "CYGWIN" in env.get("OSTYPE", "").upper() or "CYGWIN" in env.get("TERM", "").upper():
        return "CYGWIN"
    if "WSL_DISTRO_NAME" in env or "WSL_INTEROP" in env:
        return "WSL"
    if platform.system() != "Windows":
        return "POSIX"

    try:
        with os.popen("uname -s 2>/dev/null") as proc:
            uname = proc.read().strip().upper()
        if "CYGWIN" in uname:
            return "CYGWIN"
        if "MINGW" in uname or "MSYS" in uname:
            return "MSYS2"
        if "LINUX" in uname:
            with open("/proc/version", "r", encoding="utf-8") as f:
                if "MICROSOFT" in f.read().upper():
                    return "WSL"
    except Exception:
        pass

    return "WINDOWS"


def detect_platform():
    """Return simplified platform key for auto-detect section."""
    system = platform.system().lower()
    if "windows" in system:
        return "windows"
    if "darwin" in system or "mac" in system:
        return "darwin"
    if "linux" in system:
        return "linux"
    return "unknown"


def to_unix_path(path: str, env_type: str = None) -> str:
    """Convert Windows paths to Unix-style; keep POSIX unchanged."""
    if not path:
        return path
    if platform.system() != "Windows":
        return path.replace("\\", "/")

    env_type = env_type or detect_env_type()
    norm = path.replace("\\", "/")

    if len(norm) >= 2 and norm[1] == ":":
        drive = norm[0].lower()
        rest = norm[2:]
        if env_type == "WSL":
            norm = f"/mnt/{drive}{rest}"
        else:  # MSYS2 / Cygwin
            norm = f"/{drive}{rest}"

    return norm


# -----------------------------
# Data collection from YAML
# -----------------------------
def collect_paths(data, env_vars):
    """Collect active paths from tools, runners, other, and auto-detect."""
    paths = []
    autodetect_paths = []

    def add_path(val, target_list):
        """Expand variables, wildcards, and append to target list."""
        if isinstance(val, list):
            for p in val:
                add_path(p, target_list)
            return

        expanded_value = expand_vars(val, env_vars)
        if not isinstance(expanded_value, str):
            return

        # Expand * and ? wildcards (glob)
        if "*" in expanded_value or "?" in expanded_value:
            matches = sorted(glob.glob(expanded_value))
            if matches:
                target_list.extend(matches)
            else:
                target_list.append(expanded_value)  # keep literal if no match
        else:
            target_list.append(expanded_value)

    # Tools
    for t in data.get("tools", {}).values():
        if isinstance(t, dict) and not t.get("do_not_use", False):
            add_path(t.get("path"), paths)

    # Runners
    for r in data.get("runners", {}).values():
        if isinstance(r, dict) and not r.get("do_not_use", False):
            add_path(r.get("path"), paths)

    # Other
    for o in data.get("other", {}).values():
        if isinstance(o, dict):
            add_path(o.get("path"), paths)

    # --- Auto-detect section ---
    ad = data.get("auto-detect", {})
    if isinstance(ad, dict):
        platform_key = detect_platform()
        for name, group in ad.items():
            if isinstance(group, dict):
                os_paths = group.get(platform_key)
                if os_paths:
                    add_path(os_paths, autodetect_paths)

    return paths, autodetect_paths


# -----------------------------
# Shell detection and output emitters
# -----------------------------
def detect_shell():
    """Detect or override the target shell."""
    for arg in sys.argv:
        if arg.startswith("--shell="):
            return arg.split("=", 1)[1].lower()

    if platform.system() != "Windows":
        return "sh"

    parent_proc = os.environ.get("ComSpec", "").lower()
    if "cmd.exe" in parent_proc:
        return "cmd"

    if os.environ.get("PSExecutionPolicyPreference") or os.environ.get("PSModulePath"):
        return "powershell"

    return "powershell"


def output_powershell(env_vars, paths, autodetect_paths):
    """Emit PowerShell commands (prepends normal paths, appends autodetect)."""
    for k, v in env_vars.items():
        expanded = expand_vars(v, env_vars)
        print(f"`$env:{k} = \"{expanded}\"")
        print(f"`${k} = \"{expanded}\"")

    # Prepend normal paths
    for p in paths:
        norm = os.path.normpath(p)
        print(f"`$env:PATH = \"{norm};`$env:PATH\"")

    # Append autodetect paths
    for p in autodetect_paths:
        norm = os.path.normpath(p)
        print(f"`$env:PATH = \"`$env:PATH;{norm}\"")

    print("Write-Output 'Environment variables and paths loaded from env.yml.'")


def output_cmd(env_vars, paths, autodetect_paths):
    """Emit CMD-compatible commands."""
    for k, v in env_vars.items():
        expanded = expand_vars(v, env_vars)
        print(f"set \"{k}={expanded}\"")

    # Prepend normal paths
    for p in paths:
        norm = os.path.normpath(p)
        print(f"set \"PATH={norm};%PATH%\"")

    # Append autodetect paths
    for p in autodetect_paths:
        norm = os.path.normpath(p)
        print(f"set \"PATH=%PATH%;{norm}\"")

    print("echo Environment variables and paths loaded from env.yml.")


def output_sh(env_vars, paths, autodetect_paths):
    """Emit Bash/Zsh-compatible exports with Unix-style paths (fast)."""
    env_type = detect_env_type()

    for k, v in env_vars.items():
        expanded = expand_vars(v, env_vars)
        expanded = to_unix_path(expanded, env_type)
        print(f"export {k}='{expanded}'")

    # Prepend normal paths
    for p in paths:
        norm = to_unix_path(os.path.normpath(p), env_type)
        print(f"export PATH=\"{norm}:`${{PATH:+`$PATH:}}\"")

    # Append autodetect paths
    for p in autodetect_paths:
        norm = to_unix_path(os.path.normpath(p), env_type)
        print(f"export PATH=\"`${{PATH:+`$PATH:}}{norm}\"")

    print("echo Environment variables and paths loaded from env.yml.")


# -----------------------------
# Main entry point
# -----------------------------
def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    yaml_path = os.path.join(base_dir, "env.yaml")
    if not os.path.exists(yaml_path):
        yaml_path = os.path.join(base_dir, "env.yml")
    if not os.path.exists(yaml_path):
        sys.stderr.write("Error: env.yaml or env.yml not found.\n")
        sys.exit(1)

    data = load_yaml(yaml_path)
    env_vars = data.get("env", {})
    paths, autodetect_paths = collect_paths(data, env_vars)

    shell = detect_shell()
    if shell == "powershell":
        output_powershell(env_vars, paths, autodetect_paths)
    elif shell == "cmd":
        output_cmd(env_vars, paths, autodetect_paths)
    else:
        output_sh(env_vars, paths, autodetect_paths)


if __name__ == "__main__":
    main()
"@

	$envPy | Out-File -FilePath $EnvPyPath -Encoding ASCII

	Write-Output "Created py script to parse yml: $EnvPyPath"

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