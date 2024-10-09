# Zephyr Workbench for VS Code

Ac6 Zephyr Workbench for VS Code extension adds support of Zephyr development to Visual Studio Code, including SDK management, Project wizard, build and debugging features. 

<p align="center">
  <img alt="Zephyr Workbench Overview" src="https://raw.githubusercontent.com/Ac6Embedded/vscode-zephyr-workbench/main/images/zw_overview.png" width="80%">
</p>

## Features
* Install native Host Tools (python, cmake, ...)
* Install and auto-detect default Zephyr SDK
* Import West workspaces from remote repository using west or from local folder 
* Parse west workspace data from config file
* Create application projects for specific board from sample
* Configure application KConfig
* Build/Flash application
* Debug application

## Requirements
To build your project on Zephyr Workbench, No external tools is required. Host tools are installed by the extension itself.
To flash and to debug the application on your target, external tools are required. Depending on needs, your might have to install some of the following software tools on your workstation:
* SAM Boot Assistant (SAM-BA)
* LinkServer Debug Host Tools
* J-Link Debug Host Tools
* pyOCD Debug Host Tools
* Lauterbach TRACE32 Debug Host Tools
* NXP S32 Debug Probe Host Tools
  
## Usage
Zephyr Workbench provides a dedicated panel, to access it, click on the "Zephyr Workbench" logo on the left 

### Install Host tools
1. Click on "Install Host Tools" to download and to install the native tools in ${USERDIR}/.zinstaller (takes ~5mins)

<p align="center">
  <img alt="Host tools" src="https://raw.githubusercontent.com/Ac6Embedded/vscode-zephyr-workbench/main/images/zw_1_host_tools.png" width="80%">
</p>

Note: Some tools needs administration right to be installed on your system.


### Initialize West Workspace
1. Click on "Initialize workspace" button
2. Open the newly opened page, enter information about your west workspace instance.
   1. For example:
        Source location: Minimal from template
        Path: https://github.com/zephyrproject-
        Template: STM32
        Branch: v3.7.0
        Location: enter the directory where the west workspace will be imported (the directory name will serve as workspace name)
      (takes ~10mins to init then update the workspace)
3. Click on "Import"
   
<p align="center">
  <img alt="West Workspace" src="https://raw.githubusercontent.com/Ac6Embedded/vscode-zephyr-workbench/main/images/zw_3_west_workspace_new.png" width="80%">
  <img alt="West Workspace" src="https://raw.githubusercontent.com/Ac6Embedded/vscode-zephyr-workbench/main/images/zw_3_west_workspace_import.png" width="80%">
</p>

This process creates then parse the west manifest file to set up your west workspace and the subset of projects. More information about [West Workspaces](https://docs.zephyrproject.org/latest/develop/west/workspaces.html).

### Import Zephyr SDK
1. Click on "Import SDK" button
2. Open the newly opened page, enter information about your Zephyr SDK.
   1. For example:
        Source location: Official SDK
        SDK Type: Minimal
        Version: v0.16.8
        Toolchains: aarch64 arm
        Location: enter the parent location where to import the Zephyr SDK
3. Click on "Import"

<p align="center">
  <img alt="Zephyr SDK" src="https://raw.githubusercontent.com/Ac6Embedded/vscode-zephyr-workbench/main/images/zw_2_sdk_new.png" width="80%">
  <img alt="Zephyr SDK" src="https://raw.githubusercontent.com/Ac6Embedded/vscode-zephyr-workbench/main/images/zw_2_sdk_import.png" width="80%">
</p>

This process imports to toolchains to build and to debug your Zephyr applications. More information about [Zephyr SDK](https://docs.zephyrproject.org/latest/develop/toolchains/zephyr_sdk.html).

### Create a new Application project
The previous steps ("Import West Workspace" and "Import Zephyr SDK") are mandatory before creating an application.

1. Click on "Create New Application"
2. Select the **West Workspace** to attach to
3. Select the **Zephyr SDK** to use
4. Select the target **Board** (eg. ST STM32F4 Discovery)
5. Select the **Sample** project as based (eg. blinky)
6. Enter the project name
7. Enter the project location
8. Select the Pristine Build option (More information on [Pristine Builds](https://docs.zephyrproject.org/latest/develop/west/build-flash-debug.html#pristine-builds))

<p align="center">
  <img alt="New Application" src="https://raw.githubusercontent.com/Ac6Embedded/vscode-zephyr-workbench/main/images/zw_4_app_new.png" width="80%">
  <img alt="New Application" src="https://raw.githubusercontent.com/Ac6Embedded/vscode-zephyr-workbench/main/images/zw_4_app_create.png" width="80%">
</p>

### Build your project
1. Click on the "Build" button in the status bar below.
   Alternatively, Use command key Ctrl+B then select the folder to build.
2. The build output is display in the Terminal

<p align="center">
  <img alt="Configure Debug Session" src="https://raw.githubusercontent.com/Ac6Embedded/vscode-zephyr-workbench/main/images/zw_6_build.png" width="80%">
  <img alt="Configure Debug Session" src="https://raw.githubusercontent.com/Ac6Embedded/vscode-zephyr-workbench/main/images/zw_6_app_build_done.png" width="80%">
</p>

### Configure your debug session
(Warning) The debug server tool for your board must be installed on your system.
1. Click on "Debug Manager" to open a debug configuration form
2. Select the application to debug. Some settings are automatically filled.
3. If needed, enter another Program Path (the generated ELF image)
4. If needed, enter the SVD file for your target
5. If needed, enter another GDB debugger
6. If needed, enter the address of your target
7. If needed, enter the GDB port (useful when running multiple debug session on the same machine)
8. Select the debug server (also called runner)
9. Enter the path to the debug server binary if not auto-detected
10. Additional argument only for advanced user (values can be found in the help of west for each runner)
11. Press "Apply" to save the configuration into the .vscode/launch.json or "Debug" to apply then run the debug session

<p align="center">
  <img alt="Configure Debug Session" src="https://raw.githubusercontent.com/Ac6Embedded/vscode-zephyr-workbench/main/images/zw_7_debug_manager.png" width="80%">
</p>

The newly debug configuration is named "Zephyr Workbench Debug"

If the launch configuration was already created, you don't need to open the **Debug Manager** again. Run your debug session as usually with VSC.
1. Go to the "Run and Debug" (Ctrl+Shift+D) activity panel
2. Select the launch configuration for your project
3. Click on the Run button
4. 
<p align="center">
  <img alt="Launch Debug Session" src="https://raw.githubusercontent.com/Ac6Embedded/vscode-zephyr-workbench/main/images/zw_7_start_debug_session.png" width="80%">
</p>

### Debug your application

After starting the debug session, the code should breaks on main or early (depends on optimization on your project). 
<p align="center">
  <img alt="Debug: Overview" src="https://raw.githubusercontent.com/Ac6Embedded/vscode-zephyr-workbench/main/images/zw_7_debug_overview.png" width="80%">
</p>

The "Debug Toolbar" allows you to **Continue/Pause**, **Step Over**, **Step Into**, **Step Out**, **Restart** or , **Stop**
<p align="center">
  <img alt="Debug: Toolbar" src="https://raw.githubusercontent.com/Ac6Embedded/vscode-zephyr-workbench/main/images/zw_7_debug_toolbar.png" width="80%">
</p>

Inspect variables and CPU registers on the left panel
<p align="center">
  <img alt="Debug: Variables and Registers" src="https://raw.githubusercontent.com/Ac6Embedded/vscode-zephyr-workbench/main/images/zw_7_debug_variables.png" width="80%">
</p>

If the SVD file was set in the debug configuration, the peripherals are displayed in the "xperipherals" view.
<p align="center">
  <img alt="Debug: XPeripherals" src="https://raw.githubusercontent.com/Ac6Embedded/vscode-zephyr-workbench/main/images/zw_7_debug_xperipherals.png" width="80%">
</p>

To debug in disassembly, right-click on the code then select "Open Disassembly View"
<p align="center">
  <img alt="Debug: Disassembly" src="https://raw.githubusercontent.com/Ac6Embedded/vscode-zephyr-workbench/main/images/zw_7_debug_open_disasm.png" width="80%">
  <img alt="Debug: Disassembly" src="https://raw.githubusercontent.com/Ac6Embedded/vscode-zephyr-workbench/main/images/zw_7_debug_disasm.png" width="80%">
</p>

More information about [Debugging on VSCODE](https://code.visualstudio.com/docs/editor/debugging)

### Install Debug tools
Only OpenOCD and STM32CubeProgrammer are currently supported
1. Click on the "Install Debug tools" menu
2. The list of supported is displayed here
3. Click on the "Install" icon to install the tools 
   <or>
   Click on the "Website" icon to be redirected to the official website of the tool and manually install it
Note: As third-party installer cannot be fully controlled, you might need to manually set up your PATH environment variable to use the tool in Zephyr Workbench

<p align="center">
  <img alt="Debug tools" src="https://raw.githubusercontent.com/Ac6Embedded/vscode-zephyr-workbench/main/images/zw_8_install_debug_tools.png" width="80%">
</p>

## Known Issues
Error message in "Output" tab with new application project is created.
Uninstall tools not supported yet, please manually delete the ${USERDIR}/.zinstaller directory.

