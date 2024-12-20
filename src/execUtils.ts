import * as vscode from 'vscode';
import { compareVersions, fileExists } from './utils';
import { ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY } from './constants';
import { ChildProcess, ExecException, ExecOptions, SpawnOptions, SpawnOptionsWithoutStdio, exec, spawn } from 'child_process';

let _channel: vscode.OutputChannel;

export function concatCommands(shell: string, ...cmds: string[]): string {
  switch(shell) {
    case 'bash': 
      return cmds.join(' && ');
    case 'cmd.exe':
      return cmds.join(' && ');
    case 'powershell.exe':
      return cmds.join('; ');
    default:
      return cmds.join(' && ');
  }
}

export function getEnvVarFormat(shell: string, env: string): string {
  switch(shell) {
    case 'bash': 
      return `$\{${env}\}`;
    case 'cmd.exe':
      return `%${env}%`;
    case 'powershell.exe':
      return `$\{env:${env}\}`;
    default:
      return `$${env}`;
  }
}

export function getShell(): string {
  let shell: string;
  switch(process.platform) {
    case 'win32':
      shell = 'cmd.exe';
      break; 
    default:
      shell = 'bash';
      break;
  }
  return shell;
}

export function getTerminalShell(): string {
  let shell: string;
  switch(process.platform) {
    case 'win32':
      shell = 'powershell.exe';
      break; 
    default:
      shell = 'bash';
      break;
  }
  return shell;
}

export function getShellArgs(shell: string): string[] {
  switch(shell) {
    case 'bash': 
      return ['-c'];
    case 'cmd.exe':
      return ['/d', '/c'];
    case 'powershell.exe':
      return ['-Command'];
    default:
      return [];
  }
}

export function getShellNullRedirect(shell: string): string {
  switch(shell) {
    case 'bash': 
      return '> /dev/null 2>&1';
    case 'cmd.exe':
      return '> NUL 2>&1';
    case 'powershell.exe':
      return '> $null 2>&1';
    default:
      return '';
  }
}

export function getShellSourceCommand(shell: string, script: string): string {
  switch(shell) {
    case 'bash': 
      return `. ${script}`;
    case 'cmd.exe':
      return `call ${script}`;
    case 'powershell.exe':
      return `. ${script}`;
    default:
      return '';
  }
}

export function getShellEchoCommand(shell: string): string {
  switch(shell) {
    case 'bash': 
      return 'echo';
    case 'cmd.exe':
      return 'echo';
    case 'powershell.exe':
      return 'Write-Output';
    default:
      return 'echo';
  }
}

export function getShellClearCommand(shell: string): string {
  switch(shell) {
    case 'bash': 
      return 'clear';
    case 'cmd.exe':
      return 'cls';
    case 'powershell.exe':
      return 'cls';
    default:
      return '';
  }
}

export function getOutputChannel(): vscode.OutputChannel {
	if (!_channel) {
		_channel = vscode.window.createOutputChannel('Ac6 Zephyr Workbench');
	}
	return _channel;
}

export function expandEnvVariables(input: string): string {
  // Regex for $VAR, ${VAR}, @VAR@, %VAR%
  const envVariableRegex = /\$(\w+)|\$\{(\w+)\}|@(\w+)@|%(\w+)%/g;

  return input.replace(envVariableRegex, (_, var1, var2, var3, var4) => {
      const envVar = var1 || var2 || var3 || var4;
      return process.env[envVar] || '';
  });
}

export async function executeTask(task: vscode.Task): Promise<vscode.TaskExecution> {
  const execution = await vscode.tasks.executeTask(task);
  
  return new Promise<vscode.TaskExecution>(resolve => {
    let disposable = vscode.tasks.onDidEndTask(e => {
      if (e.execution.task.name === task.name) {
        // getOutputChannel().appendLine(e.execution.task.name + ' has finished');
        disposable.dispose();
        resolve(e.execution);
      }
    });
  });
}


/**
 * Execute a shell command
 * @param cmdName The command name
 * @param cmd     The command
 * @param options The shell execution option (if no cwd, ${workspaceFolder} is default)
 * @returns 
 */
export async function execShellCommand(cmdName: string, cmd: string, options: vscode.ShellExecutionOptions) {
  if(!cmd || cmd.length === 0) {
    throw new Error('Missing command to execute');
  }

  // Prepend environment script before any command
  let shellExec = new vscode.ShellExecution(cmd, options);

  let task = new vscode.Task(
    { label: cmdName, type: 'shell'},
    vscode.TaskScope.Workspace,
    cmdName,
    'Zephyr Workbench',
    shellExec
  );
  task.presentationOptions.echo = false;

  await executeTask(task);
} 


/**
 * Prepend the command with a command to source the environment script
 * Execute it as a ShellExecution task
 * @param cmdName The command name
 * @param cmd     The west command
 * @param options The shell execution option (if no cwd, ${workspaceFolder} is default)
 * @returns 
 */
export async function execShellCommandWithEnv(cmdName: string, cmd: string, options: vscode.ShellExecutionOptions) {
  let envScript: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
  let activatePath: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY);

  if(!envScript) {
    throw new Error('Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Zephyr Workbench > Path To Env Script',
       { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` });
  } 

  if(!cmd || cmd.length === 0) {
    throw new Error('Missing command to execute', { cause: "missing.command" });
  }

  if(activatePath && !fileExists(activatePath)) {
    throw new Error('Invalid Python Virtual Environment.\nGo to File > Preferences > Settings > Extensions > Zephyr Workbench > Venv: Activate Path',
       { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY}`});
  }

  const shell: string = getShell();
  const shellArgs: string[] = getShellArgs(shell);
  options.executable = shell;
  options.shellArgs = shellArgs;
  
  if(activatePath) {
    options.env =  {
      PYTHON_VENV_ACTIVATE_PATH: activatePath,
      ...options.env
    };
  }

  // Prepend environment script before any command
  let cmdEnv = getShellSourceCommand(shell, envScript);
  await execShellCommand(cmdName, concatCommands(shell, cmdEnv, cmd), options);
} 

export async function execCommandWithEnv(cmd: string, cwd?: string | undefined, callback?: ((error: ExecException | null, stdout: string, stderr: string) => void)): Promise<ChildProcess> {
  let envScript: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
  let activatePath: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY);
  let options: ExecOptions = {};
  if(!envScript) {
    throw new Error('Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Zephyr Workbench > Path To Env Script',
       { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` });
  } 

  if(activatePath && !fileExists(activatePath)) {
    throw new Error('Invalid Python Virtual Environment.\nGo to File > Preferences > Settings > Extensions > Zephyr Workbench > Venv: Activate Path',
       { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY}`});
  } else {
    options = { 
      env: {
        ...process.env,
        'PYTHON_VENV_ACTIVATE_PATH': activatePath,
      }
    };
  }

  if(cwd) {
    options.cwd = cwd;
  }
  
  const shell: string = getShell();
  const redirect = getShellNullRedirect(shell);
  const cmdEnv = `${getShellSourceCommand(shell, envScript)} ${redirect}`;
  const command = concatCommands(shell, cmdEnv, cmd);

  options.shell = shell;
  
  return exec(command, options, callback);
}

export function execCommandWithEnvCB(cmd: string, cwd?: string | undefined, options? : ExecOptions, callback?: ((error: ExecException | null, stdout: string, stderr: string) => void)): ChildProcess {
  let envScript: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
  let activatePath: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY);
  
  if(!envScript) {
    throw new Error('Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Zephyr Workbench > Path To Env Script',
       { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` });
  } 

  if(activatePath && !fileExists(activatePath)) {
    throw new Error('Invalid Python Virtual Environment.\nGo to File > Preferences > Settings > Extensions > Zephyr Workbench > Venv: Activate Path',
       { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY}`});
  } else {
    if(options && options.env) {
      options = { 
        env: {
          ...options.env,
          'PYTHON_VENV_ACTIVATE_PATH': activatePath,
        }
      };
    } else {
      options = { 
        env: {
          'PYTHON_VENV_ACTIVATE_PATH': activatePath,
        }
      };
    }
    
  }

  if(cwd) {
    options.cwd = cwd;
  }
  
  const shell: string = getShell();
  const redirect = getShellNullRedirect(shell);
  const cmdEnv = `${getShellSourceCommand(shell, envScript)} ${redirect}`;
  const command = concatCommands(shell, cmdEnv, cmd);

  options.shell = shell;
  
  return exec(command, options, callback);
}

export function spawnCommandWithEnv(cmd: string, options: SpawnOptions = {}): ChildProcess {
  let envScript: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
  let activatePath: string | undefined = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY);
  if(!envScript) {
    throw new Error('Missing Zephyr environment script.\nGo to File > Preferences > Settings > Extensions > Zephyr Workbench > Path To Env Script',
       { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY}` });
  } 

  if(activatePath && !fileExists(activatePath)) {
    throw new Error('Invalid Python Virtual Environment.\nGo to File > Preferences > Settings > Extensions > Zephyr Workbench > Venv: Activate Path',
       { cause: `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY}`});
  } else {
    options.env = {
      ...options.env,
      'PYTHON_VENV_ACTIVATE_PATH': activatePath,
    };
  }
  
  const shell: string = getShell();
  const redirect = getShellNullRedirect(shell);
  const cmdEnv = `${getShellSourceCommand(shell, envScript)} ${redirect}`;
  const command = concatCommands(shell, cmdEnv, cmd);

  options.shell = shell;

  return spawn(command, options);
}

export async function getGitTags(gitUrl: string): Promise<string[]> {
  const gitCmd = `git ls-remote --tags ${gitUrl}`;
  return new Promise((resolve, reject) => {
    execCommandWithEnv(gitCmd, undefined, (error: any, stdout: string, stderr: any) => {
      if (error) {
        reject(`Error: ${stderr}`);
      }

      // Process the output and split into an array of tag names
      const tags = stdout
        .trim()
        .split('\n')
        .filter(line => !line.includes('^{}'))
        .map(line => { return line.split('\t')[1].replace('refs/tags/', ''); })
        .sort((a, b) => compareVersions(b, a));

      resolve(tags);
    });
  });
}


export async function getPyOCDTargets(): Promise<string[]> {
  const pyOCDCmd = 'pyocd list --targets';
  return new Promise((resolve, reject) => {
    execCommandWithEnv(pyOCDCmd, undefined, (error: any, stdout: string, stderr: any) => {
      if (error) {
        reject(`Error: ${stderr}`);
      }

      // Process the output and split into an array of supported targets names
      const targets = stdout
        .split('\n')
        .slice(2)       // Skip header lines
        .filter(line => line.trim().length > 0)
        .map(line => line.trim().split(/\s+/)[0]);

      resolve(targets);
    });
  });
}

export async function checkPyOCDTarget(targetName: string) {
  let targets = await getPyOCDTargets();
  return (targets.includes(targetName.trim()));
}

export async function updatePyOCDPack(): Promise<string> {
  const pyOCDUpdateCmd = 'pyocd pack update';
  return new Promise((resolve, reject) => {
    execCommandWithEnv(pyOCDUpdateCmd, undefined, (error: any, stdout: string, stderr: any) => {
      if (error) {
        reject(error);
        return;
      }
      if (stderr) {
          console.error(`stderr: ${stderr}`);
      }
      resolve(stdout);
    });
  });
}

export async function installPyOCDTarget(targetName: string): Promise<string> {
  const pyOCDInstallCmd = `pyocd pack install ${targetName}`;
  return new Promise((resolve, reject) => {
    execCommandWithEnv(pyOCDInstallCmd, undefined, (error: any, stdout: string, stderr: any) => {
      if (error) {
        reject(error);
        return;
      }
      if (stderr) {
          console.error(`stderr: ${stderr}`);
      }
      resolve(stdout);
    });
  });
}