import fs from 'fs';
import path from 'path';
import * as vscode from 'vscode';
import { ZEPHYR_WORKBENCH_PATHTOENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from "./constants";
import { Linkserver } from "./debug/runners/Linkserver";
import { Openocd } from "./debug/runners/Openocd";
import { WestRunner } from "./debug/runners/WestRunner";
import { concatCommands, getShell, getShellSourceCommand } from './execUtils';
import { WestWorkspace } from "./WestWorkspace";
import { ZephyrProject } from "./ZephyrProject";

export function getDebugRunners(): WestRunner[] {
  return [ new Openocd(), 
    new Linkserver() ];
}

export function getRunner(runnerName: string): WestRunner | undefined {
  switch(runnerName) {
    case 'openocd':
      return new Openocd();
    case 'linkserver':
      return new Linkserver();
    default: 
      return undefined;
  }
}

export function createWestWrapper(project: ZephyrProject, westWorkspace: WestWorkspace) {
  let envScript: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_PATHTOENV_SCRIPT_SETTING_KEY);
  if(!envScript) {
    throw new Error('Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Zephyr Workbench > Path To Env Script',
       { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATHTOENV_SCRIPT_SETTING_KEY}` });
  } 
  const shell: string = getShell();
  let westCmd = '';
  switch (shell) {
    case 'bash': 
      westCmd = 'west "$@"';
      break;
    case 'cmd.exe':
      westCmd = 'west %*';
      break;
    case 'powershell.exe':
      westCmd = 'west $args';
      break;
    default:
      westCmd = 'west "$@"';
      break;
  }

  const cmdEnv = getShellSourceCommand(shell, envScript);
  const debugServerCommand = concatCommands(shell, cmdEnv, westCmd);
  
  let envVars = {
    ...westWorkspace.buildEnv,
    ...project.buildEnv
  };

  let envVarsCommands = '';

  for (const [key, value] of Object.entries(envVars)) {
    switch (shell) {
      case 'bash': 
        envVarsCommands += `export ${key}="${value}"\n`;
        break;
      case 'cmd.exe':
        envVarsCommands += `set ${key}=${value}\n`;
        break;
      case 'powershell.exe':
        envVarsCommands += `$env:${key} = "${value}"\n`;
        break;
      default:
        envVarsCommands += `export ${key}="${value}"\n`;
        break;
    }
  }

  let wrapperPath = '';
  let wrapperScript = '';
  switch (shell) {
    case 'bash': 
      wrapperScript = `#!/bin/bash
# Set environment variables
${envVarsCommands}

# Source environment and execute West
${debugServerCommand}
`;
      wrapperPath = path.join(project.sourceDir, 'west_wrapper.sh');
      fs.writeFileSync(wrapperPath, wrapperScript, { mode: 0o755 });
      break;
    case 'cmd.exe':
      wrapperScript = `@echo off
REM Set environment variables
${envVarsCommands}

REM Source environment and execute West
${debugServerCommand}
`;
      wrapperPath = path.join(project.sourceDir, 'west_wrapper.bat');
      fs.writeFileSync(wrapperPath, wrapperScript);
      break;
    case 'powershell.exe':
      wrapperScript = `${envVarsCommands}

# Source environment and execute West
${debugServerCommand}
`;
      wrapperPath = path.join(project.sourceDir, 'west_wrapper.ps1');
      fs.writeFileSync(wrapperPath, wrapperScript);
      break;
    default:
      break;
  }
}

export function createLaunchString(): string {
  let program;
  let serverStartPattern;
  let gdbRelativePath;
  let wrapper;
  let runner;

  return `"name": "Zephyr Workbench Debug",
"type": "cppdbg",
"request": "launch",
"program": "${program}",
"args": [],
"stopAtEntry": true,
"cwd": "$\{workspaceFolder\}",
"environment": [],
"externalConsole": false,
"serverLaunchTimeout": 20000,
"filterStderr": true,
"filterStdout": true,
"serverStarted": "${serverStartPattern}",
"MIMode": "gdb",
"miDebuggerPath": "$\{config:zephyr-workbench.sdk\}/${gdbRelativePath}",
"debugServerPath": "$\{workspaceFolder\}/${wrapper}",
"debugServerArgs": "debugserver --runner ${runner} --build-dir $\{workspaceFolder\}/build/$\{config:zephyr-workbench.board\}",
"setupCommands": [],
"logging": {}
`;
}