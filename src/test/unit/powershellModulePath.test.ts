// The PSModulePath the extension gives Windows PowerShell: without the
// PowerShell 7 folders a VS Code started from PowerShell 7 inherits, which
// make Windows PowerShell lose Get-ExecutionPolicy and Get-FileHash.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildShellTask } from '../../utils/execUtils';
import { isPowerShell7ModuleFolder, windowsPowerShellEnv, windowsPowerShellModulePath } from '../../utils/powershellUtils';
import { withPlatform } from './taskTestHarness';

// The folders PowerShell 7 puts in front for the user's and all users' modules.
const PS7_USER = 'C:\\Users\\me\\Documents\\PowerShell\\Modules';
const PS7_ALL_USERS = 'C:\\Program Files\\PowerShell\\Modules';
// The Windows PowerShell folders, which must stay.
const WINPS = [
  'C:\\Users\\me\\Documents\\WindowsPowerShell\\Modules',
  'C:\\Program Files\\WindowsPowerShell\\Modules',
  'C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules',
];

describe('windowsPowerShellModulePath', () => {
  let tmp: string;
  // A PowerShell 7 unzipped by hand: its Modules folder has a pwsh.dll next to it.
  let pwshModules: string;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-psmodulepath-'));
    pwshModules = path.join(tmp, 'pwsh-7.4.6', 'Modules');
    fs.mkdirSync(pwshModules, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'pwsh-7.4.6', 'pwsh.dll'), '');
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('drops the PowerShell 7 folders and keeps the others in order', () => {
    const value = [PS7_USER, PS7_ALL_USERS, pwshModules, ...WINPS].join(';');
    assert.equal(windowsPowerShellModulePath(value, 'win32'), WINPS.join(';'));
  });

  it('recognizes a PowerShell 7 copy wherever it is, by its pwsh.dll', () => {
    assert.equal(isPowerShell7ModuleFolder(pwshModules), true);
    assert.equal(isPowerShell7ModuleFolder(path.join(tmp, 'Modules')), false);
  });

  it("keeps the user's own folders, one named PowerShell included", () => {
    const own = ['D:\\PowerShell\\MyModules', 'D:\\Tools\\Modules'];
    assert.equal(windowsPowerShellModulePath([PS7_USER, ...own, ...WINPS].join(';'), 'win32'), [...own, ...WINPS].join(';'));
  });

  it('leaves a list without PowerShell 7 folders as it is', () => {
    assert.equal(windowsPowerShellModulePath(WINPS.join(';'), 'win32'), undefined);
    assert.equal(windowsPowerShellModulePath(undefined, 'win32'), undefined);
  });

  it('changes nothing off Windows', () => {
    assert.equal(windowsPowerShellModulePath([PS7_USER, ...WINPS].join(';'), 'linux'), undefined);
  });
});

describe('windowsPowerShellEnv', () => {
  it('replaces the variable under the name it has and leaves the input alone', () => {
    const env = { Path: 'C:\\bin', PSMODULEPATH: [PS7_USER, ...WINPS].join(';') };
    assert.deepEqual(windowsPowerShellEnv(env, 'win32'), { Path: 'C:\\bin', PSMODULEPATH: WINPS.join(';') });
    assert.equal(env.PSMODULEPATH, [PS7_USER, ...WINPS].join(';'));
  });

  it('returns the same object when nothing changes', () => {
    const env = { PSModulePath: WINPS.join(';') };
    assert.equal(windowsPowerShellEnv(env, 'win32'), env);
    const offWindows = { PSModulePath: [PS7_USER, ...WINPS].join(';') };
    assert.equal(windowsPowerShellEnv(offWindows, 'linux'), offWindows);
  });
});

describe('buildShellTask PSModulePath', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.PSModulePath;
  });
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.PSModulePath;
    } else {
      process.env.PSModulePath = saved;
    }
  });

  const options = (): vscode.ShellExecutionOptions => ({ executable: 'powershell.exe', shellArgs: ['-Command'] });
  const optionsOf = (task: vscode.Task) => (task.execution as vscode.ShellExecution).options;

  it('gives a Windows task the list without the PowerShell 7 folders', async () => {
    process.env.PSModulePath = [PS7_USER, PS7_ALL_USERS, ...WINPS].join(';');
    const task = await withPlatform('win32', () => buildShellTask('Installing Host tools', 'powershell -File install.ps1', options()));
    assert.deepEqual(optionsOf(task), { ...options(), env: { PSModulePath: WINPS.join(';') } });
  });

  it('keeps the task options as they are when there is nothing to drop', async () => {
    process.env.PSModulePath = WINPS.join(';');
    const given = options();
    const task = await withPlatform('win32', () => buildShellTask('Installing Host tools', 'powershell -File install.ps1', given));
    assert.equal(optionsOf(task), given);
  });
});
