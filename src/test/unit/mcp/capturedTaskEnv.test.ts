import { strict as assert } from 'assert';
import { capturedTaskEnv, resolveTaskVariables, resolveTerminalEnv, TaskVariableContext } from '../../../mcp/host/capturedTask';

describe('mcp/host/capturedTask resolveTerminalEnv', () => {
  it('expands ${env:PATH} instead of passing it through literally', () => {
    const { set } = resolveTerminalEnv({ PATH: '${env:PATH}:/opt/tools/bin' }, { PATH: '/usr/bin:/bin' });
    assert.equal(set.PATH, '/usr/bin:/bin:/opt/tools/bin');
  });

  it('expands ${workspaceFolder}', () => {
    const { set } = resolveTerminalEnv({ EXTRA: '${workspaceFolder}/tools' }, {}, '/ws/app');
    assert.equal(set.EXTRA, '/ws/app/tools');
  });

  it('turns a null value into an unset, as VS Code does', () => {
    const { set, unset } = resolveTerminalEnv({ PYTHONHOME: null }, { PYTHONHOME: '/x' });
    assert.deepEqual(unset, ['PYTHONHOME']);
    assert.equal(set.PYTHONHOME, undefined);
  });

  it('resolves an unknown env variable to empty, like VS Code', () => {
    assert.equal(resolveTerminalEnv({ X: 'a${env:NOPE}b' }, {}).set.X, 'ab');
  });
});

describe('mcp/host/capturedTask resolveTaskVariables', () => {
  const context: TaskVariableContext = {
    folder: '/ws/blinky', userHome: '/home/dev', env: { ZEPHYR_SDK: '/opt/sdk' }, platform: 'linux',
  };

  it('resolves the variables a ShellExecution resolves before it spawns', () => {
    assert.equal(resolveTaskVariables('${userHome}', context), '/home/dev');
    assert.equal(resolveTaskVariables('${workspaceFolder}/build', context), '/ws/blinky/build');
    assert.equal(resolveTaskVariables('app ${workspaceFolderBasename}', context), 'app blinky');
    assert.equal(resolveTaskVariables('${env:ZEPHYR_SDK}${pathSeparator}bin${/}x', context), '/opt/sdk/bin/x');
  });

  it('resolves an unset env variable to empty, as VS Code does', () => {
    assert.equal(resolveTaskVariables('a${env:NOPE}b', context), 'ab');
  });

  it('leaves what it does not know for the shell, and a folder variable with no folder', () => {
    const line = 'cd "${HOME}" && echo ${config:zephyr-workbench.sdk} ${input:west.runner}';
    assert.equal(resolveTaskVariables(line, context), line);
    assert.equal(resolveTaskVariables('${workspaceFolder}/x ${workspaceFolderBasename}', { ...context, folder: undefined }),
      '${workspaceFolder}/x ${workspaceFolderBasename}');
  });

  it('uses the Windows separator and looks env names up ignoring case on Windows', () => {
    const windows: TaskVariableContext = { ...context, env: { Path: 'C:\\bin' }, platform: 'win32' };
    assert.equal(resolveTaskVariables('${env:PATH}${pathSeparator}', windows), 'C:\\bin\\');
    assert.equal(resolveTaskVariables('${env:PATH}', { ...windows, platform: 'linux' }), '');
  });
});

describe('mcp/host/capturedTask capturedTaskEnv', () => {
  const none = { set: {}, unset: [] };

  it('never lets git wait for a password, a sign-in window or an SSH prompt', () => {
    const env = capturedTaskEnv({ base: { PATH: '/bin' }, terminal: none });
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GCM_INTERACTIVE, 'never');
    assert.equal(env.GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');
    assert.equal(env.PYTHONUNBUFFERED, '1');
    assert.equal(env.PATH, '/bin');
  });

  it('keeps an SSH command the user set anywhere, and the older GIT_SSH it would override', () => {
    assert.equal(capturedTaskEnv({ base: { GIT_SSH_COMMAND: 'ssh -i key' }, terminal: none }).GIT_SSH_COMMAND, 'ssh -i key');
    assert.equal(capturedTaskEnv({ base: {}, terminal: { set: { GIT_SSH_COMMAND: 'plink' }, unset: [] } }).GIT_SSH_COMMAND, 'plink');
    assert.equal(capturedTaskEnv({ base: {}, terminal: none, task: { GIT_SSH_COMMAND: 'ssh -F cfg' } }).GIT_SSH_COMMAND, 'ssh -F cfg');
    const legacy = capturedTaskEnv({ base: { GIT_SSH: '/usr/bin/plink' }, terminal: none });
    assert.equal(legacy.GIT_SSH_COMMAND, undefined);
    assert.equal(legacy.GIT_SSH, '/usr/bin/plink');
  });

  it('layers the terminal settings, the profile and the task, with the no-prompt settings last', () => {
    const env = capturedTaskEnv({
      base: { A: 'base', B: 'base', PYTHONHOME: '/py', GIT_TERMINAL_PROMPT: '1' },
      terminal: { set: { A: 'terminal' }, unset: ['PYTHONHOME'] },
      profile: { B: 'profile' },
      task: { C: 'task', GIT_TERMINAL_PROMPT: '1' },
    });
    assert.equal(env.A, 'terminal');
    assert.equal(env.B, 'profile');
    assert.equal(env.C, 'task');
    assert.equal('PYTHONHOME' in env, false, 'a null in terminal.integrated.env removes the variable');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(capturedTaskEnv({ base: { X: '1' }, terminal: { set: {}, unset: ['X'] }, task: { X: '2' } }).X, '2',
      'the task can set again what the terminal settings removed');
  });
});
