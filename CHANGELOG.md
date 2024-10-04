# Change Log

All notable changes to the "zephyr-workbench" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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