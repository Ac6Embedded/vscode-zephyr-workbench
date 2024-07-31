# Instructions Ac6 Zephyr Workbench for VS Code

## Prerequisite

- For ST nucleo_wba55cg: Install [STM32Cube_ProgrammerCLI](https://www.st.com/en/development-tools/stm32cubeprog.html)
- For NXP frdm-mcxn947: OpenOCD from Zephyr

## Installation

1. Start VS Code
2. Select "Extensions", Click on "..." > "Install from VSIX..."
3. Select the installer file

## Open the Zephyr Workbench page

1. On the left panel, click on the "ac6" logo

## Usage

1. Click on "Install Host Tools" to download and install the native tools in `${USERDIR}/.zinstaller` (takes ~5 minutes)
   - After the tools are installed, the Zephyr SDK should be auto-detected in "zephyr-sdk-0.16.8"

2. Import a Zephyr West Workspace
   - Click on the "Initialize workspace" button
   - Source location: Repository
   - Path: `https://github.com/zephyrproject-rtos/zephyr`
   - Branch: `v3.6.0`
   - Location: choose where to import the west workspace
   - (Approx. 4.7GB, takes time to initialize then update the workspace)

3. Create a new project
   - Click on "Create Zephyr application"
   - Select the west workspace to attach to
   - Select the target board (e.g., nucleo_wba55cg)
   - Select the sample project as base (e.g., blinky)
   - Enter the project location
   - Enter the project name

4. Build project
   - Under "Applications" view, right click on the project
   - Select "Build"

5. Flash binary
   - **Requirement:** STM32Cube_ProgrammerCLI must be already installed and accessible on PATH in your system
   - Right click on the project
   - Select "Run"
