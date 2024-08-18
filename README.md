# Zephyr Workbench for VS Code (Beta)

Ac6 Zephyr Workbench for VS Code extension adds support of Zephyr development to Visual Studio Code, including SDK management, Project wizard, build and debugging features. 

## Features
* Install native Host Tools (python, cmake, ...)
* Install and auto-detect default Zephyr SDK
* Import West workspaces from remote repository using west or from local folder 
* Parse west workspace data from config file
* Create application projects for specific board from sample
* Configure application KConfig
* Build/Flash application

## Requirements
To build your project on Zephyr Workbench, No external tools is required. Host tools are installed by the extension itself.
To flash and to debug the application on your target, external tools are required. Depending on needs, your might have to install some of the following software tools on your workstation
  
## Usage
Zephyr Workbench provides a dedicated panel, to access it, click on the "Zephyr Workbench" logo on the left 

### Install Host tools
1. Click on "Install Host Tools" to download and to install the native tools in ${USERDIR}/.zinstaller (takes ~5mins)

### Initialize West Workbench
1. Click on "Initialize workspace" button
2. Open the newly opened page, enter information about your west workspace instance.
   1. For example:
        Source location: Repository
        Path: https://github.com/zephyrproject-rtos/zephyr
        Branch: v3.6.0
        Location: choose where to import the west workspace
      (takes ~10mins to init then update the workspace)
3. Click on "Import"

### Import Zephyr SDK
1. Click on "Import SDK" button
2. Open the newly opened page, enter information about your Zephyr SDK.
   1. For example:
        Source location: Remote archive
        Path: https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.16.8/zephyr-sdk-0.16.8_linux-x86_64.tar.xz
        Location: choose where to import the Zephyr SDK
3. Click on "Import"

### Create a new Application project
1. Click on "Create Zephyr application"
2. Select to west workspace to attach to
3. Select the Zephyr SDK to use
4. Select the target board (eg. nucleo_wba55cg)
5. Select the sample project as based (eg. Blinky)
6. Enter the project location
7. Enter the project name

### Build your project
1. Click on the "Build" button in the status bar below.
   Alternatively, Use command key Ctrl+B then select the folder to build.
2. On the first build, choose the build mode (auto, pristine, none)

### Flash your application
(Warning) The flash tool for your board must be installed on your system.

### Debug your application
(Warning) The debug server tool for your board must be installed on your system.
1. Go to the "Run and Debug" (Ctrl+Shift+D) activity panel
2. Select the launch configuration for your project
3. Click on Run button

### Install Debug tools
Only OpenOCD and STM32CubeProgrammer are currently support
1. Click on the "Install Debug tools" menu
2. The list of supported is displayed here
3. Click on the "Install" icon to install the tools 
   <or>
   Click on the "Website" icon to be redirected to the official website of the tool and manually install it
Note: As third-party installer cannot be fully controlled, you might need to manually set up your PATH environment variable to use the tool in Zephyr Workbench

## Known Issues

Error message in "Output" tab with new application project is created.
Uninstall tools not supported
