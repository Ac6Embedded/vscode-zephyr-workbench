# Change Log

All notable changes to the "zephyr-workbench" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [1.3.0]

- Support multi-build configuration
  - Update display
  - Update debug dependency
  - Add converter for legacy projects

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