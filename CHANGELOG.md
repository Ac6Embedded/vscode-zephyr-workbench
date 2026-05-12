# Change Log

All notable changes to the "zephyr-workbench" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [3.0.2]

### [Partial] Breaking changes
- `tasks.json` is no longer used by the extension. Build/debug/run arguments must now be added directly in the extension (per-application Extra Args / build configuration), not in `.vscode/tasks.json`.
- IntelliSense is now driven by the C/C++ extension's `c_cpp_properties.json` instead of `tasks.json`-based configuration.
- **Recommended migration:** delete `.vscode/tasks.json` from existing applications, or re-import the applications to regenerate the project state cleanly.

### Added
- Support for West workspace applications (applications living inside a West workspace are now first-class).

## [2.7.8]

### West Manager (new)
- Added a West Manager view for managing workspace manifests, with a dedicated west icon in the shortcut view, panel tab, and command
- Added a Modules subfolder option and required a `west.yml` subfolder when importing template workspaces
- Allowed a custom `west.yml` subfolder in template workspace import
- Added optional extra projects to west workspace templates and made template projects editable
- Showed west import progress with cancel support
- Added a tooltip next to `Projects:` in Add West Workspace
- Removed `cmsis`, `cmsis-dsp`, and `segger` from default minimal templates
- Standardized west workspace action labels and renamed/moved several west manager labels

### West Workspace Applications (new)
- Added West workspace applications and a West-workspace choice in the Add Application UI
- Added a status-bar picker for the selected west workspace app, and showed Build/Debug for files outside an app folder
- Made the dashboard fall back to the selected west workspace app for files outside an app folder
- West workspace tree: hid chevron on empty env rows, added `SNIPPET_ROOT`, reordered roots, fixed Select Application right-click, and ticked the selected app
- Always elected a selection when at least one west workspace app is declared
- Fixed debug launch generation for West workspace apps

### Applications
- Application tree: added a toolchain row with right-click change, vendor icon, and SDK name
- Application tree: hid expand chevron on empty leaves while keeping `EXTRA` group expandable
- Add Application: explained why an imported folder isn't detected as a Zephyr app and accepted `prj*.conf`
- Renamed the customize template label
- Rejected application paths containing spaces
- Fixed the app creation toolchain guard so it isn't limited to the SDK
- Added an application context-menu command to create custom tasks in `tasks.json`
- Fixed application panel refresh after create/import
- Stored project settings as absolute paths and kept portable paths only for env extras

### Dashboard
- Renamed the Dashboard to Workbench Dashboard and added a West Dashboard
- Added a tabbed Zephyr dashboard layout, a sys-init panel, and RAM/ROM tabs with ELF size breakdown
- Updated the summary layout/content and made some fields clickable
- Changed the panel tab title to Zephyr Dashboard (internal IDs untouched)

### Debug Manager
- Cleared stale debug configs on toolchain changes
- Hardened debug configuration input resolution
- Disambiguated workspace app debug configurations
- Improved runner detection UX for STM32CubeCLT, pyOCD, and hidden-path runners
- Improved runner detection and launch config handling
- Preserved the saved runner and threw a clear error on a missing build config

### Build & Tasks
- Synced `compile_commands` path with sysbuild and refreshed IntelliSense
- Migrated C/C++ setup to `c_cpp_properties.json`
- Centralized Zephyr task execution and unified west build reconfigure logic for commands and tasks
- Detected Zephyr workspaces from settings and built direct tasks dynamically without writing them to `tasks.json`
- Reworked the flash runner task flow and removed managed task marker logic
- Refactored board discovery to use `west boards`, fixed target expansion, and preserved board revisions
- Added a relative settings path option for apps and supported portable VS Code path variables in path settings
- Removed the pristine build mode setting and UI

### Toolchain
- Added ARM GNU toolchain support

### Host Tools
- Added `libftdi` and `hidapi` to the macOS host-tools install

### Misc
- Clarified the global venv action and added a local venv picker for applications
- Sourced env when opening a terminal on an existing project
- SPDX: unified local venv setup and ran SPDX commands directly (removed SPDX entries from `tasks.json`)
- Removed obsolete OpenOCD settings path handling

## [2.7.5]

### Applications
- Improved the Add Application flow with better loading and error handling
- Added clearer errors when the selected west workspace is missing `boards/` or `samples/`
- Added test templates to the application creation picker
- Fixed git revision ordering when listing available revisions for app creation

### Toolchain
- Added support for storing real `ZEPHYR_TOOLCHAIN_VARIANT` values in the project toolchain setting, with automatic migration from the legacy `zephyr_sdk` value
- Added optional LLVM/Clang toolchain download for Zephyr SDK `1.x+` minimal installs
- Added LLVM selection when creating applications and when changing the project toolchain
- Improved the SDK import panel by loading toolchain data asynchronously for faster opening
- Grouped Xtensa minimal toolchains in a collapsed section to make SDK toolchain selection easier to scan

### Debug Manager
- Fixed the browse spinner so it stops correctly when the action is cancelled

### West Workspace
- Added an Analog Devices `hal_adi` west workspace template

## [2.7.0]

### Debug Manager
- Reused a single temporary CMake-only build to collect generated debug data
- Fixed default debug runner selection from temporary `runners.yaml` data
- Cleared `Runner Path` when changing the selected runner
- Added OpenOCD default display and SDK-specific OpenOCD path handling
- Added flash runner to be always shown in apps
- Added west Flags
- Runners: updated modustoolbox

## [2.6.6]

### Install Runners
- Fixed ModusToolbox installation and OpenOCD detection
- Fixed JLink executable name on Linux
- Centralized debug tool version probing and runner detection

## [2.6.5]

### Install Runners
- Added OpenOCD Infineon installation support on Linux and Windows

## [2.6.4]

### Snippets
- Fixed snippets not being passed to the build command on Linux

## [2.6.3]

### Build
- Fixed sysbuild enabled build 
- Fixed multibuild `compile_commands.json` selection for IntelliSense
- Fixed MCUBoot Python interpreter resolution with sysbuild

### Debug Manager
- Improved pyOCD debug runner arguments 

## [2.6.2]

### Debug Manager
- Fixed `ST-LINK GDB Server` detection on Linux
- Avoided creating `launch.json` when no debug runner is selected

### Commands
- Avoided duplicated command entries by running commands directly without relying on `tasks.json`

## [2.6.1]

### Applications
- Fixed project parsing 

## [2.6.0]

### Optimization
- Improved project parsing performance

### Build
- Added basic Dockerfile support for development environment

### Debug Manager
- Added automatic SVD detection for STM32 boards

### Memory Analysis
- Added RAM and ROM plot visualization

### Applications
- Added support for custom arguments (runners)

### Static Code Analysis
- Refactored ECLAIR Manager panel (MVP redesign with presets support)

## [2.5.2]

### Toolchain
- Fixed parsing for Zephyr SDK 1.0.0

## [2.5.1]

### Debug Manager
- Disabled `Runner Path` only for `ST-LINK GDB Server`
- Fixed `STM32CubeCLT` version detection

## [2.5.0]

### Applications
- Removed `CONF_FILE` from build configuration environment variables
- Reorganized `EXTRA_*` variables under a single `EXTRA` parent node in the Applications tree

## [2.4.0]

### Install Runners
- Added support for OpenOCD variants in Install Runners
  - OpenOCD Zephyr
  - OpenOCD ESP32
  - OpenOCD xPack
  - OpenOCD Custom

### Applications
- Added debug preset support and related UI improvements

### Project
- Refactored application context menu organization

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

### Debug Manager
- Fixed default reset behavior and avoided scanning until the view is opened
- Pre-filled "Select the application to debug" when launching Debug from an application

### Multi-build
- Added remove actions for build configurations and default runner

### UI
- Disabled "Sample project" selection while samples are loading

### Host Tools & Runners
- Refreshed Host Tools versions after project creation (no VS Code reload needed)
- Refreshed runner `path` from YAML immediately after install

### West Workspace
- Added warning when initializing into a path that already has a west workspace
- Ensured west manifest revision/version updates correctly after `west update`
- Added Minimal/Full option when creating west workspace from template

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

[2.0.0]: https://github.com/Ac6Embedded/vscode-zephyr-workbench/compare/v1.3.38...version-2
