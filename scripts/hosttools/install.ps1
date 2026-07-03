param (
    [string]$InstallDir = "$env:USERPROFILE",
    [switch]$OnlyCheck,
    [switch]$ReinstallVenv,
    [switch]$CreateVenv,
    [string]$VenvPath,
    [string]$Tools = "",
    [switch]$UseSystemPython,
    [string]$PythonExePath = "",
    [string]$RequirementsRef = "",
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
  -ReinstallVenv         Remove the venv folder (see -VenvPath), create a new one and install Python requirements
  -CreateVenv            Create a Python venv (see -VenvPath) and install Python requirements; does not remove existing venv
  -VenvPath              Optional. Full path to the Python virtual environment to create/use. Defaults to '<InstallDir>\.zinstaller\.venv'
  -Tools                 Optional. Comma-separated subset of parts to install: gperf,cmake,ninja,dtc,git,wget,python,venv.
                         Base tools (yq, 7-Zip) run when a download is needed; the environment files are always processed.
                         Downloads use PowerShell by default; an installed wget is preferred with a PowerShell fallback.
                         Ignored with -OnlyCheck, -CreateVenv and -ReinstallVenv.
                         Note: selecting python without venv replaces the portable Python; an existing venv keeps
                         pointing at the old base interpreter, so select venv together with python to rebuild it.
  -UseSystemPython       Optional. Use the Python detected on PATH instead of downloading the portable one.
  -PythonExePath         Optional. Use a specific Python: path to python.exe or to a directory containing it.
                         Cannot be combined with -UseSystemPython.
                         Note: switching the Python source does not rebuild an existing venv (it stays bound to
                         its previous base interpreter); also select venv (-Tools python,venv) or use -ReinstallVenv.
  -RequirementsRef       Optional. Zephyr git ref (tag or branch, e.g. v4.2.0 or main) whose scripts/requirements*.txt
                         are installed into the virtual environment. Defaults to main. An explicit ref takes
                         precedence over a local ZEPHYR_BASE requirements file.

Arguments:
  InstallDir             Optional. The directory where the Zephyr environment will be installed. Defaults to '$env:USERPROFILE\.zinstaller'

Examples:
  install.ps1
  install.ps1 "C:\my\install\path"
  install.ps1 -OnlyCheck
  install.ps1 -ReinstallVenv
  install.ps1 -CreateVenv -VenvPath "D:\zw\.venv"
  install.ps1 "C:\my\install\path" -ReinstallVenv -VenvPath "C:\my\install\path\.zinstaller\.venv"
  install.ps1 "C:\my\install\path" -OnlyCheck
  install.ps1 -Tools cmake,ninja
  install.ps1 -UseSystemPython
  install.ps1 -PythonExePath "C:\Python313" -Tools python,venv
  install.ps1 -Tools venv -UseSystemPython -RequirementsRef v4.2.0
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

# ---------------------------------------------------------------------------
# Selective install (-Tools): only the listed parts run; the base tools
# (yq, wget, 7-Zip) and the environment files are always processed. Defined at
# top level so the final exit/stamp logic can always read the selection.
# ---------------------------------------------------------------------------
$script:SelectableSteps = @('gperf', 'cmake', 'ninja', 'dtc', 'git', 'wget', 'python', 'venv')
$script:SelectedSteps = @($Tools -split ',' | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ -ne '' })

if ($script:SelectedSteps.Count -gt 0 -and ($OnlyCheck -or $CreateVenv -or $ReinstallVenv)) {
    # A warning line cannot match the 'name [version]' pattern the Host Tools
    # Manager parses from -OnlyCheck output, so this is safe to print.
    Write-Output "WARN: -Tools is ignored with -OnlyCheck, -CreateVenv and -ReinstallVenv"
    $script:SelectedSteps = @()
}

if ($script:SelectedSteps.Count -gt 0) {
    $unknownSteps = @($script:SelectedSteps | Where-Object { $script:SelectableSteps -notcontains $_ })
    if ($unknownSteps.Count -gt 0) {
        Write-Output "ERROR: Unknown value(s) for -Tools: $($unknownSteps -join ', '). Valid values: $($script:SelectableSteps -join ', ')"
        exit 1
    }
}

# ---------------------------------------------------------------------------
# Python source selection: portable (default, downloaded), system
# (-UseSystemPython, resolved from PATH) or custom (-PythonExePath).
# Downstream code always calls bare 'python'; the chosen source is put on the
# process PATH once, before any python use.
# ---------------------------------------------------------------------------
$script:PythonMode = 'portable'
$script:CustomPythonDir = ""

if ($UseSystemPython -and $PythonExePath) {
    Write-Output "ERROR: -UseSystemPython and -PythonExePath cannot be combined"
    exit 1
}
if ($UseSystemPython) {
    $script:PythonMode = 'system'
} elseif ($PythonExePath) {
    $resolvedPythonExe = $PythonExePath
    if (Test-Path -Path $PythonExePath -PathType Container) {
        $resolvedPythonExe = Join-Path -Path $PythonExePath -ChildPath "python.exe"
    }
    if (-not (Test-Path -Path $resolvedPythonExe -PathType Leaf)) {
        Write-Output "ERROR: -PythonExePath does not point to a python executable: $PythonExePath"
        exit 1
    }
    $script:PythonMode = 'custom'
    $script:CustomPythonDir = Split-Path -Parent ([System.IO.Path]::GetFullPath($resolvedPythonExe))
}

# ---------------------------------------------------------------------------
# Zephyr requirements ref: which zephyr tag/branch provides the
# scripts/requirements*.txt installed into the virtual environment.
# ---------------------------------------------------------------------------
$script:RequirementsRefValue = 'main'
if ($RequirementsRef) {
    if ($RequirementsRef -notmatch '^[A-Za-z0-9._/-]+$') {
        Write-Output "ERROR: -RequirementsRef contains invalid characters: $RequirementsRef"
        exit 1
    }
    $script:RequirementsRefValue = $RequirementsRef
}

# ---------------------------------------------------------------------------
# The base tools (yq, 7-Zip) exist to download and extract the other tools.
# When a selective run needs no download at all (e.g. only the venv with a
# system or custom python), they are skipped. wget is NOT base infrastructure:
# downloads default to Invoke-WebRequest, and an installed/detected wget is
# only used as a preferred downloader with an Invoke-WebRequest fallback.
# ---------------------------------------------------------------------------
$script:InfraSteps = @('yq', '7z')
$script:InfraNeeded = $true
if ($script:SelectedSteps.Count -gt 0) {
    $downloadingParts = @('gperf', 'cmake', 'ninja', 'dtc', 'git', 'wget')
    $needsDownloads = @($script:SelectedSteps | Where-Object { $downloadingParts -contains $_ }).Count -gt 0
    if (-not $needsDownloads -and $script:SelectedSteps -contains 'python' -and $script:PythonMode -eq 'portable') {
        $needsDownloads = $true
    }
    $script:InfraNeeded = $needsDownloads
}

# Check if an install directory argument is provided
$InstallDirectory = Join-Path -Path $InstallDir -ChildPath ".zinstaller"

# Check if the path is relative and convert it to absolute based on the current working directory
if (-not [System.IO.Path]::IsPathRooted($InstallDirectory)) {
    $CurrentDirectory = (Get-Location).Path
    $InstallDirectory = Join-Path -Path $CurrentDirectory -ChildPath $InstallDirectory
}

Write-Output "Install directory: $InstallDirectory"

# Determine venv path (defaults to <InstallDirectory>\.venv) and normalize to absolute
if (-not $VenvPath -or [string]::IsNullOrWhiteSpace($VenvPath)) {
    $VenvPath = Join-Path -Path $InstallDirectory -ChildPath ".venv"
}
if (-not [System.IO.Path]::IsPathRooted($VenvPath)) {
    $VenvPath = Join-Path -Path (Get-Location).Path -ChildPath $VenvPath
}
Write-Output "Venv path: $VenvPath"

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

function Print-Warning {
    param (
        [string]$Message
    )

    Write-Output "WARN: $Message"
}

function Install-PythonVenv {
    param (
        [string]$VenvPath
    )

    # Reset per-run list of pip packages that failed to install. A failed
    # package is recorded and the loop continues; only an unusable venv or
    # missing base requirements abort this function (via throw).
    $script:VenvPackageFailures = @()

    Print-Title "Zephyr Python-Requirements"
    $RequirementsBaseUrl = "https://raw.githubusercontent.com/zephyrproject-rtos/zephyr/$($script:RequirementsRefValue)/scripts"

    # Decide requirements source. An explicit -RequirementsRef wins over a
    # local ZEPHYR_BASE tree: the user asked for that specific version.
    $UseZephyrBaseReq = $false
    $RequirementsFile = $null
    if (-not $RequirementsRef -and $env:ZEPHYR_BASE -and -not [string]::IsNullOrWhiteSpace($env:ZEPHYR_BASE)) {
        $Candidate = Join-Path -Path $env:ZEPHYR_BASE -ChildPath "scripts\requirements.txt"
        if (Test-Path -Path $Candidate) {
            $UseZephyrBaseReq = $true
            $RequirementsFile = $Candidate
            Write-Output "Using ZEPHYR_BASE requirements: $RequirementsFile"
        } else {
            Write-Output "WARN: ZEPHYR_BASE is set but requirements file not found at $Candidate. Falling back to downloading."
        }
    }

    if (-not $UseZephyrBaseReq) {
        # Fetch requirements into a temporary folder
        $RequirementsDirectory = "$TemporaryDirectory\requirements"
        New-Item -Path "$RequirementsDirectory" -ItemType Directory -Force > $null 2>&1

        Download-WithoutCheck "$RequirementsBaseUrl/requirements.txt" "requirements.txt"
        Download-WithoutCheck "$RequirementsBaseUrl/requirements-run-test.txt" "requirements-run-test.txt"
        Download-WithoutCheck "$RequirementsBaseUrl/requirements-extras.txt" "requirements-extras.txt"
        Download-WithoutCheck "$RequirementsBaseUrl/requirements-compliance.txt" "requirements-compliance.txt"
        Download-WithoutCheck "$RequirementsBaseUrl/requirements-build-test.txt" "requirements-build-test.txt"
        Download-WithoutCheck "$RequirementsBaseUrl/requirements-base.txt" "requirements-base.txt"
        Move-Item -Path "$DownloadDirectory/require*.txt" -Destination "$RequirementsDirectory" -Force

        $RequirementsFile = Join-Path -Path $RequirementsDirectory -ChildPath "requirements.txt"
        Write-Output "Using downloaded requirements: $RequirementsFile (Zephyr ref: $($script:RequirementsRefValue))"
    }

    if ((Test-Path -Path $VenvPath) -and -not (Test-Path -Path "$VenvPath\Scripts\Activate.ps1")) {
        # Half-created venv (e.g. a previous run was killed mid-creation):
        # recreate it instead of failing on the same broken folder forever.
        Print-Warning "Existing virtual environment at $VenvPath is incomplete; recreating it"
        Remove-Item -Path $VenvPath -Recurse -Force
    }
    if (-not (Test-Path -Path $VenvPath)) {
        python -m venv "$VenvPath"
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to create Python virtual environment at $VenvPath (exit code $LASTEXITCODE)"
        }
    }
    if (-not (Test-Path -Path "$VenvPath\Scripts\Activate.ps1")) {
        throw "Python virtual environment at $VenvPath is unusable: Scripts\Activate.ps1 not found"
    }
    . "$VenvPath\Scripts\Activate.ps1"
    $ParserScript = Join-Path $ScriptDirectory "parse_python_packages.py"

    Write-Output "Upgrading pip to the latest version..."
    python -m pip install --upgrade pip --quiet
    if ($LASTEXITCODE -ne 0) {
        Add-StepWarning "Failed to upgrade pip (exit code $LASTEXITCODE); continuing with the current version"
    }

    # Ensure PyYAML is available before parsing tools.yml within the venv.
    & python -c "import yaml" 2>$null 1>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Output "Installing PyYAML into the virtual environment..."
        & python -m pip install PyYAML --quiet
        if ($LASTEXITCODE -ne 0) {
            Add-StepWarning "Failed to install PyYAML; python_packages from tools.yml may be skipped"
        }
    }

    $pythonPackageSpecs = @()
    if (Test-Path -Path $ParserScript) {
        # Shared parser yields package specs while honoring per-OS gating.
        $pythonPackageSpecs = & python $ParserScript $YamlFilePath $SelectedOperatingSystem
        if ($LASTEXITCODE -ne 0) {
            Write-Output "WARN: Failed to parse python_packages from $YamlFilePath"
            $pythonPackageSpecs = @()
        }
    } else {
        Write-Output "WARN: Parser script not found: $ParserScript"
    }

    foreach ($spec in $pythonPackageSpecs) {
        if ([string]::IsNullOrWhiteSpace($spec)) { continue }
        Write-Output "Installing Python package: $spec"
        & python -m pip install $spec --quiet
        if ($LASTEXITCODE -ne 0) {
            # One bad package must not stop the others: record and continue.
            Print-Warning "Failed to install Python package: $spec"
            $script:VenvPackageFailures += $spec
        }
    }

    Write-Output "Installing Zephyr's base requirements..."
    & python -m pip install -r "$RequirementsFile" --quiet
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to install Zephyr base requirements from $RequirementsFile (exit code $LASTEXITCODE)"
    }

    # Every package was attempted above (one bad package never stops the
    # others), but the packages in tools.yml are not optional (west, ...):
    # report the run as failed so a plain re-run repairs the missing ones.
    if ($script:VenvPackageFailures.Count -gt 0) {
        throw "Failed to install $($script:VenvPackageFailures.Count) Python package(s): $($script:VenvPackageFailures -join ', ')"
    }
}



if (! $OnlyCheck -or $ReinstallVenv) {

    # Create directories if they do not exist, and suppress output
    New-Item -Path $InstallDirectory -ItemType Directory -Force > $null 2>&1
    New-Item -Path $TemporaryDirectory -ItemType Directory -Force > $null 2>&1
    New-Item -Path $DownloadDirectory -ItemType Directory -Force > $null 2>&1
    New-Item -Path $WorkDirectory -ItemType Directory -Force > $null 2>&1
    New-Item -Path $ToolsDirectory -ItemType Directory -Force > $null 2>&1
    
    # Resolve the Python source on PATH once (also covers the venv-only modes
    # below). In system/custom mode a leftover portable Python must never
    # shadow the chosen interpreter, so its entries are stripped.
    $PortablePythonBin = Join-Path $ToolsDirectory "python\python"
    $PortablePythonScripts = Join-Path $ToolsDirectory "python\python\Scripts"
    if ($script:PythonMode -eq 'custom') {
        $env:PATH = (($env:PATH -split ';') | Where-Object { $_ -and -not $_.StartsWith($PortablePythonBin, [System.StringComparison]::OrdinalIgnoreCase) }) -join ';'
        $CustomPythonScriptsDir = Join-Path $script:CustomPythonDir "Scripts"
        $env:PATH = "$($script:CustomPythonDir);$CustomPythonScriptsDir;" + $env:PATH
    } elseif ($script:PythonMode -eq 'system') {
        $env:PATH = (($env:PATH -split ';') | Where-Object { $_ -and -not $_.StartsWith($PortablePythonBin, [System.StringComparison]::OrdinalIgnoreCase) }) -join ';'
    } elseif (Test-Path -Path $PortablePythonBin) {
        $env:PATH = "$PortablePythonBin;$PortablePythonScripts;" + $env:PATH
    }
    
    # wget is optional: downloads default to Invoke-WebRequest. An already
    # installed (or PATH-detected) wget is preferred, and every wget download
    # falls back to Invoke-WebRequest when it fails.
    $script:UseWget = $false
    $script:Wget = ''
    $ExistingWget = Join-Path $ToolsDirectory "wget\wget.exe"
    if (Test-Path -Path $ExistingWget) {
        $script:Wget = $ExistingWget
        $script:UseWget = $true
    } else {
        $WgetOnPath = Get-Command wget.exe -ErrorAction SilentlyContinue
        if ($WgetOnPath -and $WgetOnPath.Source) {
            $script:Wget = $WgetOnPath.Source
            $script:UseWget = $true
        }
    }
    if ($script:UseWget) {
        Write-Output "Detected wget, preferring it for downloads: $($script:Wget)"
    }

    function Download-FileWithHashCheck {
        param (
            [string]$SourceUrl,
            [string]$ExpectedHash,
            [string]$Filename
        )

        # Same download path as unchecked downloads, plus hash verification.
        Download-WithoutCheck $SourceUrl $Filename

        $FilePath = Join-Path -Path $DownloadDirectory -ChildPath $Filename

        # Compute the SHA-256 hash of the downloaded file
        $ComputedHash = Get-FileHash -Path $FilePath -Algorithm SHA256 | Select-Object -ExpandProperty Hash

        # Compare the computed hash with the expected hash
        if ($ComputedHash -eq $ExpectedHash) {
            Write-Output "DL: $Filename downloaded successfully"
        } else {
            throw "Hash mismatch for ${Filename}: expected $ExpectedHash, computed $ComputedHash"
        }
    }
	
    function Download-WithoutCheck {
        param (
            [string]$SourceUrl,
            [string]$Filename
        )
    
        # Full path where the file will be saved
        $FilePath = Join-Path -Path $DownloadDirectory -ChildPath $Filename

        $downloadMethod = 'PowerShell'
        if ($UseWget) { $downloadMethod = 'wget' }
        Write-Output "Downloading: $Filename ($downloadMethod) ..."

        $wgetSucceeded = $false
        if ($UseWget) {
            # Prefer an available wget, but never depend on it: any failure
            # (non-zero exit, broken executable) falls back to Invoke-WebRequest.
            try {
                & $Wget -q $SourceUrl -O $FilePath
                if ($LASTEXITCODE -eq 0) { $wgetSucceeded = $true }
            } catch { }
            if (-not $wgetSucceeded) {
                # wget -O leaves a zero-byte file behind on failure
                Remove-Item -Path $FilePath -Force -ErrorAction SilentlyContinue
                Print-Warning "wget could not download $Filename; falling back to Invoke-WebRequest"
            }
        }
        if (-not $wgetSucceeded) {
            # Default download method, made silent because the progress bar
            # slows Invoke-WebRequest down considerably. The wget user agent
            # matters: some hosts (sourceforge) serve an HTML page to browser
            # agents but the direct binary to wget-like agents.
            & {
                 $ProgressPreference = 'SilentlyContinue'
                 Invoke-WebRequest -Uri $SourceUrl -OutFile $FilePath -UserAgent 'Wget/1.21.4' -ErrorAction Stop
            }
        }
        # Check if the download was successful
        if (-Not (Test-Path -Path $FilePath)) {
            throw "Failed to download $Filename from $SourceUrl"
        }

    }
    
    function Test-FileExistence {
        param (
            [string]$FilePath  # Path to the file to check
        )

        if (-Not (Test-Path -Path $FilePath)) {
            throw "File does not exist: $FilePath"
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
        # Using yq to parse the source, sha256 and version for the specific OS and tool
        $Source = & $Yq eval ".*_content[] | select(.tool == `"`"`"$Tool`"`"`") | .os.$OperatingSystem.source" $YamlFilePath
        $Sha256 = & $Yq eval ".*_content[] | select(.tool == `"`"`"$Tool`"`"`") | .os.$OperatingSystem.sha256" $YamlFilePath
        $ToolVersion = & $Yq eval ".*_content[] | select(.tool == `"`"`"$Tool`"`"`") | .os.$OperatingSystem.version" $YamlFilePath

        # Check if the source and sha256 are not null (meaning the tool supports the OS)
        # Entries are written to script scope because the manifest is dot-sourced
        # inside a step scriptblock and later steps must still see the arrays.
        if ($Source -ne 'null' -and $Sha256 -ne 'null') {
            $ManifestEntry = @"
`$script:${Tool}_array =  @('$Source','$Sha256')

"@
            Add-Content $ManifestFilePath $ManifestEntry
            if ($ToolVersion -and $ToolVersion -ne 'null') {
                Add-Content $ManifestFilePath "`$script:${Tool}_version = '$ToolVersion'"
            }
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
            throw "Failed to extract $ZipFilePath (7z exit code $LastExitCode)"
        }
    }
    
    # ----------------------------------------------------------------------
    # Step runner: every tool section below runs as a "step". A step failure
    # is recorded and the installation CONTINUES with the remaining steps
    # instead of aborting the whole install. Steps whose prerequisites failed
    # are skipped with a reason, and steps deselected via -Tools are marked
    # 'not selected'. A summary is printed at the end and the script exits 0
    # only when no step failed and nothing selected ended up skipped.
    # ----------------------------------------------------------------------
    $script:StepResults = New-Object System.Collections.ArrayList
    $script:CurrentStepWarnings = $null

    # Presence probes: when a required step was deselected (-Tools), the
    # dependency still counts as satisfied if the artifact of a previous run is
    # present on disk. Only the venv -> python edge needs one today.
    $script:StepPresenceProbes = @{
        python = {
            if (Test-Path -Path "$ToolsDirectory\python\python\python.exe") { return $true }
            # A system or custom Python satisfies the dependency too (installs
            # done with -UseSystemPython/-PythonExePath): functional probe, the
            # Microsoft Store alias stub exits non-zero.
            try {
                & python --version > $null 2>&1
                if ($LASTEXITCODE -eq 0) { return $true }
            } catch {}
            return $false
        }
    }

    function Add-StepWarning {
        param([string]$Message)
        Print-Warning $Message
        if ($null -ne $script:CurrentStepWarnings) {
            $null = $script:CurrentStepWarnings.Add($Message)
        }
    }

    function Assert-Exe {
        # Native executables do not throw on failure; call this right after one.
        param([string]$What)
        if ($LASTEXITCODE -ne 0) {
            throw "$What failed with exit code $LASTEXITCODE"
        }
    }

    function Get-ManifestToolVersion {
        # Versions come from tools.yml (os.windows.version), emitted into the
        # manifest by the yq step: the single source of truth for what gets
        # installed, shared with the Advanced Host Tools panel.
        param([string]$Tool)
        $found = Get-Variable -Name "${Tool}_version" -Scope Script -ErrorAction SilentlyContinue
        if (-not $found -or -not $found.Value -or $found.Value -eq 'null') {
            throw "No version defined for tool '$Tool' in tools.yml (os.windows.version)"
        }
        return $found.Value
    }

    function Get-StepResult {
        param([string]$Name)
        return $script:StepResults | Where-Object { $_.name -eq $Name } | Select-Object -First 1
    }

    function Invoke-Step {
        param(
            [Parameter(Mandatory)][string]$Name,
            [string]$Label = "",
            [string[]]$Requires = @(),
            [Parameter(Mandatory)][scriptblock]$Body
        )
        if (-not $Label) { $Label = $Name }
        # Selection filter first: a deselected step reports 'not selected' even
        # when its prerequisites failed (the exit signal comes from those).
        if ($script:SelectedSteps.Count -gt 0 -and $script:SelectableSteps -contains $Name -and $script:SelectedSteps -notcontains $Name) {
            $null = $script:StepResults.Add([ordered]@{ name = $Name; label = $Label; status = 'not-selected'; error = $null; reason = 'not selected'; warnings = @() })
            return
        }
        # Base tools are skipped when the selection needs no download at all.
        if (-not $script:InfraNeeded -and $script:InfraSteps -contains $Name) {
            $null = $script:StepResults.Add([ordered]@{ name = $Name; label = $Label; status = 'not-selected'; error = $null; reason = 'not needed for this selection'; warnings = @() })
            return
        }
        foreach ($req in $Requires) {
            $reqResult = Get-StepResult -Name $req
            $reqSatisfied = $false
            $skipReason = "requires '$req'"
            if ($reqResult -and ($reqResult.status -eq 'success' -or $reqResult.status -eq 'warning')) {
                $reqSatisfied = $true
            } elseif ($reqResult -and $reqResult.status -eq 'not-selected') {
                # Deselected prerequisite: fall back to the on-disk artifact of
                # a previous run.
                $probe = $script:StepPresenceProbes[$req]
                if ($probe -and (& $probe)) {
                    $reqSatisfied = $true
                } else {
                    $skipReason = "requires '$req' (not selected and not installed)"
                }
            }
            if (-not $reqSatisfied) {
                Print-Warning "Skipping ${Label}: required step '$req' did not succeed"
                $null = $script:StepResults.Add([ordered]@{ name = $Name; label = $Label; status = 'skipped'; error = $null; reason = $skipReason; warnings = @() })
                return
            }
        }
        $script:CurrentStepWarnings = New-Object System.Collections.ArrayList
        $global:LASTEXITCODE = 0
        try {
            & $Body
            $status = 'success'
            if ($script:CurrentStepWarnings.Count -gt 0) { $status = 'warning' }
            $null = $script:StepResults.Add([ordered]@{ name = $Name; label = $Label; status = $status; error = $null; reason = $null; warnings = @($script:CurrentStepWarnings) })
        } catch {
            Write-Output "ERROR: Step '$Label' failed: $($_.Exception.Message)"
            $null = $script:StepResults.Add([ordered]@{ name = $Name; label = $Label; status = 'failed'; error = "$($_.Exception.Message)"; reason = $null; warnings = @($script:CurrentStepWarnings) })
        } finally {
            $script:CurrentStepWarnings = $null
        }
    }

    function Get-YamlWindowsField {
        # Minimal line-scan of tools.yml, usable BEFORE yq is available (the
        # same technique that bootstraps yq itself). Needed because env.yml is
        # always generated, even when the yq step failed or was skipped as not
        # needed, so these values cannot depend on the manifest.
        param([string]$Tool, [string]$Field)
        $foundTool = $false
        $foundOs = $false
        foreach ($line in Get-Content -Path $YamlFilePath) {
            if ($line -match "^\s*- tool: $Tool\s*$") { $foundTool = $true; $foundOs = $false; continue }
            if ($foundTool -and $line -match "^\s*- tool: ") { break }
            if ($foundTool -and $line -match "^\s*windows:\s*$") { $foundOs = $true; continue }
            if ($foundTool -and $foundOs -and $line -match "^\s*(linux|darwin):\s*$") { $foundOs = $false; continue }
            if ($foundTool -and $foundOs -and $line -match "^\s*${Field}:\s*(.+)$") {
                return $matches[1].Trim().Trim('"').Trim("'")
            }
        }
        return ''
    }

    # Versions used by the env.yml manifest, read from tools.yml (the single
    # source of truth; no hardcoded copies). The python step overrides
    # pythonVersion with the detected one in system/custom mode.
    $script:wgetVersion = Get-YamlWindowsField 'wget' 'version'
    $script:pythonVersion = Get-YamlWindowsField 'python_portable' 'version'
    if (-not $script:wgetVersion) { $script:wgetVersion = 'unknown' }
    if (-not $script:pythonVersion) { $script:pythonVersion = 'unknown' }
    # Default 7-Zip location; the 7z step overwrites these when it resolves or
    # installs one. A preset default keeps env.yml from ever containing an empty
    # path (env.py would normalize "" to "." and prepend the cwd to PATH).
    $script:SevenZ = "C:\Program Files\7-Zip\7z.exe"
    $script:SevenZPath = "C:\Program Files\7-Zip"

    Invoke-Step -Name 'yq' -Label 'yq (YAML parser)' -Body {
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
    $script:Yq = $YqPath

    Print-Title "Parse YAML and generate manifest"
    "# Automatically generated by Zinstaller on Powershell" | Out-File -FilePath $ManifestFilePath

    # List all tools from the YAML file
    $ToolsList = & $Yq eval '.*_content[].tool' $YamlFilePath
    Assert-Exe "yq parsing of tools.yml"

    # Loop through each tool and generate the entries
    foreach ($Tool in $ToolsList) {
        New-ManifestEntry $Tool $SelectedOperatingSystem
    }

    # Source manifest to get the array of elements (script scope, see New-ManifestEntry)
    . $ManifestFilePath
    }

    Invoke-Step -Name 'wget' -Label 'wget' -Requires @('yq') -Body {
    Print-Title "Wget"
    $WgetExecutableName = "wget.exe"
    Download-FileWithHashCheck $wget_array[0] $wget_array[1] $WgetExecutableName
    Test-FileExistence -FilePath "$DownloadDirectory\$WgetExecutableName"

    New-Item -Path "$ToolsDirectory\wget" -ItemType Directory -Force > $null 2>&1
    Copy-Item -Path "$DownloadDirectory\$WgetExecutableName" -Destination "$ToolsDirectory\wget\$WgetExecutableName" -ErrorAction Stop

    $script:Wget = "$ToolsDirectory\wget\$WgetExecutableName"

    # A freshly installed wget becomes the preferred downloader for the rest
    # of the run (Invoke-WebRequest remains the fallback on any failure).
    $script:UseWget = $true
    }

    # No -Requires here: detecting an already-installed 7-Zip works without the
    # manifest; only the download-and-install branch needs the yq step.
    Invoke-Step -Name '7z' -Label '7-Zip' -Body {
    Print-Title "7-Zip"

    $SevenZInstalled = Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "*7-Zip*" }

    if ($SevenZInstalled) {
        Write-Host "7-Zip is already installed."
        $script:SevenZ = "C:\Program Files\7-Zip\7z.exe"
        $script:SevenZPath = "C:\Program Files\7-Zip"

        if (-Not (Test-Path -Path $SevenZ)) {
            #maybe 7z 32 bits installed
            $script:SevenZ = "C:\Program Files (x86)\7-Zip\7z.exe"
            $script:SevenZPath = "C:\Program Files (x86)\7-Zip"
        }

        Test-FileExistence -FilePath $SevenZ
        #if 7z installed in a non default place it will fail, you should use the portable version without -Global
    } else {
        Write-Host "7-Zip is not installed."
        if (-not $script:seven_z_array) {
            throw "7-Zip is not installed and its installer cannot be downloaded because the manifest is unavailable (step 'yq' did not succeed)"
        }
        Write-Host "Installing now 7z Global..."
        $SevenZInstallerName = "7z-installer.exe"
        Download-FileWithHashCheck $seven_z_array[0] $seven_z_array[1] $SevenZInstallerName

        $SevenZInstallerPath = Join-Path -Path $DownloadDirectory -ChildPath $SevenZInstallerName

        $SevenZProcess = Start-Process -FilePath $SevenZInstallerPath -ArgumentList "/S" -Wait -PassThru
        if ($SevenZProcess.ExitCode -ne 0) {
            throw "7-Zip installer exited with code $($SevenZProcess.ExitCode)"
        }
        Write-Host "7-Zip installation completed."
        $SevenZInstalled = Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "*7-Zip*" }
        if ($SevenZInstalled) {
            Write-Host "7-Zip was installed successfully"
        } else {
            throw "7-Zip was not installed"
        }
        $script:SevenZ = "C:\Program Files\7-Zip\7z.exe"
        $script:SevenZPath = "C:\Program Files\7-Zip"
        Test-FileExistence -FilePath $SevenZ
        Write-Host "7-Zip installation completed."
    }
    }

	if ($CreateVenv) {
		Print-Title "Creating Python VENV"
		$venvExitCode = 0
		try {
			if ((Test-Path -Path $VenvPath) -and (Test-Path -Path "$VenvPath\Scripts\Activate.ps1")) {
				Write-Output "VENV already exists at: $VenvPath"
			} else {
				# Missing or half-created venv: Install-PythonVenv recreates it.
				Install-PythonVenv -VenvPath $VenvPath
			}
		} catch {
			Write-Output "ERROR: Creating Python venv failed: $($_.Exception.Message)"
			$venvExitCode = 1
		} finally {
			Remove-Item -Path $TemporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
		}
		exit $venvExitCode
	}

	if ($ReinstallVenv) {
		Print-Title "Reinstalling Python VENV"
		$venvExitCode = 0
		try {
			# Never delete the existing venv when this run cannot plausibly
			# rebuild it. The yq/wget steps are the canary for GitHub being
			# reachable (the Zephyr requirements download needs it); other step
			# failures (e.g. 7-Zip) do not affect the venv and do not block.
			$failedNetworkSteps = @($script:StepResults | Where-Object { ($_.name -eq 'yq' -or $_.name -eq 'wget') -and $_.status -eq 'failed' })
			if ($failedNetworkSteps.Count -gt 0) {
				$failedLabels = ($failedNetworkSteps | ForEach-Object { $_.label }) -join ', '
				throw "Not reinstalling the venv because prerequisite step(s) failed: $failedLabels. Existing venv left untouched."
			}
			# A functional probe, not Get-Command: the Microsoft Store
			# app-execution alias resolves as 'python' but only prints an
			# installation hint and exits non-zero.
			$pythonWorks = $false
			try {
				& python --version > $null 2>&1
				if ($LASTEXITCODE -eq 0) { $pythonWorks = $true }
			} catch {}
			if (-not $pythonWorks) {
				throw "No working python executable found on PATH; existing venv left untouched."
			}
			if (Test-Path -Path $VenvPath) {
				Remove-Item -Path $VenvPath -Recurse -Force
			}

			Install-PythonVenv -VenvPath $VenvPath
		} catch {
			Write-Output "ERROR: Reinstalling Python venv failed: $($_.Exception.Message)"
			$venvExitCode = 1
		} finally {
			Remove-Item -Path $TemporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
		}
		exit $venvExitCode
	}

    Invoke-Step -Name 'gperf' -Label 'gperf' -Requires @('yq','7z') -Body {
    Print-Title "Gperf"
    $GperfVersion = Get-ManifestToolVersion 'gperf'
    $GperfZipName = "gperf-${GperfVersion}-bin.zip"
    $GperfInstallDirectory = "$ToolsDirectory\gperf"
    Download-FileWithHashCheck $gperf_array[0] $gperf_array[1] $GperfZipName

    New-Item -Path $GperfInstallDirectory -ItemType Directory -Force > $null 2>&1
    Extract-ArchiveFile -ZipFilePath "$DownloadDirectory\$GperfZipName" -DestinationDirectory $GperfInstallDirectory
    }

    Invoke-Step -Name 'cmake' -Label 'CMake' -Requires @('yq','7z') -Body {
    Print-Title "CMake"
    $CmakeVersion = Get-ManifestToolVersion 'cmake'
    $CmakeZipName = "cmake-${CmakeVersion}-windows-x86_64.zip"
    $CmakeFolderName = "cmake-${CmakeVersion}-windows-x86_64"
    Download-FileWithHashCheck $cmake_array[0] $cmake_array[1] $CmakeZipName
    Extract-ArchiveFile -ZipFilePath "$DownloadDirectory\$CmakeZipName" -DestinationDirectory $ToolsDirectory
    # Only replace an existing cmake once the new one is fully extracted, so a
    # failed extraction cannot destroy a working install.
    if (-not (Test-Path -Path "$ToolsDirectory\$CmakeFolderName")) {
        throw "CMake extraction did not produce $CmakeFolderName"
    }
    if (Test-Path -Path $ToolsDirectory\cmake) {
        Remove-Item -Path $ToolsDirectory\cmake -Recurse -Force -ErrorAction Stop
    }
    Rename-Item -Path "$ToolsDirectory\$CmakeFolderName" -NewName "cmake" -ErrorAction Stop
    }

    Invoke-Step -Name 'ninja' -Label 'Ninja' -Requires @('yq','7z') -Body {
    Print-Title "Ninja"
    $NinjaZipName = "ninja-win.zip"
    Download-FileWithHashCheck $ninja_array[0] $ninja_array[1] $NinjaZipName

    $NinjaFolderPath = "$ToolsDirectory\ninja"
    New-Item -Path $NinjaFolderPath -ItemType Directory -Force > $null 2>&1

    Extract-ArchiveFile -ZipFilePath "$DownloadDirectory\$NinjaZipName" -DestinationDirectory $NinjaFolderPath
    }

    # Composite step: dtc needs zstd (decompression) plus the msys2 runtime and
    # libyaml DLLs grafted into its bin folder before its self-test can pass.
    Invoke-Step -Name 'dtc' -Label 'Device Tree Compiler' -Requires @('yq','7z') -Body {
    Print-Title "Zstd"
    $ZstdVersion = Get-ManifestToolVersion 'zstd'
    $ZstdZipName = "zstd-v${ZstdVersion}-win64.zip"
    Download-FileWithHashCheck $zstd_array[0] $zstd_array[1] $ZstdZipName
    Extract-ArchiveFile -ZipFilePath "$DownloadDirectory\$ZstdZipName" -DestinationDirectory $DownloadDirectory

    $ZstdFolderName = "zstd-v${ZstdVersion}-win64"
    $ZstdExecutable = "$DownloadDirectory\$ZstdFolderName\zstd.exe"

    Print-Title "DTC"
    $DtcVersion = Get-ManifestToolVersion 'dtc'
    $DtcZstName = "dtc-${DtcVersion}-x86_64.pkg.tar.zst"
    $DtcZstTarName = "dtc-${DtcVersion}-x86_64.pkg.tar"
    Download-FileWithHashCheck $dtc_array[0] $dtc_array[1] $DtcZstName

    # -f: overwrite a leftover .tar from a previously killed run
    & $ZstdExecutable --quiet -d -f "$DownloadDirectory\$DtcZstName" -o "$DownloadDirectory\$DtcZstTarName"
    Assert-Exe "zstd decompression of $DtcZstName"

    $DtcFolderPath = "$ToolsDirectory\dtc"
    New-Item -Path $DtcFolderPath -ItemType Directory -Force > $null 2>&1
    Extract-ArchiveFile -ZipFilePath "$DownloadDirectory\$DtcZstTarName" -DestinationDirectory $DtcFolderPath

    Print-Title "msys2"
    $Msys2Version = Get-ManifestToolVersion 'msys2_runtime'
    $Msys2ZstName = "msys2-runtime-${Msys2Version}-x86_64.pkg.tar.zst"
    $Msys2ZstTarName = "msys2-runtime-${Msys2Version}-x86_64.pkg.tar"
    Download-FileWithHashCheck $msys2_runtime_array[0] $msys2_runtime_array[1] $Msys2ZstName

    & $ZstdExecutable --quiet -d -f "$DownloadDirectory\$Msys2ZstName" -o "$DownloadDirectory\$Msys2ZstTarName"
    Assert-Exe "zstd decompression of $Msys2ZstName"

    $Msys2FolderPath = "$DownloadDirectory\msys2"
    New-Item -Path $Msys2FolderPath -ItemType Directory -Force > $null 2>&1
    Extract-ArchiveFile -ZipFilePath "$DownloadDirectory\$Msys2ZstTarName" -DestinationDirectory $Msys2FolderPath

    Copy-Item -Path "$Msys2FolderPath\usr\bin\msys-2.0.dll" -Destination "$DtcFolderPath\usr\bin\msys-2.0.dll" -ErrorAction Stop

    Print-Title "libyaml"
    $LibyamlVersion = Get-ManifestToolVersion 'libyaml'
    $LibyamlName = "libyaml-${LibyamlVersion}-x86_64"
    $LibyamlZstName = "$LibyamlName.pkg.tar.zst"
    $LibyamlZstTarName = "$LibyamlName.pkg.tar"
    Download-FileWithHashCheck $libyaml_array[0] $libyaml_array[1] $LibyamlZstName

    & $ZstdExecutable --quiet -d -f "$DownloadDirectory\$LibyamlZstName" -o "$DownloadDirectory\$LibyamlZstTarName"
    Assert-Exe "zstd decompression of $LibyamlZstName"

    $LibyamlFolderPath = "$DownloadDirectory\libyaml"
    New-Item -Path $LibyamlFolderPath -ItemType Directory -Force > $null 2>&1
    Extract-ArchiveFile -ZipFilePath "$DownloadDirectory\$LibyamlZstTarName" -DestinationDirectory $LibyamlFolderPath

    Copy-Item -Path "$LibyamlFolderPath\usr\bin\msys-yaml-0-2.dll" -Destination "$DtcFolderPath\usr\bin\msys-yaml-0-2.dll" -ErrorAction Stop

    Print-Title "Check DTC"

    $DtcExecutable = "$DtcFolderPath\usr\bin\dtc.exe"
    & $DtcExecutable --version

    if ($LastExitCode -eq 0) {
        Write-Output "Device tree compiler was successfully installed"
    } else {
        throw "Device tree compiler self-test failed (exit code $LastExitCode)"
    }
    }

    Invoke-Step -Name 'git' -Label 'Git' -Requires @('yq') -Body {
    Print-Title "Git"
    $GitVersion = Get-ManifestToolVersion 'git'
    $GitSetupFilename = "PortableGit-${GitVersion}-64-bit.7z.exe"
    Download-FileWithHashCheck $git_array[0] $git_array[1] $GitSetupFilename

    $GitInstallDirectory = "$ToolsDirectory\git"

    # Extract and wait (PortableGit is a self-extractor, no 7-Zip needed)
    $GitProcess = Start-Process -FilePath "$DownloadDirectory\$GitSetupFilename" -ArgumentList "-o`"$ToolsDirectory\git`" -y" -Wait -PassThru
    if ($GitProcess.ExitCode -ne 0) {
        throw "PortableGit self-extraction failed (exit code $($GitProcess.ExitCode))"
    }
    # Self-extractors can return 0 on partial extraction; verify the payload.
    if (-not (Test-Path -Path "$GitInstallDirectory\bin\git.exe")) {
        throw "Git extraction did not produce $GitInstallDirectory\bin\git.exe"
    }
    }

    # In system/custom mode the python step validates the chosen interpreter
    # instead of downloading the portable one, so it needs no manifest (yq).
    $PythonStepRequires = @('yq')
    if ($script:PythonMode -ne 'portable') { $PythonStepRequires = @() }

    Invoke-Step -Name 'python' -Label 'Python' -Requires $PythonStepRequires -Body {
    Print-Title "Python"
    if ($script:PythonMode -ne 'portable') {
        # System or custom Python: verify it actually runs (the Microsoft
        # Store alias stub resolves as 'python' but exits non-zero) and record
        # its version for the environment manifest.
        $pythonWorks = $false
        try {
            & python --version > $null 2>&1
            if ($LASTEXITCODE -eq 0) { $pythonWorks = $true }
        } catch {}
        if (-not $pythonWorks) {
            if ($script:PythonMode -eq 'custom') {
                throw "Custom Python requested (-PythonExePath) but it does not run: $($script:CustomPythonDir)"
            }
            throw "System Python requested (-UseSystemPython) but no working python executable was found on PATH"
        }
        $ResolvedPython = (Get-Command python).Source
        $PythonVersionOutput = "$(& python --version 2>&1 | Select-Object -First 1)"
        if ($PythonVersionOutput -match 'Python (\d+)\.(\d+)') {
            $script:pythonVersion = ($PythonVersionOutput -replace '^Python\s+', '').Trim()
            $pythonMajor = [int]$matches[1]
            $pythonMinor = [int]$matches[2]
            if ($pythonMajor -lt 3 -or ($pythonMajor -eq 3 -and $pythonMinor -lt 12)) {
                Add-StepWarning "Python $($script:pythonVersion) is older than 3.12, the minimum recommended by current Zephyr requirements"
            }
        }
        Write-Output "Using $($script:PythonMode) Python: $ResolvedPython ($PythonVersionOutput)"
        return
    }
    $WinPythonSetupFilename = "Winpython64.exe"

    Download-FileWithHashCheck $python_portable_array[0] $python_portable_array[1] $WinPythonSetupFilename

    $PythonInstallDirectory = "$ToolsDirectory\python"

    # Extract and wait (WinPython is a self-extractor, no 7-Zip needed)
    $PythonProcess = Start-Process -FilePath "$DownloadDirectory\$WinPythonSetupFilename" -ArgumentList "-o`"$ToolsDirectory`" -y" -Wait -PassThru
    if ($PythonProcess.ExitCode -ne 0) {
        throw "WinPython self-extraction failed (exit code $($PythonProcess.ExitCode))"
    }
    $WinPythonFolder = Get-ChildItem -Directory -Filter "WPy64-*" -Path $ToolsDirectory | Select-Object -First 1
    if (-not $WinPythonFolder) {
        throw "WinPython extraction did not produce a WPy64-* folder"
    }
    # Only replace an existing python once the new one is fully extracted, so a
    # failed extraction cannot destroy a working install.
    if (Test-Path -Path $ToolsDirectory\python) {
        Remove-Item -Path $ToolsDirectory\python -Recurse -Force -ErrorAction Stop
    }
    #Rename the folder that starts with WPy64- to python
    Rename-Item -Path $WinPythonFolder.FullName -NewName "python" -ErrorAction Stop
    Copy-Item -Path "$ToolsDirectory\python\python\python.exe" -Destination "$ToolsDirectory\python\python\python3.exe" -ErrorAction Stop
    }

    # Update path (kept outside the steps: the final package check and the venv
    # creation need whatever tools DID install to be reachable)
    $CmakePath = "$ToolsDirectory\cmake\bin"
    $DtcPath = "$ToolsDirectory\dtc\usr\bin"
    $GperfPath = "$ToolsDirectory\gperf\bin"
    $NinjaPath = "$ToolsDirectory\ninja"
    $GitPath = "$ToolsDirectory\git\bin"
    $WgetPath = "$ToolsDirectory\wget"
    $PythonPath = "$ToolsDirectory\python\python;$ToolsDirectory\python\python\Scripts"
    if ($script:PythonMode -ne 'portable') {
        # The system/custom Python was resolved earlier; re-prepending the
        # portable paths would shadow it for the venv step and the final check.
        $PythonPath = ""
    }
    # $SevenZPath already defined previously based on portable or global

    $PathPrefix = "$CmakePath;$DtcPath;$GperfPath;$NinjaPath;"
    if ($PythonPath) { $PathPrefix = "$PathPrefix$PythonPath;" }
    $env:PATH = "$PathPrefix$WgetPath;$GitPath;$SevenZPath;" + $env:PATH


    # Requires the python STEP (not just any python on PATH): a failed portable
    # install with a system Python present would otherwise silently build a
    # venv against the wrong interpreter.
    Invoke-Step -Name 'venv' -Label 'Python virtual environment' -Requires @('python') -Body {
    Print-Title "Python VENV"
    # Failed pip packages make Install-PythonVenv throw at the end (after every
    # package was attempted), so they fail this step instead of hiding as
    # warnings that would let the version stamp mark the install as complete.
    Install-PythonVenv -VenvPath $VenvPath
    }

    # Env files are always generated, even after failures, so the tools that DID
    # install remain usable and the Host Tools Manager can show the real state.
    Invoke-Step -Name 'env-files' -Label 'Environment files' -Body {
# bat script
@"
@echo off

REM Please do not manually edit this script, it is intended to be sourced by other scripts to set up the environment.
REM You can add environment variables and paths to env.yml via the Host Tools Manager interface.

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

if defined PYTHON_VENV_PATH (
    set "VENV_ACTIVATE_PATH=%PYTHON_VENV_PATH%\\Scripts\\activate.bat"
) else (
    set "VENV_ACTIVATE_PATH=%DEFAULT_VENV_ACTIVATE_PATH%"
)

if exist "%VENV_ACTIVATE_PATH%" (
    call "%VENV_ACTIVATE_PATH%"
) else (
    rem no output for missing venv
)

REM === Verify venv activation ===
if not defined VIRTUAL_ENV (
    echo [ERROR] Failed to activate the Python virtual environment.
    echo [INFO] Checked path: %VENV_ACTIVATE_PATH%
    echo [SUGGESTION] You may need to reinstall Host Tools or the global or local virtual environment.
    exit /b 1
)

set "VENV_BIN=%VIRTUAL_ENV%\Scripts"

:: === Run env.py and apply its output ===
for /f "usebackq delims=" %%L in (``python "%PY_FILE%" --shell=cmd``) do (
    if not "%%L"=="" call %%L
)

REM Keep the active venv Python ahead of host-tools Python after env.py updates PATH. Required for Sysbuild
if exist "%VENV_BIN%\python.exe" (
    set "PATH=%VENV_BIN%;%PATH%"
)
"@ | Out-File -FilePath "$InstallDirectory\env.bat" -Encoding ASCII

#bash script
@"
# Please do not manually run this script, it is intended to be sourced by other scripts to set up the environment.
# You can add environment variables and paths to env.yml via the Host Tools Manager interface.
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
if [[ -n "`$PYTHON_VENV_PATH" ]]; then
    venv_activate_path="`$(to_unix_path "`$PYTHON_VENV_PATH")/Scripts/activate"
else
    venv_activate_path="`$default_venv_activate_path"
fi

if [[ -f "`$venv_activate_path" ]]; then
    source "`$venv_activate_path" >/dev/null 2>&1
else
    echo "[ERROR] Virtual environment activation script not found: `$venv_activate_path" >&2
fi

# --- Verify venv activation ---
if [[ -z "`$VIRTUAL_ENV" ]]; then
    echo "[ERROR] Failed to activate the Python virtual environment." >&2
    echo "[INFO] Checked path: `$venv_activate_path" >&2
    echo "[SUGGESTION] You may need to reinstall Host Tools or the global or local virtual environment." >&2
fi

# --- Run env.py to load environment variables and paths ---
if [[ -f "`$PY_FILE" ]]; then
    # We tell env.py to output in POSIX shell mode
    eval "`$(python "`$PY_FILE" --shell=sh)"
else
    echo "[ERROR] Python environment loader not found: `$PY_FILE" >&2
fi

# Keep the active venv Python ahead of host-tools Python after env.py updates PATH. Required for Sysbuild
if [[ -n "`$PYTHON_VENV_PATH" ]]; then
    venv_bin_path="`$(to_unix_path "`$PYTHON_VENV_PATH")/Scripts"
else
    venv_bin_path="`$global_venv_path/Scripts"
fi
if [[ -d "`$venv_bin_path" ]]; then
    export PATH="`$venv_bin_path`${PATH:+:`$PATH}"
fi

"@ | Out-File -FilePath "$InstallDirectory\env.sh" -Encoding ASCII

# (optional) make it executable for WSL, Git-Bash, etc.
try { & chmod +x "$InstallDirectory\env.sh" } catch { }
# Powershell script  
@"
# Please do not manually edit this script, it is intended to be sourced by other scripts to set up the environment.
# You can add environment variables and paths to env.yml via the Host Tools Manager interface.

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

if (`$env:PYTHON_VENV_PATH -and `$env:PYTHON_VENV_PATH.Trim() -ne "") {
    `$VenvActivatePath = Join-Path `$env:PYTHON_VENV_PATH "Scripts\Activate.ps1"
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

# === Verify venv activation ===
if (-not `$env:VIRTUAL_ENV) {
    Write-Host "[ERROR] Failed to activate the Python virtual environment." -ForegroundColor Red
    Write-Host "[INFO] Checked path: `$VenvActivatePath" -ForegroundColor Yellow
    Write-Host "[SUGGESTION] You may need to reinstall Host Tools or the global or local virtual environment." -ForegroundColor Cyan
    exit 1
}

python `$EnvPyPath --shell=powershell | Out-String | Invoke-Expression

# Keep the active venv Python ahead of host-tools Python after env.py updates PATH. Required for Sysbuild
`$VenvBinPath = Join-Path `$env:VIRTUAL_ENV "Scripts"
if (Test-Path (Join-Path `$VenvBinPath "python.exe")) {
    `$env:PATH = "`$VenvBinPath;`$env:PATH"
}
"@ | Out-File -FilePath "$InstallDirectory\env.ps1" -Encoding ASCII

    Write-Output "using cmd: $InstallDirectory\env.bat"
    Write-Output "using powershell: $InstallDirectory\env.ps1"

# --------------------------------------------------------------------------
# Create environment manifest (env.yml)
# --------------------------------------------------------------------------

$EnvYamlPath = "$InstallDirectory\env.yml"
$InstallDirectorySlashFormat = $InstallDirectory -replace '\\', '/'
$ToolsDirectorySlashFormat = $ToolsDirectory -replace '\\', '/'
$SevenZPathSlashFormat = $SevenZPath -replace '\\', '/'

# ---------------------------------------------------------------------------
# env.yml is REGENERATED AS A MERGE on every successful run, selective or not:
# skipping a tool never leaves the manifest incomplete or stale.
#  - Tool entries touched by this run (installed tools, the chosen python, the
#    base tools when they ran) are rebuilt with paths and versions from
#    tools.yml (python: detected version in system/custom mode).
#  - Tool entries NOT touched by this run are carried over verbatim from the
#    previous file (user path/source overrides survive), template when absent.
#  - User data always survives: extra env: keys, runners: and other: sections.
# A failed run keeps an existing file untouched, as before.
# ---------------------------------------------------------------------------

$OldEnvYamlLines = @()
if (Test-Path -Path $EnvYamlPath) {
    $OldEnvYamlLines = @(Get-Content -Path $EnvYamlPath)
}

function Get-YamlSectionLines {
    # Verbatim lines of the section starting at '<indent><key>:' up to the
    # next line at the same or lower indentation (blank lines excluded from
    # the tail).
    param([string[]]$Lines, [string]$Key, [int]$Indent)
    $prefix = ' ' * $Indent
    $collected = @()
    $inSection = $false
    foreach ($line in $Lines) {
        if (-not $inSection) {
            if ($line -match "^$prefix$([regex]::Escape($Key))\s*:\s*$") {
                $inSection = $true
                $collected += $line
            }
            continue
        }
        if ($line -match '^\s*$') { $collected += $line; continue }
        $lineIndent = $line.Length - $line.TrimStart(' ').Length
        if ($lineIndent -le $Indent) { break }
        $collected += $line
    }
    while ($collected.Count -gt 0 -and $collected[-1] -match '^\s*$') {
        $collected = @($collected[0..($collected.Count - 2)])
    }
    return ,$collected
}

function New-EnvToolTemplateLines {
    param([string]$Id, [string[]]$PathLines, [string]$Version, [string]$DoNotUse)
    $block = @("  ${Id}:") + $PathLines
    if ($Version) { $block += "    version: $Version" }
    $block += "    do_not_use: $DoNotUse"
    return ,$block
}

function Get-EnvToolLines {
    # Template block when the tool was touched by this run (or no previous
    # file exists); otherwise the previous block carried over verbatim.
    param([string]$Id, [bool]$Regenerate, [string[]]$TemplateLines)
    if (-not $Regenerate -and $OldEnvYamlLines.Count -gt 0) {
        $oldBlock = Get-YamlSectionLines -Lines $OldEnvYamlLines -Key $Id -Indent 2
        if ($oldBlock.Count -gt 0) { return ,$oldBlock }
    }
    return ,$TemplateLines
}

# Python entry per source mode. 'do_not_use: true' is the Host Tools Manager's
# existing "System" source semantics: env.py then adds no python path and the
# panel shows Source=System. A custom python gets its real paths written so
# sourced shells resolve it.
$PythonPathLines = @(
    '    path:',
    "      - `"$ToolsDirectorySlashFormat/python/python`"",
    "      - `"$ToolsDirectorySlashFormat/python/python/Scripts`""
)
$PythonDoNotUse = "false"
if ($script:PythonMode -eq 'system') {
    $PythonDoNotUse = "true"
} elseif ($script:PythonMode -eq 'custom') {
    $CustomPythonDirSlashFormat = $script:CustomPythonDir -replace '\\', '/'
    $PythonPathLines = @(
        '    path:',
        "      - `"$CustomPythonDirSlashFormat`"",
        "      - `"$CustomPythonDirSlashFormat/Scripts`""
    )
}

$fullRun = ($script:SelectedSteps.Count -eq 0)
$envLines = @(
    '# env.yml',
    '# ZInstaller Workspace Environment Manifest',
    '# Defines workspace tools, runners, and Zephyr compatibility metadata',
    '',
    'global:',
    '  version: 1.0',
    '  description: "Host tools configuration for Zephyr Workbench"',
    '',
    '# Any variable here will be added as environment variables',
    'env:',
    "  zi_base_dir: `"$InstallDirectorySlashFormat`"",
    "  zi_tools_dir: `"$InstallDirectorySlashFormat/tools`""
)
if ($OldEnvYamlLines.Count -gt 0) {
    # Carry user-defined environment variables.
    $oldEnvSection = Get-YamlSectionLines -Lines $OldEnvYamlLines -Key 'env' -Indent 0
    foreach ($oldEnvLine in $oldEnvSection) {
        if ($oldEnvLine -match '^env\s*:') { continue }
        if ($oldEnvLine -match '^\s*(zi_base_dir|zi_tools_dir)\s*:') { continue }
        if ($oldEnvLine -match '^\s*$') { continue }
        $envLines += $oldEnvLine
    }
}
$envLines += ''
$envLines += 'tools:'

$envLines += Get-EnvToolLines 'python' ($fullRun -or ($script:SelectedSteps -contains 'python')) `
    (New-EnvToolTemplateLines 'python' $PythonPathLines $script:pythonVersion $PythonDoNotUse)
$envLines += ''
$envLines += Get-EnvToolLines 'cmake' ($fullRun -or ($script:SelectedSteps -contains 'cmake')) `
    (New-EnvToolTemplateLines 'cmake' @('    path: "${zi_tools_dir}/cmake/bin"') (Get-YamlWindowsField 'cmake' 'version') 'false')
$envLines += ''
$envLines += Get-EnvToolLines 'dtc' ($fullRun -or ($script:SelectedSteps -contains 'dtc')) `
    (New-EnvToolTemplateLines 'dtc' @('    path: "${zi_tools_dir}/dtc/usr/bin"') (Get-YamlWindowsField 'dtc' 'version') 'false')
$envLines += ''
$envLines += Get-EnvToolLines 'gperf' ($fullRun -or ($script:SelectedSteps -contains 'gperf')) `
    (New-EnvToolTemplateLines 'gperf' @('    path: "${zi_tools_dir}/gperf/bin"') (Get-YamlWindowsField 'gperf' 'version') 'false')
$envLines += ''
$envLines += Get-EnvToolLines 'ninja' ($fullRun -or ($script:SelectedSteps -contains 'ninja')) `
    (New-EnvToolTemplateLines 'ninja' @('    path: "${zi_tools_dir}/ninja"') (Get-YamlWindowsField 'ninja' 'version') 'false')
$envLines += ''
$envLines += Get-EnvToolLines 'git' ($fullRun -or ($script:SelectedSteps -contains 'git')) `
    (New-EnvToolTemplateLines 'git' @('    path: "${zi_tools_dir}/git/bin"') (Get-YamlWindowsField 'git' 'version') 'false')
$envLines += ''
$envLines += Get-EnvToolLines '7z' ($fullRun -or $script:InfraNeeded) `
    (New-EnvToolTemplateLines '7z' @("    path: `"$SevenZPathSlashFormat`"") (Get-YamlWindowsField 'seven_z' 'version') 'false')
$envLines += ''
$envLines += Get-EnvToolLines 'wget' ($fullRun -or ($script:SelectedSteps -contains 'wget')) `
    (New-EnvToolTemplateLines 'wget' @('    path: "${zi_tools_dir}/wget"') $script:wgetVersion 'false')
$envLines += ''
$envLines += 'python:'
$envLines += "  global_venv_path: `"$InstallDirectorySlashFormat/.venv`""
$envLines += ''

# Carry the user-owned top-level sections (runner paths, extra tool paths).
foreach ($userSection in @('runners', 'other')) {
    if ($OldEnvYamlLines.Count -gt 0) {
        $oldUserBlock = Get-YamlSectionLines -Lines $OldEnvYamlLines -Key $userSection -Indent 0
        if ($oldUserBlock.Count -gt 0) {
            $envLines += $oldUserBlock
            $envLines += ''
        }
    }
}

	# A failed run keeps an existing manifest untouched; everything else gets
	# the merged regeneration above (selective runs included, so a new python
	# source or freshly installed tool always lands in env.yml).
	$priorFailedSteps = @($script:StepResults | Where-Object { $_.status -eq 'failed' }).Count
	if ((-not (Test-Path -Path $EnvYamlPath)) -or ($priorFailedSteps -eq 0)) {
		($envLines -join "`r`n") + "`r`n" | Out-File -FilePath $EnvYamlPath -Encoding UTF8

		Write-Output "Created environment manifest: $EnvYamlPath"
	} else {
		Print-Warning "Keeping existing environment manifest (some steps failed): $EnvYamlPath"
	}

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
            matches = sorted(glob.glob(expanded_value), reverse=True)
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
    }

    $script:FailedSteps = @($script:StepResults | Where-Object { $_.status -eq 'failed' })
    $script:SkippedSteps = @($script:StepResults | Where-Object { $_.status -eq 'skipped' })
    $script:WarningSteps = @($script:StepResults | Where-Object { $_.status -eq 'warning' })

    Print-Title "Clean up"
    Remove-Item -Path $TemporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue

    # NOTE: summary lines are printed only in install mode (never with -OnlyCheck)
    # and deliberately use a "[TAG] name" shape that cannot match the
    # "name [version]" lines the Host Tools Manager parses from -OnlyCheck output.
    Print-Title "Installation Summary"
    foreach ($step in $script:StepResults) {
        $tag = '[ OK ]'
        if ($step.status -eq 'warning') { $tag = '[WARN]' }
        elseif ($step.status -eq 'skipped') { $tag = '[SKIP]' }
        elseif ($step.status -eq 'not-selected') { $tag = '[SKIP]' }
        elseif ($step.status -eq 'failed') { $tag = '[FAIL]' }
        $line = "$tag $($step.label)"
        if ($step.status -eq 'failed' -and $step.error) { $line = "$line : $($step.error)" }
        if (($step.status -eq 'skipped' -or $step.status -eq 'not-selected') -and $step.reason) { $line = "$line : $($step.reason)" }
        Write-Output $line
        foreach ($stepWarning in @($step.warnings)) {
            Write-Output "         - $stepWarning"
        }
    }
    Write-Output "$($script:FailedSteps.Count) step(s) failed, $($script:SkippedSteps.Count) skipped, $($script:WarningSteps.Count) with warnings."
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

$returnCode = Check-Packages

if ($OnlyCheck) {
    # -OnlyCheck keeps its historical contract: 0 or -(missing count).
    exit $returnCode
}

# Install mode: the exit code reflects step results, not the package check.
# (A system-wide tool on PATH can mask a broken zinstaller copy and vice versa.)
# Callers get a boolean signal: 0 = everything requested succeeded, 1 = at
# least one step failed or an explicitly selected step ended up skipped.
$installFailedCount = 0
$selectedSkippedCount = 0
if ($script:StepResults) {
    $installFailedCount = @($script:StepResults | Where-Object { $_.status -eq 'failed' }).Count
    $selectedSkippedCount = @($script:StepResults | Where-Object { $_.status -eq 'skipped' -and $script:SelectedSteps -contains $_.name }).Count
}

# Version stamp: marks "the install is complete". Complete means the
# ESSENTIALS the extension depends on are available: the environment files
# (always regenerated by the env-files step) and a usable global venv.
# Skipped tools never block completeness (that is the point of skipping;
# the user provides them or the Advanced panel installs them later), but
# failed steps and selected-but-skipped steps do.
$venvUsable = Test-Path -Path (Join-Path $VenvPath "Scripts\Activate.ps1")
if ($script:StepResults -and $installFailedCount -eq 0 -and $selectedSkippedCount -eq 0 -and $venvUsable) {
@"
Script Version: $ZinstallerVersion
Script MD5: $ZinstallerMd5
tools.yml MD5: $ToolsYmlMd5
"@ | Out-File -FilePath "$InstallDirectory\zinstaller_version" -Encoding ASCII
} elseif ($script:StepResults) {
    Print-Warning "Version stamp not written (failed or skipped steps, or the global venv is not available); the install keeps being reported as needing reinstallation."
}

if ($installFailedCount -gt 0 -or $selectedSkippedCount -gt 0) {
    exit 1
}
exit 0
