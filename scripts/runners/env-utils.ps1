# ===================================================================
# env-utils.ps1
# Utility functions for updating Zephyr Workbench environment files:
#   - env.yml  (YAML manifest of tool metadata)
#   - env.ps1  (PowerShell environment setup script)
#   - env.cmd  (Windows batch environment setup script)
#   - env.sh   (Unix/Bash environment setup script)
#
# Each function inserts or updates tool configuration blocks
# (for example, adding a "J-Link" tool) so the various shells
# can correctly find executables by updating PATH consistently.
# ===================================================================


<#
.SYNOPSIS
    Updates a specific tool entry inside env.yml using yq.

.DESCRIPTION
    Uses yq.exe to modify the YAML manifest and insert/update
    a tool entry under the `.runners.<ToolName>` node. This ensures
    the tool’s `path`, `version`, and `do_not_use` flags are current.

.PARAMETER ToolName
    Name of the tool to update (e.g. "jlink").

.PARAMETER YqPath
    Full path to yq.exe (YAML processor).

.PARAMETER EnvYamlPath
    Path to env.yml to be modified.

.PARAMETER ToolPath
    Installation path of the tool (forward slashes preferred).

.PARAMETER Version
    Version string of the tool.

.EXAMPLE
    Update-EnvYamlBlock -ToolName "jlink" -YqPath "C:\bin\yq.exe" `
                        -EnvYamlPath "C:\zinstaller\env.yml" `
                        -ToolPath "C:/Program Files/SEGGER/JLink_V878" `
                        -Version "7.78a"
#>

function Update-EnvYamlBlock {
    param (
        [Parameter(Mandatory = $true)][string]$ToolName,       # e.g. "jlink"
        [Parameter(Mandatory = $true)][string]$YqPath,         # path to yq.exe
        [Parameter(Mandatory = $true)][string]$EnvYamlPath,    # path to env.yml
        [Parameter(Mandatory = $true)][string]$ToolPath,       # tool installation path (forward slashes)
        [Parameter(Mandatory = $true)][string]$Version         # tool version
    )

    if (-not (Test-Path $EnvYamlPath)) {
        Write-Output "ERROR: env.yml not found at $EnvYamlPath"
        exit 1
    }

    Write-Output "Updating env.yml for $ToolName using yq..."
    $ToolPath="$ToolPath"
    $Version="$Version"
    & $YqPath eval ".runners.$ToolName |= {}" -i $EnvYamlPath
    & $YqPath eval ".runners.$ToolName.path = `"`"`"$ToolPath`"`"`"" -i $EnvYamlPath
    & $YqPath eval ".runners.$ToolName.version = `"`"`"$Version`"`"`"" -i $EnvYamlPath
#    & $YqPath eval ".runners.$ToolName.z_min_version = `"`"`"`"`"`"" -i $EnvYamlPath
#    & $YqPath eval ".runners.$ToolName.z_max_version = `"`"`"`"`"`"" -i $EnvYamlPath
    & $YqPath eval ".runners.$ToolName.do_not_use = false" -i $EnvYamlPath
#    & $YqPath eval ".runners.$ToolName.args = []" -i $EnvYamlPath

    if ($LastExitCode -eq 0) {
        Write-Output "Updated env.yml successfully for ${ToolName}:"
        Write-Output "  path: $ToolPath"
        Write-Output "  version: $Version"
    } else {
        Write-Output "Failed to update env.yml for ${ToolName} using yq."
        exit $LastExitCode
    }
}

<#
.SYNOPSIS
    Updates (or inserts) a PowerShell PATH block for a given tool.

.DESCRIPTION
    Inserts a BEGIN/END–delimited section into `env.ps1` that defines
    a `$<ToolName>_path` variable and prepends it to `$env:PATH`.
    Existing blocks for the same tool are safely replaced.

    Example of the generated block:

        # BEGIN jlink to PATH
        $jlink_path = "C:\Program Files\SEGGER\JLink_V878"
        $env:PATH = "$jlink_path;" + $env:PATH
        # END jlink to PATH

    The markers allow safe re-insertion or replacement for the same tool
    if the function is called again later.

.PARAMETER ToolName
    Name of the tool (used for labeling markers).

.PARAMETER EnvPs1Path
    Path to the PowerShell environment script (env.ps1).

.PARAMETER ToolPath
    Absolute directory path to the tool to add to PATH.

.EXAMPLE
    Update-EnvPs1PathBlock -ToolName "jlink" `
                           -EnvPs1Path "C:\zinstaller\env.ps1" `
                           -ToolPath "C:\Program Files\SEGGER\JLink_V878"
#>

function Update-EnvPs1PathBlock {
    param (
        [Parameter(Mandatory = $true)][string]$ToolName,
        [Parameter(Mandatory = $true)][string]$EnvPs1Path,
        [Parameter(Mandatory = $true)][string]$ToolPath
    )

    if (-not $EnvPs1Path -or $EnvPs1Path.Trim() -eq "") {
        Write-Output "ERROR: EnvPs1Path is empty or undefined."
        return
    }

    if (-not (Test-Path $EnvPs1Path)) {
        Write-Output "WARNING: env.ps1 not found at $EnvPs1Path. Skipping PATH append."
        return
    }

    $BeginMarker = "# BEGIN $ToolName to PATH"
    $EndMarker   = "# END $ToolName to PATH"
    $VarName = "`$$ToolName" + "_path"

    $Block = @"
$BeginMarker
$VarName = "$ToolPath"
`$env:PATH = "$VarName;" + `$env:PATH
$EndMarker
"@

    $ExistingContent = Get-Content -Path $EnvPs1Path -Raw
    $Pattern = "(?s)$([regex]::Escape($BeginMarker)).*?$([regex]::Escape($EndMarker))\s*"
    $CleanContent = [regex]::Replace($ExistingContent, $Pattern, '')

    Set-Content -Path $EnvPs1Path -Value $CleanContent.TrimEnd()
    Add-Content -Path $EnvPs1Path -Value "`r`n$Block`r`n"

    Write-Output "Updated env.ps1 with $ToolName path:"
    Write-Output "  $ToolPath"
}

<#
.SYNOPSIS
    Updates or creates a Windows batch (env.cmd) PATH block.

.DESCRIPTION
    Adds or replaces a comment–delimited section in `env.cmd`
    that defines a `%<ToolName>_path%` variable and prepends it
    to the system `%PATH%`.

    Example of the generated block:

        REM BEGIN jlink to PATH
        set "jlink_path=C:\Program Files\SEGGER\JLink_V878"
        set "PATH=%jlink_path%;%PATH%"
        REM END jlink to PATH

    The function safely removes any existing section for the same tool
    before appending a new one.

.PARAMETER ToolName
    Name of the tool (used for marker labels).

.PARAMETER EnvCmdPath
    Path to the Windows batch environment file (env.cmd).

.PARAMETER ToolPath
    Absolute directory path to the tool to add to PATH.

.EXAMPLE
    Update-EnvCmdPathBlock -ToolName "jlink" `
                           -EnvCmdPath "C:\zinstaller\env.cmd" `
                           -ToolPath "C:\Program Files\SEGGER\JLink_V878"
#>
function Update-EnvCmdPathBlock {
    param (
        [Parameter(Mandatory = $true)][string]$ToolName,     # e.g. "jlink"
        [Parameter(Mandatory = $true)][string]$EnvCmdPath,   # path to env.cmd
        [Parameter(Mandatory = $true)][string]$ToolPath      # e.g. "C:\Program Files\SEGGER\JLink_V878"
    )

    if (-not $EnvCmdPath -or $EnvCmdPath.Trim() -eq "") {
        Write-Output "ERROR: EnvCmdPath is empty or undefined."
        return
    }

    # Ensure file exists
    if (-not (Test-Path $EnvCmdPath)) {
        Write-Output "Creating new env.cmd at $EnvCmdPath"
        New-Item -ItemType File -Path $EnvCmdPath -Force | Out-Null
    }

    $BeginMarker = "REM BEGIN $ToolName to PATH"
    $EndMarker   = "REM END $ToolName to PATH"
    $VarName = "${ToolName}_path"

    # Build the replacement block
    $Block = @"
$BeginMarker
set "$VarName=$ToolPath"
set "PATH=%$VarName%;%PATH%"
$EndMarker
"@

    # --- Read file content safely ---
    $ExistingContent = ""
    if (Test-Path $EnvCmdPath) {
        $ExistingContent = Get-Content -Path $EnvCmdPath -Raw -ErrorAction SilentlyContinue
        if (-not $ExistingContent) { $ExistingContent = "" }
    }

    # --- Remove any previous block ---
    $Pattern = "(?s)$([regex]::Escape($BeginMarker)).*?$([regex]::Escape($EndMarker))\s*"
    $CleanContent = [regex]::Replace($ExistingContent, $Pattern, '').TrimEnd()

    # --- Append new block ---
    $NewContent = if ($CleanContent -ne '') {
        "$CleanContent`r`n$Block`r`n"
    } else {
        "$Block`r`n"
    }

    # --- Write updated file ---
    Set-Content -Path $EnvCmdPath -Value $NewContent -Encoding UTF8

    Write-Output "Updated env.cmd with $ToolName path:"
    Write-Output "  $ToolPath"
}

function Update-EnvShPathBlock {
    param (
        [Parameter(Mandatory = $true)][string]$ToolName,    # e.g. "jlink"
        [Parameter(Mandatory = $true)][string]$EnvShPath,   # path to env.sh
        [Parameter(Mandatory = $true)][string]$ToolPath     # e.g. "/opt/SEGGER/JLink_V878"
    )

    if (-not $EnvShPath -or $EnvShPath.Trim() -eq "") {
        Write-Output "ERROR: EnvShPath is empty or undefined."
        return
    }

    # Ensure file exists
    if (-not (Test-Path $EnvShPath)) {
        Write-Output "Creating new env.sh at $EnvShPath"
        New-Item -ItemType File -Path $EnvShPath -Force | Out-Null
    }

    $BeginMarker = "# BEGIN $ToolName to PATH"
    $EndMarker   = "# END $ToolName to PATH"
    $VarName = "${ToolName}_path"

    # Build the replacement block
    $Block = @"
$BeginMarker
$VarName="`$(to_unix_path "$ToolPath")"
export PATH="`$${VarName}:`$PATH"
$EndMarker
"@

    # --- Read existing file safely ---
    $ExistingContent = ""
    if (Test-Path $EnvShPath) {
        $ExistingContent = Get-Content -Path $EnvShPath -Raw -ErrorAction SilentlyContinue
        if (-not $ExistingContent) { $ExistingContent = "" }
    }

    # --- Remove any existing block for this tool ---
    $Pattern = "(?s)$([regex]::Escape($BeginMarker)).*?$([regex]::Escape($EndMarker))\s*"
    $CleanContent = [regex]::Replace($ExistingContent, $Pattern, '').TrimEnd()

    # --- Append the new block ---
    $NewContent = if ($CleanContent -ne '') {
        "$CleanContent`n$Block`n"
    } else {
        "$Block`n"
    }

    # --- Write updated content back ---
    Set-Content -Path $EnvShPath -Value $NewContent -Encoding UTF8

    Write-Output "Updated env.sh with $ToolName path:"
    Write-Output "  $ToolPath"
}
