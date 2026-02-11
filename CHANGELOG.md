# Change Log

All notable changes to the "zephyr-workbench" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [2.3.0]

### UI
- Improved text details in action buttons
  - Changed Run to Flash in the inline button
  - Changed Run to Flash/Run in the context menu

### Static Code Analysis
- Fixed DT Doctor
- Fixed and improved ECLAIR Manager

### Commands
- Run commands in the background without creating entries in tasks.json for
  - DT Doctor
  - ROM Report
  - RAM Report
  - GUI Config
  - Menu Config
  - Harden Config

### Snippets
- Added support for snippets

## [2.2.1]
- Remove support for PowerShell 7

## [2.2.0]

### Debug Manager
- Added support for the ST-LINK GDB server debug runner

### Static Code Analysis
- Added support for ECLAIR
- Added support for Devicetree diagnostics (dtdoctor) 

### Tests
- Added unit tests 

### Build 
- Fixed build failure when using `--sysbuild` together with `CONF_FILE` and/or `EXTRA_CONF_FILE`

### Others
- Minor fixes in the West Workspace and Debug Manager
- Full support for PowerShell 7


## [2.1.0]

- Fix Debug Manager default reset and avoid scanning until the view is opened
- Pre-fill “Select the application to debug” when launching Debug from an application
- Add remove actions in Multi-build for build configs and default runner
- Disable “Sample project” selection while samples are loading
- Refresh Host Tools versions after project creation (no VS Code reload needed)
- Refresh runner “path” from YAML immediately after install
- Warn when initializing into a path that already have a west workspace
- Ensure west manifest revision/version updates correctly after `west update`
- Add Minimal/Full option when creating west workspace from template

## [2.0.4]

- Fetch toolchains per version remotely with inline spinner feedback

## [2.0.3]

- Update documentation to standardize the new extension name Workbench for Zephyr
- Adjust website and documentation titles for consistency across pages

## [2.0.0]

### DTS
- Support DTS LSP (Kyle Bonnici) out of the box

### Host Tools
- Add Host Tools panel to check, manage, and add custom host tools
- Update host tools packages and platform support; clarify Python/venv guidance
- Provide cross-OS environment management via `env.yml` (Windows/macOS/Linux) with global/local env
- Install portable Python on Linux when system Python is below minimum

### Runners
- Rename "Install Debug Tools" to "Install Runners" with a dedicated management panel
- Improve Install Runners panel UX and performance; auto-detect runners from common paths
- Support Nordic runners: nrfjprog and nrfutil
- Support Silicon Labs Simplicity Commander
- Simplify adding custom runners and tools via Extra Runners

### Debug
- Improve Debug Manager performance, UX and error reporting

### UI & Performance
- Add spinners across panels and auto-detected fields to indicate long operations
- Improve panel content parsing for faster load times

### Misc
- Reorganize sources into subfolders
- Improve error reporting and stability
- Update Zephyr OpenOCD and cross-platform build scripts; bump zinstaller to v2.0
- Refine PowerShell policy, try to avoid powershell resctrictions on windows

## [1.3.37]

- Fix west_wrapper generation
- Fix missing runners

## [1.3.36]

- Fix duplicate "/zephyr" suffix in minimal template URL 

## [1.3.35]

- Update revision field (former tag field) to list both branches and tags
- Load revisions only when clicking the refresh button

## [1.3.34]

- Make packaging script cross-platform (use cross-env for NODE_ENV) to enable building .vsix on Windows

## [1.3.33]

- Fix Recognize PowerShell 7 (pwsh) and run commands correctly

## [1.3.32]

- Fix IAR ARM toolchain not being detected when using different terminal

## [1.3.31]

- Fix SPDX install not using the correct python
- Fix shield names not displaying correctly
- Fix SDK import by automatically creating the destination folder if it does not exist

## [1.3.30]

- Fix project creation and workspace import on MacOS
- Fix board detection using EXTRA_ZEPHYR_MODULES
- Improve debug using custom terminal

## [1.3.29]

- Fix build when no arguments or shields are provided when using custom terminal

## [1.3.28]

- Fix for workspace import using bash on windows
- Fix for west update, west boards etc using Cygwin on windows
- Add cmsis_6 to west manifest >=4.1.0

## [1.3.27]

- Fix path for files on windows

## [1.3.26]

- Update custom terminals (add spdx, change board, shields, etc.)
- Fix build directory name using custom terminals

## [1.3.25]

- Hotfix for git tags

## [1.3.24]

- Add partial support for custom terminals (Git Bash, CygWin, zsh, etc.) — applies to "Open Terminal" and "Build"
- Support for other features with custom terminals is still in progress
- Update host tools install script to prevent issues with puncover
- Fix for importing projects using "Import Zephyr Application"
- Fix west using powershell

## [1.3.23]

- Update host tools to support newer Zephyr versions

## [1.3.22]

- Add import option in "Create new application" tab
- Refractor IAR toolchain import messages

## [1.3.21]

- Optimize setting to prevent conflicts with CMake Tools
- Optimize Sysbuild run process
- Add new open terminal button from explorer
- Display PyOCD messages

## [1.3.20]

- Add "install python dependencies" button for west workspaces
- Add new setting to prevent conflicts with CMake Tools

## [1.3.19]

- Add support for IAR toolchain

## [1.3.18]

- Optimize debug using OpenOCD

## [1.3.17]

- Add sysbuild support
- Add build/debug/rebuild buttons directly from explorer
- Fix stm32h7x debug using OpenOCD

## [1.3.16]

- Fix for module-based custom board discovery
- Add support for module-based custom board discovery on multi-build

## [1.3.15]

- Refactor shield discovery to use native West command
- Fix shield edit button

## [1.3.14]

- Hotfix on Host tools installation

## [1.3.13]

- Added shield support

## [1.3.12]

- End legacy compatibility
- Fix argument / env vars definition

## [1.3.11]

- Fix debug tools download
- Fix debug server port attribute in gdb command
- Add driver install for USB to UART Bridge on ESP32 boards

## [1.3.10]

- Fix variable with empty space

## [1.3.9]

- Fix west command to search for boards folders

## [1.3.8]

- Fix debug shortcut
- Optimize debug tools installation
- Add "Read Docs" links
- Update style.css
- Update default settings.json to avoid CMake automatic scan

## [1.3.7]

- Set pristine default to auto for imported project
- Change file/directory dialog label

## [1.3.6]

- Set default GDB mode to program

## [1.3.5]

- Remove west additional argument for non-build commands

## [1.3.4]

- Open Debug Manager and remove notification when no existing launch configuration is found
- Fix project import quickpick flow and add error message
- Support GDB attach only

## [1.3.3]

- Fix project import quickpick

## [1.3.2]

- Fix access to debug manager
- Change OpenOCD version to Zephyr's
- Add SPDX support + Analysis tools

## [1.3.1]

- Restrict only one active configuration
- Update zephyr-workbench task arguments and config
- Enable run task by palette
- Set default value on debug manager
- Fix change board picker

## [1.3.0]

- Support multi-build configuration
  - Update display
  - Update debug dependency
  - Add converter for legacy projects
- Fix debug tools detection

## [1.2.8]

- Hotfix on Debut tools installation
- Add debug tools packs

## [1.2.7]

- Add "Harden Config" task
- Ask confirmation to reinstall host tools
- Add error message when project destination location does not exist
- Increase default gdb connection timeout
- Add Udev Rules as Debug tools
- Add "Build" and "Debug" into command palette

## [1.2.6]

- Add error messages on Debug Manager
- Fix project creation from sample (avoid copying .vscode and build folders)

## [1.2.5]

- Fix import application quick picks dialog
- Fix "Applications" auto-refresh
- Fix debug step and generated files into `build/.debug/<board_identifier>`
- Add Tutorials website hyperlink
- Change build pristine 'none' to 'never'

## [1.2.4]

- Support West args
- Fix Rebuild pristine command
- Add dynamic tasks.json task creation for backward compatibility

## [1.2.3]

- Fix wrong replace on debug-tools installation on Linux

## [1.2.2]

- Fix CMAKE variable overlap when not value is set

## [1.2.1]

- Fix application import process (issue on missing board identifier)
- Add remove application menu entry

## [1.2.0]

- Support some Zephyr Environment variables (ARCH_ROOT, SOC_ROOT... EXTRA_CONF_FILE, EXTRA_DTC_OVERLAY_FILE, EXTRA_ZEPHYR_MODULES)
- Improve board finder from west by supporting modules and BOARD_ROOT
- Fix MacOSX installation 
- Fix West Workspace tag detection
- Update other resources URLs

## [1.1.2]

- Revert fix on board selection

## [1.1.1]

- Fix MacOSX host tools installation
  - Add Error message when Homebrew is not found
  - Fix tools version detection

## [1.1.0]

- Auto detection of LinkServer

## [1.0.9]

- Support MacOSX in native
- Fix debug tools page stability

## [1.0.8]

- Add detection of debug tools version in the "Install Debug Tools" page
- Fix updating tools status after installation

## [1.0.7]

- Quickfix on SVD file support

## [1.0.6]

- Support PyOCD target auto install
- Fix venv reinstall and local venv usage

## [1.0.5]

- Support xtensa toolchain finder
- Fix puncover download and installation
- Parse more information on board definition

## [1.0.4]

- Fix Toolchain (GCC and GDB) finder (xtensa not supported yet)
- Add memory analysis tools (ram_report, rom_report, puncover)
- Update README.MD and add screenshots
  
## [1.0.3]

- Fix verify tools 
- Fix external/local virtual python environment
- Fix auto-complete project name

## [1.0.2]

- Fix windows version of the launch.json configuration
- Fix wrong "undefined" value for svdPath and Additional flags
- Auto-complete project name when creating application
- Auto-detect debug tool (OpenOCD and LinkServer) binary after installation
- Workaround to shutdown openocd after debug termination

## [1.0.1]

- Quickfix on west update to regenerate .west/config

## [1.0.0]

- Update host tools installation
- Update "Create Zephyr Application" webview
- Move pristine build option

## [0.1.5]

- Support manifest to initialize west workspace
- Add toolchain selection while creating SDK
- Fix build directory delete task
- Fix tasks.json fetch and project detection
- Improve UX with tooltip help

## [0.1.4]

- Add Debug Manager to generate launch.json
  - Support openocd, linkserver, jlink and pyocd runners
  - Autodetect debugger and runner binary in PATH
  - Generate west_wrapper script
- Fix project scanner
- Fix command generation

## [0.1.3]

- Update zinstaller
- Add terminal access from Application folder
- Improve UX messages

## [0.1.2]

- Fix "Build" button on status bar
- Add additional information when creating Application
- Add clean project choices
- Fix zephyr workbench project detection
- Fix initial .west/config setup for local west workspace

## [0.1.1]

- Get remote tags of west workspace
- Enable West Workspace change for Application
- Support user .venv on application level
- Fix on VSCode portable, settings paths

## [0.1.0]

- Enable Board change for Applications
- Improve UI/UX with more error notification
- Add setting to change Python Virtual Environment
- Add delete feature for Application, West Workspace and SDK

## [0.0.9]

- Remove custom Zephyr workbench manifest file
- Fix "Verify Host Tools" command
- Fix sample search directories
- Minor changes on "Other resources" icons and labels

## [0.0.8]

- Fix west configuration parsing
- Support west workspace topology
- Other resources

## [0.0.7]

- Fix STM32CubeProgrammer on Windows

## [0.0.6]

- Support Host tools commands
- Support Debugger binaries and probe drivers installation
- Support Debug with OpenOCD
- Fix SDK detection
- Fix SDK download and extraction on Windows
- Add better support of vscode-webview-toolkit

## [0.0.5]

- Major changes on settings and commands name 
- Support Pristine build option
- Support Clean command
- Support SDK import (remote or local)
- Support commands to configure project KConfig
- Support IntelliSense indexer on application project
- Add Build button
- Add command to reveal project in Explore or OS window
- Default tasks.json and settings.json for created or imported applications
- Fix terminal for Windows
- Shortcut menus added

## [0.0.4]

- Support VSCode Portable
- Allow Linux/Windows host tool installing into Portable folder
- Change extension label and properties to match VSCode practices
- Fix task commands with variables

## [0.0.3]

- Install required extension dependencies
- Support Build Task 
- Fix Windows host tool installation
- Fix SDK detection
- Fix error detection with application configuration is invalid

## [0.0.2]

- Support features on Windows

## [Unreleased]

- Initial release

[2.0.0]: https://github.com/Ac6Embedded/vscode-zephyr-workbench/compare/v1.3.38...version-2

