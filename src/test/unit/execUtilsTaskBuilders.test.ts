// The task builders split out of execShellCommand / execShellCommandWithEnv,
// compared against the task the pre-split code built, for the shells the code
// branches on, and the git ls-remote options an agent passes.

import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  buildEnvSourcedShellCommand, buildEnvSourcedShellTask, buildShellTask, execShellCommand, execShellCommandWithEnv,
  getGitBranches, getGitTags, getProfileEnv, getShellExe, nonInteractiveGitEnv,
} from '../../utils/execUtils';
import { quoteLiteralForShell } from '../../utils/shellQuoting';

type Settings = Record<string, unknown>;
// The raw stub module, whose exports are swapped for this file's tests.
const stub = require('vscode') as Record<string, any>;

/**
 * The body of execShellCommand before the split, minus running the task. It
 * stays here only as the reference the builders are compared against.
 */
function legacyShellTask(cmdName: string, cmd: string, options: vscode.ShellExecutionOptions): vscode.Task {
  if (!cmd) {
    throw new Error('Missing command to execute');
  }
  const shExec = new vscode.ShellExecution(cmd, options);
  const task = new vscode.Task(
    { label: cmdName, type: 'zephyr-workbench-shell' },
    vscode.TaskScope.Workspace,
    cmdName,
    'Zephyr Workbench',
    shExec
  );
  task.presentationOptions.echo = true;
  return task;
}

/** The body of execShellCommandWithEnv before the split, minus running the task. */
function legacyEnvSourcedShellTask(
  cmdName: string,
  cmd: string,
  options: vscode.ShellExecutionOptions,
  executableOverride?: string,
): vscode.Task {
  const prepared = buildEnvSourcedShellCommand(cmd, options.cwd, executableOverride ?? getShellExe());
  options.executable = prepared.executable;
  options.shellArgs = prepared.shellArgs;

  options.env = {
    ...(prepared.needsChere ? { CHERE_INVOKING: '1' } : {}),
    ...getProfileEnv(),
    ...options.env,
    ...(prepared.venvPath ? { PYTHON_VENV_PATH: prepared.venvPath } : {})
  };
  return legacyShellTask(cmdName, prepared.command, options);
}

/** Everything VS Code reads from a task, as plain data. */
function describeTask(task: vscode.Task) {
  const execution = task.execution as vscode.ShellExecution;
  return {
    definition: task.definition,
    scope: task.scope,
    name: task.name,
    source: task.source,
    problemMatchers: task.problemMatchers,
    presentationOptions: task.presentationOptions,
    commandLine: execution.commandLine,
    options: execution.options,
  };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

class TestUri {
  constructor(readonly fsPath: string) {}
  static file(fsPath: string) { return new TestUri(fsPath); }
  static joinPath(base: { fsPath: string }, ...parts: string[]) { return new TestUri(path.join(base.fsPath, ...parts)); }
}

/** Settings, a class Uri (the settings reader tests `instanceof vscode.Uri`) and a recording task API. */
function useTaskHarness(): { settings: () => Settings; set: (next: Settings) => void; launched: vscode.Task[] } {
  let settings: Settings = {};
  const launched: vscode.Task[] = [];
  const saved: Record<string, unknown> = {};
  before(() => {
    saved.Uri = stub.Uri;
    saved.getConfiguration = stub.workspace.getConfiguration;
    saved.tasks = stub.tasks;
    saved.shell = stub.env.shell;
    stub.Uri = TestUri;
    stub.workspace.getConfiguration = (section?: string) => ({
      get: (key: string, fallback?: unknown) => settings[section ? `${section}.${key}` : key] ?? fallback,
      update: async () => undefined,
    });
    stub.tasks = {
      ...(saved.tasks as object),
      executeTask: async (task: vscode.Task) => {
        launched.push(task);
        return { task };
      },
      onDidEndTask: (listener: (event: unknown) => void) => {
        setImmediate(() => listener({ execution: { task: launched[launched.length - 1] } }));
        return { dispose() {} };
      },
    };
  });
  after(() => {
    stub.Uri = saved.Uri;
    stub.workspace.getConfiguration = saved.getConfiguration;
    stub.tasks = saved.tasks;
    stub.env.shell = saved.shell;
  });
  beforeEach(() => {
    launched.length = 0;
    settings = {};
  });
  return { settings: () => settings, set: next => { settings = next; }, launched };
}

describe('buildShellTask', () => {
  const harness = useTaskHarness();

  it('builds the task execShellCommand built before', () => {
    const options: vscode.ShellExecutionOptions = { cwd: '/home/u', env: { ENV_FILE: '/e/env.sh' }, executable: 'bash', shellArgs: ['-c'] };
    assert.deepStrictEqual(
      describeTask(buildShellTask('Creating local virtual environment', 'bash install.sh --create-venv', clone(options))),
      describeTask(legacyShellTask('Creating local virtual environment', 'bash install.sh --create-venv', clone(options))),
    );
  });

  it('refuses an empty command with the same message', () => {
    assert.throws(() => buildShellTask('x', '', {}), /^Error: Missing command to execute$/);
  });

  it('is what execShellCommand runs', async () => {
    const options: vscode.ShellExecutionOptions = { cwd: '/tmp', executable: 'powershell.exe', shellArgs: ['-Command'] };
    await execShellCommand('Setup SDK', 'C:\\sdk\\setup.cmd /c', clone(options));
    assert.equal(harness.launched.length, 1);
    assert.deepStrictEqual(describeTask(harness.launched[0]), describeTask(legacyShellTask('Setup SDK', 'C:\\sdk\\setup.cmd /c', clone(options))));
  });
});

describe('buildEnvSourcedShellTask', () => {
  const harness = useTaskHarness();
  let venvDir: string;

  before(() => {
    venvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw venv-'));
  });
  after(() => {
    fs.rmSync(venvDir, { recursive: true, force: true });
  });

  // bash and zsh come from the user's shell; PowerShell, cmd.exe and Cygwin
  // bash from the override the win32 installer flows pass, which every
  // platform honours the same way.
  const shells: { label: string; shell: string; override?: string }[] = [
    { label: 'bash', shell: '/bin/bash' },
    { label: 'zsh', shell: '/bin/zsh' },
    { label: 'Windows PowerShell', shell: '/bin/bash', override: 'powershell.exe' },
    { label: 'PowerShell 7', shell: '/bin/bash', override: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
    { label: 'cmd.exe', shell: '/bin/bash', override: 'C:\\Windows\\System32\\cmd.exe' },
    { label: 'Cygwin bash', shell: '/bin/bash', override: 'C:\\cygwin64\\bin\\bash.exe' },
  ];
  const cases: { label: string; cmd: string; options: vscode.ShellExecutionOptions; venv: boolean }[] = [
    {
      label: 'west init with a spaced workspace',
      cmd: 'west init -m https://github.com/zephyrproject-rtos/zephyr --mr v4.2.0 "/home/u/my ws"',
      options: { env: { ZEPHYR_PROJECT_DIRECTORY: '/home/u/my ws' }, cwd: '${userHome}' },
      venv: false,
    },
    {
      // A caller's executable is discarded, and the venv wins over a caller's PYTHON_VENV_PATH.
      label: 'west boards with an executable and a venv',
      cmd: 'west boards > /dev/null 2>&1',
      options: { env: { ZEPHYR_PROJECT_DIRECTORY: '/ws', PYTHON_VENV_PATH: '/caller/venv' }, cwd: '/ws', executable: 'bash' },
      venv: true,
    },
    {
      label: 'an install step without env',
      cmd: 'install.sh --only-without-root openocd',
      options: { cwd: '/tmp' },
      venv: false,
    },
  ];

  for (const shell of shells) {
    for (const testCase of cases) {
      it(`matches the pre-split task: ${shell.label}, ${testCase.label}`, () => {
        stub.env.shell = shell.shell;
        harness.set({
          'zephyr-workbench.pathToEnvScript': '/home/u/.zinstaller/my env/env.sh',
          ...(testCase.venv ? { 'zephyr-workbench.venv.path': venvDir } : {}),
        });
        const built = buildEnvSourcedShellTask('West task', testCase.cmd, clone(testCase.options), shell.override);
        const legacy = legacyEnvSourcedShellTask('West task', testCase.cmd, clone(testCase.options), shell.override);
        assert.deepStrictEqual(describeTask(built), describeTask(legacy));
      });
    }
  }

  it('leaves the caller options as they were', () => {
    stub.env.shell = '/bin/bash';
    harness.set({ 'zephyr-workbench.pathToEnvScript': '/e/env.sh', 'zephyr-workbench.venv.path': venvDir });
    const options: vscode.ShellExecutionOptions = { env: { A: '1' }, cwd: '/ws', executable: 'bash' };
    const before = clone(options);
    const built = buildEnvSourcedShellTask('West task', 'west update', options);
    assert.deepStrictEqual(options, before);
    assert.equal((built.execution as vscode.ShellExecution).options?.env?.PYTHON_VENV_PATH, venvDir);
  });

  it('refuses a missing env script before building anything, as before', () => {
    stub.env.shell = '/bin/bash';
    assert.throws(() => buildEnvSourcedShellTask('West task', 'west update', {}), /Missing Zephyr environment script/);
  });

  it('is what execShellCommandWithEnv runs', async () => {
    stub.env.shell = '/bin/zsh';
    harness.set({ 'zephyr-workbench.pathToEnvScript': '/e/env.sh' });
    const options: vscode.ShellExecutionOptions = { env: { ZEPHYR_PROJECT_DIRECTORY: '/ws' }, cwd: '/ws' };
    await execShellCommandWithEnv('West Update for current workspace', 'west update', clone(options));
    await execShellCommandWithEnv('Installing Host debug tools', 'install.ps1 -Only openocd', clone(options), 'powershell.exe');
    assert.deepStrictEqual(harness.launched.map(describeTask), [
      describeTask(legacyEnvSourcedShellTask('West Update for current workspace', 'west update', clone(options))),
      describeTask(legacyEnvSourcedShellTask('Installing Host debug tools', 'install.ps1 -Only openocd', clone(options), 'powershell.exe')),
    ]);
  });
});

describe('quoteLiteralForShell', () => {
  it('single-quotes for POSIX shells, escaping a quote', () => {
    assert.equal(quoteLiteralForShell('bash', 'https://x/a b'), `'https://x/a b'`);
    assert.equal(quoteLiteralForShell('zsh', "/tmp/it's"), `'/tmp/it'\\''s'`);
    assert.equal(quoteLiteralForShell('bash', '$(rm -rf ~);`x`'), `'$(rm -rf ~);\`x\`'`);
  });

  it('single-quotes for PowerShell, doubling a quote', () => {
    assert.equal(quoteLiteralForShell('powershell.exe', "https://x/it's"), `'https://x/it''s'`);
    assert.equal(quoteLiteralForShell('pwsh.exe', '$env:HOME;x'), `'$env:HOME;x'`);
  });

  it('double-quotes for cmd.exe and refuses what cmd still expands inside quotes', () => {
    assert.equal(quoteLiteralForShell('cmd.exe', 'https://x/a&b|c'), '"https://x/a&b|c"');
    for (const value of ['https://x/%PATH%', 'https://x/!a!', 'https://x/"a', 'C:\\repo\\']) {
      assert.equal(quoteLiteralForShell('cmd.exe', value), undefined, value);
    }
  });

  it('refuses control characters and non-ASCII for every shell', () => {
    for (const kind of ['bash', 'powershell.exe', 'cmd.exe']) {
      assert.equal(quoteLiteralForShell(kind, 'https://x/a\nrm -rf ~'), undefined, kind);
      // PowerShell reads typographic quotes as quotes.
      assert.equal(quoteLiteralForShell(kind, 'https://x/\u2019a'), undefined, kind);
    }
  });

  it('refuses a backslash for fish, which reads it inside single quotes', () => {
    assert.equal(quoteLiteralForShell('fish', 'C:\\repo'), undefined);
    assert.equal(quoteLiteralForShell('fish', 'https://x/y'), `'https://x/y'`);
  });
});

describe('nonInteractiveGitEnv', () => {
  it('turns off every prompt and puts ssh in batch mode', () => {
    assert.deepStrictEqual(nonInteractiveGitEnv({}), {
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    });
  });

  it("leaves the user's own ssh command alone", () => {
    assert.equal(nonInteractiveGitEnv({ GIT_SSH_COMMAND: 'ssh -i ~/.ssh/k' }).GIT_SSH_COMMAND, undefined);
    assert.equal(nonInteractiveGitEnv({ GIT_SSH: 'C:\\plink.exe' }).GIT_SSH_COMMAND, undefined);
  });
});

describe('getGitTags / getGitBranches options', function () {
  this.timeout(30000);
  const harness = useTaskHarness();
  let tmp: string;
  let repo: string;
  let gitDir: string | undefined;

  before(function () {
    try {
      gitDir = path.dirname(execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0]);
    } catch {
      this.skip();
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-git-'));
    // A path the shell would split or expand, so the fallback's quoting counts.
    repo = path.join(tmp, "my repo's $HOME");
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first');
    git('tag', 'v1.0.0');
    git('tag', 'v1.2.0');
    git('branch', 'feature/x');
  });
  after(() => {
    if (tmp) {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('lists tags and branches with plain PATH git, with and without options', async () => {
    assert.deepEqual(await getGitTags(repo), ['v1.2.0', 'v1.0.0']);
    assert.deepEqual(await getGitTags(repo, { nonInteractive: true, timeoutMs: 20000 }), ['v1.2.0', 'v1.0.0']);
    assert.deepEqual(await getGitBranches(repo, { nonInteractive: true }), ['feature/x', 'main']);
  });

  it('refuses a URL git would read as an option', async () => {
    await assert.rejects(getGitTags('--upload-pack=touch /tmp/pwned', { nonInteractive: true }), /Not a repository URL/);
  });

  it('falls back to the env-sourced git with the URL quoted and the prompts off', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    // No git on PATH for the first attempt; the env script puts it back and
    // records what the fallback's git would see.
    const seen = path.join(tmp, 'seen.txt');
    const envScript = path.join(tmp, 'env.sh');
    fs.writeFileSync(envScript, [
      `export PATH="${gitDir}:/usr/bin:/bin"`,
      `echo "$GIT_TERMINAL_PROMPT $GCM_INTERACTIVE $GIT_SSH_COMMAND" > "${seen}"`,
      '',
    ].join('\n'));
    stub.env.shell = '/bin/bash';
    harness.set({ 'zephyr-workbench.pathToEnvScript': envScript });
    const savedPath = process.env.PATH;
    const savedSsh = process.env.GIT_SSH_COMMAND;
    const savedGitSsh = process.env.GIT_SSH;
    process.env.PATH = path.join(tmp, 'nowhere');
    delete process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH;
    try {
      assert.deepEqual(await getGitTags(repo, { nonInteractive: true, timeoutMs: 20000 }), ['v1.2.0', 'v1.0.0']);
    } finally {
      process.env.PATH = savedPath;
      if (savedSsh !== undefined) { process.env.GIT_SSH_COMMAND = savedSsh; }
      if (savedGitSsh !== undefined) { process.env.GIT_SSH = savedGitSsh; }
    }
    assert.equal(fs.readFileSync(seen, 'utf8').trim(), '0 never ssh -o BatchMode=yes');
  });
});
