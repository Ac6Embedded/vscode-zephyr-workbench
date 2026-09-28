// The run_command tool on the host side: the real job manager and
// confirmation gate, with the terminal shell, the Zephyr terminal environment
// and the task runner stood in for, so a test decides which shell VS Code
// uses and what the command does, and nothing is ever spawned.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { findTool, TOOL_CATALOG } from '../../../mcp/core/catalog';
import { McpToolError } from '../../../mcp/core/errors';
import { ConfirmCategory, permissionForCategories, ToolContext } from '../../../mcp/core/toolSpec';
import { VERBATIM_COMMAND_MARKER } from '../../../mcp/host/capturedTask';
import { commandHost, ShellChoice } from '../../../mcp/host/commandEnv';
import { AskAnswer, Confirmations } from '../../../mcp/host/confirmations';
import { HostDeps } from '../../../mcp/host/handlers/deps';
import { DIALOG_COMMAND_CHARS, runCommand } from '../../../mcp/host/handlers/runCommand';
import { HostServices } from '../../../mcp/host/services';
import { JobManager } from '../../../mcp/jobs/jobManager';
import { TerminalEnvGroup } from '../../../utils/execUtils';
import { useUiGuard } from './uiGuard';

const stub = require('vscode') as Record<string, any>;

/** A Uri the workbench's `instanceof vscode.Uri` checks accept. */
class TestUri {
  constructor(readonly fsPath: string) {}
  static file(fsPath: string) { return new TestUri(fsPath); }
  static joinPath(base: { fsPath: string }, ...parts: string[]) { return new TestUri(path.join(base.fsPath, ...parts)); }
}

interface RunCall {
  task: { name: string; definition: Record<string, unknown>; scope: unknown; execution: { commandLine: string; options: Record<string, any> } };
  signal: AbortSignal;
  options: { reveal?: number; header?: string };
}

interface Harness {
  root: string;
  appRoot: string;
  otherAppRoot: string;
  wsRoot: string;
  buildDir: string;
  envDir: string;
  jobs: JobManager;
  deps: HostDeps;
  asked: string[];
  /** The detail of each dialog, in order. */
  details: string[];
  answers: AskAnswer[];
  confirmActions: ConfirmCategory[];
  shell: ShellChoice;
  envSetting: string | undefined;
  runs: RunCall[];
  /** What the fake command does: end with a code, or run until it is stopped. */
  behaviour: { exitCode: number; output: string } | 'until-stopped';
  groupShells: string[];
}

const savedHost = { ...commandHost };
let savedUri: unknown;
let current: Harness | undefined;

function makeApp(appRoot: string, name: string, wsRoot: string) {
  return {
    appRootPath: appRoot, appName: name, westWorkspaceRootPath: wsRoot, venvPath: path.join(wsRoot, '.venv'),
    appWorkspaceFolder: { uri: TestUri.file(appRoot), name, index: 0 },
    buildConfigs: [
      { name: 'primary', active: true, boardIdentifier: 'nrf52840dk/nrf52840', getBuildDir: () => path.join(appRoot, 'build', 'primary') },
      { name: 'debug', active: false, boardIdentifier: 'frdm_mcxa344', getBuildDir: () => path.join(appRoot, 'build', 'debug') },
    ],
  };
}

function harness(): Harness {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-run-command-')));
  const wsRoot = path.join(root, 'ws');
  const appRoot = path.join(root, 'blinky');
  const otherAppRoot = path.join(root, 'hello');
  for (const dir of [wsRoot, appRoot, otherAppRoot, path.join(root, 'tools'), path.join(appRoot, 'src')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const ext of ['sh', 'ps1', 'bat']) {
    fs.writeFileSync(path.join(root, 'tools', `env.${ext}`), '');
  }
  const apps = [makeApp(appRoot, 'blinky', wsRoot)];
  const workspace = { name: 'zephyrproject', rootUri: TestUri.file(wsRoot), venvPath: path.join(wsRoot, '.venv') };

  const services = new HostServices(TestUri.file(os.tmpdir()) as never);
  services.listApplications = async () => apps as never;
  services.knownRoots = async () => [appRoot, otherAppRoot, wsRoot];
  services.resolveWestWorkspace = (async (requested?: string) => {
    if (requested && path.resolve(requested) !== wsRoot) {
      throw new McpToolError('INVALID_ARGUMENT', `No west workspace at ${requested}.`);
    }
    return { workspace };
  }) as never;

  const jobs = new JobManager({ logPathFor: id => path.join(root, 'jobs', `${id}.log`), recordPathFor: id => path.join(root, 'jobs', `${id}.json`) });
  fs.mkdirSync(path.join(root, 'jobs'));
  const h = {
    root, appRoot, otherAppRoot, wsRoot, buildDir: path.join(appRoot, 'build', 'primary'), envDir: path.join(root, 'mcp', 'env'),
    // Full by default; the confirmation tests set the tool to Ask.
    jobs, asked: [], details: [], answers: [], confirmActions: [],
    shell: { path: '/bin/bash' }, envSetting: path.join(root, 'tools', 'env.sh'),
    runs: [], behaviour: { exitCode: 0, output: 'done\n' }, groupShells: [],
  } as unknown as Harness;
  (h as unknown as { apps: unknown[] }).apps = apps;

  const confirmations = new Confirmations({
    permission: tool => permissionForCategories(tool, h.confirmActions),
    waitMs: () => 2000,
    log: { recordConfirmation: () => undefined },
    ask: async (message, detail) => {
      h.asked.push(message);
      h.details.push(detail);
      return h.answers.shift();
    },
  });
  h.deps = {
    services, jobs, confirmations,
    defaultWaitSeconds: 5,
    revealTerminal: 'never',
    permissionOf: tool => permissionForCategories(tool, h.confirmActions),
    kconfig: {} as HostDeps['kconfig'],
    extensionContext: {} as HostDeps['extensionContext'],
    folders: {} as HostDeps['folders'],
    refreshViews: async () => undefined,
    servedTools: () => new Set(TOOL_CATALOG.map(tool => tool.name)),
  };

  const groups = (label: string, shell: ShellChoice): TerminalEnvGroup[] => {
    h.groupShells.push(shell.path);
    return [
      { label: 'Zephyr build system', env: { ZEPHYR_BASE: path.join(wsRoot, 'zephyr'), BOARD: label } },
      { label: 'Helpers', env: { PYTHON_VENV_PATH: path.join(wsRoot, '.venv') } },
    ];
  };
  commandHost.terminalShell = () => h.shell;
  commandHost.configGroups = ((_app: unknown, config: { boardIdentifier: string }, shell: ShellChoice) => groups(config.boardIdentifier, shell)) as never;
  commandHost.workspaceGroups = ((_ws: unknown, shell: ShellChoice) => groups('none', shell)) as never;
  commandHost.envScriptSetting = () => h.envSetting;
  commandHost.envDir = () => h.envDir;
  commandHost.runTask = (async (task: RunCall['task'], sink: { onData(text: string): void }, signal: AbortSignal, options: RunCall['options']) => {
    h.runs.push({ task, signal, options });
    if (h.behaviour === 'until-stopped') {
      sink.onData('running\n');
      await new Promise<void>(resolve => (signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true })));
      return { exitCode: undefined, started: true };
    }
    sink.onData(h.behaviour.output);
    return { exitCode: h.behaviour.exitCode, started: true };
  }) as never;
  current = h;
  return h;
}

function ctx(h: Harness, client = { name: 'test-agent', version: '1', instance: 'agent-1' }): ToolContext<HostDeps> {
  return {
    signal: new AbortController().signal,
    progress: () => undefined,
    client,
    deps: h.deps,
    tool: findTool('run_command')!,
    startedAt: Date.now(),
    audit: {},
  };
}

const call = (h: Harness, args: Record<string, unknown>, client?: { name: string; version: string; instance: string }) =>
  runCommand(args, ctx(h, client)) as Promise<any>;

async function errorOf(promise: Promise<unknown>): Promise<McpToolError> {
  try {
    await promise;
  } catch (error) {
    return error as McpToolError;
  }
  throw new Error('expected the call to fail');
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for a condition');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const posix = (p: string) => p.replace(/\\/g, '/');

describe('mcp/host/handlers/runCommand', function () {
  this.timeout(20000);
  useUiGuard();

  before(() => {
    savedUri = stub.Uri;
    stub.Uri = TestUri;
  });

  after(() => {
    stub.Uri = savedUri;
  });

  afterEach(async () => {
    Object.assign(commandHost, savedHost);
    if (current) {
      for (const job of current.jobs.list()) {
        if (job.status === 'running') {
          current.jobs.cancel(job.id);
        }
      }
      await Promise.all(current.jobs.list().map(job => job.done));
      fs.rmSync(current.root, { recursive: true, force: true });
      current = undefined;
    }
  });

  describe('arguments', () => {
    it('refuses an unknown action, and any argument the action does not take', async () => {
      const h = harness();
      assert.equal((await errorOf(call(h, { action: 'shell' }))).code, 'INVALID_ARGUMENT');
      for (const misplaced of [{ command: 'west boards' }, { cwd: h.appRoot }, { timeout_sec: 5 }, { wait_sec: 5 }]) {
        const error = await errorOf(call(h, { action: 'env', ...misplaced }));
        assert.equal(error.code, 'INVALID_ARGUMENT', JSON.stringify(misplaced));
        assert.match(error.message, new RegExp(`does not take ${Object.keys(misplaced)[0]}`));
      }
      const shell = await errorOf(call(h, { action: 'run', command: 'west boards', shell: 'bash' }));
      assert.match(shell.message, /does not take shell/);
      assert.deepEqual([h.asked, h.runs], [[], []]);
    });

    it('refuses app_path and west_workspace together, and config_name without an application', async () => {
      const h = harness();
      const both = await errorOf(call(h, { action: 'run', command: 'west boards', app_path: h.appRoot, west_workspace: h.wsRoot }));
      assert.equal(both.code, 'INVALID_ARGUMENT');
      assert.match(both.message, /not both/);
      const config = await errorOf(call(h, { action: 'env', west_workspace: h.wsRoot, config_name: 'primary' }));
      assert.equal(config.code, 'INVALID_ARGUMENT');
      assert.deepEqual(h.asked, []);
    });

    it('takes the only application of the window, and wants app_path when there are several', async () => {
      const h = harness();
      const only = await call(h, { action: 'run', command: 'west boards' });
      assert.equal(only.app_path, h.appRoot);
      assert.equal(only.config_name, 'primary', 'the active configuration');
      (h as unknown as { apps: unknown[] }).apps.push(makeApp(h.otherAppRoot, 'hello', h.wsRoot));
      const ambiguous = await errorOf(call(h, { action: 'run', command: 'west boards' }));
      assert.equal(ambiguous.code, 'AMBIGUOUS_APP');
      const chosen = await call(h, { action: 'run', command: 'west boards', app_path: h.otherAppRoot, config_name: 'debug' });
      assert.deepEqual([chosen.app_path, chosen.config_name], [h.otherAppRoot, 'debug']);
      assert.equal(h.runs[1].task.execution.options.env.BOARD, 'frdm_mcxa344', 'the environment of that configuration');
      assert.equal(h.runs[1].task.name, 'hello (debug) Command');
    });

    it('refuses a command another tool does, before asking or running anything', async () => {
      const h = harness();
      const cases: Array<[string, string, RegExp]> = [
        ['west build -t menuconfig', 'INTERACTIVE_UNSUPPORTED', /open_in_workbench/],
        ['guiconfig', 'INTERACTIVE_UNSUPPORTED', /open_in_workbench/],
        ['west debug', 'INTERACTIVE_UNSUPPORTED', /debug_app/],
        ['west attach', 'INTERACTIVE_UNSUPPORTED', /debug_app/],
        ['west flash -r jlink', 'INVALID_ARGUMENT', /hardware with action "flash"/],
        ['west debugserver', 'INVALID_ARGUMENT', /debug_app/],
        ['west rtt', 'INTERACTIVE_UNSUPPORTED', /debug_app/],
        ['west update', 'INVALID_ARGUMENT', /manage_west_workspace with action "update"/],
        ['west blobs fetch', 'INVALID_ARGUMENT', /fetch_blobs/],
        ['', 'INVALID_ARGUMENT', /command/],
        [`echo ${'x'.repeat(4001)}`, 'INVALID_ARGUMENT', /script file/],
      ];
      for (const [command, code, hint] of cases) {
        const error = await errorOf(call(h, { action: 'run', command }));
        assert.equal(error.code, code, command);
        assert.match(error.hint ?? error.message, hint, command);
      }
      assert.equal((await errorOf(call(h, { action: 'run' }))).code, 'INVALID_ARGUMENT');
      assert.deepEqual([h.asked, h.runs, h.jobs.list()], [[], [], []]);
    });

    it('refuses a timeout out of range', async () => {
      const h = harness();
      for (const timeout of [0, 3601, 1.5]) {
        assert.equal((await errorOf(call(h, { action: 'run', command: 'west boards', timeout_sec: timeout }))).code, 'INVALID_ARGUMENT', String(timeout));
      }
    });

    it('needs the environment script, as the Zephyr terminal does', async () => {
      const h = harness();
      h.envSetting = undefined;
      const unset = await errorOf(call(h, { action: 'run', command: 'west boards' }));
      assert.equal(unset.code, 'ENV_NOT_READY');
      assert.match(unset.hint ?? '', /check_environment/);
      h.envSetting = path.join(h.root, 'nowhere', 'env.sh');
      const missing = await errorOf(call(h, { action: 'env' }));
      assert.equal(missing.code, 'ENV_NOT_READY');
      assert.match(missing.message, /nowhere/);
      // cmd sources env.bat, which must exist next to the configured script.
      h.envSetting = path.join(h.root, 'tools', 'env.ps1');
      fs.rmSync(path.join(h.root, 'tools', 'env.bat'));
      assert.equal((await errorOf(call(h, { action: 'env', shell: 'cmd' }))).code, 'ENV_NOT_READY');
      assert.deepEqual([h.asked, h.runs], [[], []]);
    });
  });

  describe('cwd', () => {
    it('runs in the build folder when it exists, else in the application root', async () => {
      const h = harness();
      const before = await call(h, { action: 'run', command: 'west boards' });
      assert.equal(before.result.cwd, h.appRoot);
      assert.equal(h.runs[0].task.execution.options.cwd, h.appRoot);
      fs.mkdirSync(h.buildDir, { recursive: true });
      const after = await call(h, { action: 'run', command: 'west boards' });
      assert.equal(after.result.cwd, h.buildDir);
      assert.equal(h.runs[1].task.execution.options.cwd, h.buildDir);
    });

    it('runs a west workspace command in its root, with its environment', async () => {
      const h = harness();
      const result = await call(h, { action: 'run', command: 'west list', west_workspace: h.wsRoot });
      assert.equal(result.result.cwd, h.wsRoot);
      assert.equal(result.app_path, undefined);
      assert.equal(h.runs[0].task.name, 'zephyrproject Command');
      assert.equal(h.runs[0].task.execution.options.env.BOARD, 'none', 'the west workspace terminal environment');
    });

    it('takes a cwd inside the folders of the window, and refuses one outside, relative or missing', async () => {
      const h = harness();
      const src = path.join(h.appRoot, 'src');
      const inside = await call(h, { action: 'run', command: 'ls', cwd: src });
      assert.equal(inside.result.cwd, src);
      assert.equal(h.runs[0].task.execution.options.cwd, src);
      const other = await call(h, { action: 'run', command: 'ls', cwd: h.otherAppRoot });
      assert.equal(other.result.cwd, h.otherAppRoot, 'any folder of the window, not only the application');

      assert.equal((await errorOf(call(h, { action: 'run', command: 'ls', cwd: os.tmpdir() }))).code, 'PATH_OUTSIDE_WORKSPACE');
      assert.equal((await errorOf(call(h, { action: 'run', command: 'ls', cwd: path.join(h.appRoot, '..', '..') }))).code, 'PATH_OUTSIDE_WORKSPACE');
      assert.equal((await errorOf(call(h, { action: 'run', command: 'ls', cwd: 'src' }))).code, 'INVALID_ARGUMENT');
      assert.equal((await errorOf(call(h, { action: 'run', command: 'ls', cwd: path.join(h.appRoot, 'missing') }))).code, 'INVALID_ARGUMENT');
      assert.equal((await errorOf(call(h, { action: 'run', command: 'ls', cwd: path.join(h.appRoot, 'src', '..', 'CMakeLists.txt') }))).code, 'INVALID_ARGUMENT');
      assert.equal(h.runs.length, 2);
    });
  });

  describe('confirmation', () => {
    /** The tool set to Ask, as the core preset has it. */
    const asking = () => {
      const h = harness();
      h.confirmActions = ['command'];
      return h;
    };

    it('asks under Ask with the command category, showing the command and where it runs', async () => {
      const h = asking();
      h.answers.push('allow');
      const result = await call(h, { action: 'run', command: 'west boards --name "nrf*"' });
      assert.equal(h.asked.length, 1);
      assert.equal(h.asked[0], `The AI agent "test-agent" wants to run "west boards --name \\"nrf*\\"" in ${h.appRoot}.`);
      assert.deepEqual(result.confirmation, { category: 'command', outcome: 'allowed' });
      assert.equal(result.status, 'succeeded');
    });

    it('never runs a command the user declined', async () => {
      const h = asking();
      h.answers.push(undefined);
      const error = await errorOf(call(h, { action: 'run', command: 'rm -rf build' }));
      assert.equal(error.code, 'USER_DENIED');
      assert.deepEqual([h.runs, h.jobs.list()], [[], []]);
    });

    it('lets Allow for This Session cover the commands of that application only', async () => {
      const h = asking();
      (h as unknown as { apps: unknown[] }).apps.push(makeApp(h.otherAppRoot, 'hello', h.wsRoot));
      h.answers.push('session');
      const first = await call(h, { action: 'run', command: 'west boards', app_path: h.appRoot });
      assert.deepEqual(first.confirmation, { category: 'command', outcome: 'allowed-session' });
      const second = await call(h, { action: 'run', command: 'python gen.py', app_path: h.appRoot, config_name: 'debug' });
      assert.deepEqual(second.confirmation, { category: 'command', outcome: 'remembered' });
      assert.equal(h.asked.length, 1);

      h.answers.push('allow');
      await call(h, { action: 'run', command: 'west boards', app_path: h.otherAppRoot });
      h.answers.push('allow');
      await call(h, { action: 'run', command: 'west list', west_workspace: h.wsRoot });
      assert.equal(h.asked.length, 3, 'another application and the west workspace are asked about');
      assert.match(h.asked[2], /wants to run "west list" in /);
    });

    it('never takes a late answer to one command for another', async () => {
      const h = asking();
      h.answers.push('allow');
      await call(h, { action: 'run', command: 'west boards' });
      h.answers.push(undefined);
      assert.equal((await errorOf(call(h, { action: 'run', command: 'west list' }))).code, 'USER_DENIED');
      assert.equal(h.asked.length, 2);
    });

    it('does not ask under full, and names no confirmation', async () => {
      const h = harness();
      h.confirmActions = [];
      const result = await call(h, { action: 'run', command: 'west boards' });
      assert.deepEqual(h.asked, []);
      assert.equal(result.confirmation, undefined);
      assert.equal(result.status, 'succeeded');
    });

    it('cuts a long command in the dialog, and keeps it whole in the job', async () => {
      const h = asking();
      h.answers.push('allow');
      const command = `python gen.py ${'--flag '.repeat(80)}--last`;
      const result = await call(h, { action: 'run', command });
      assert.ok(h.asked[0].includes(`"${command.slice(0, DIALOG_COMMAND_CHARS)}"... (${command.length} characters`), h.asked[0]);
      assert.ok(!h.asked[0].includes('--last'));
      assert.ok(h.details[0].includes(`Command: "${command}"`), 'the detail shows it whole, to its last characters');
      assert.equal(result.command, command);
      assert.ok(h.runs[0].task.execution.commandLine.includes(`${command}`));
    });

    it('refuses before asking a command too long for the dialog to show whole, and lets it run when nobody is asked', async () => {
      const h = asking();
      const ascii = `echo ${'x'.repeat(3970)}; echo TAILMARKER`;
      // Beyond ASCII, each character takes six in the dialog.
      const accented = `echo "${'\u00e9'.repeat(335)}"; Remove-Item -Recurse -Force $HOME\\Documents`;
      for (const command of [ascii, accented]) {
        const error = await errorOf(call(h, { action: 'run', command }));
        assert.equal(error.code, 'INVALID_ARGUMENT', command.slice(0, 20));
        assert.match(error.message, /too long to show whole in the confirmation dialog/);
        assert.match(error.hint ?? '', /script file/);
      }
      assert.deepEqual([h.asked, h.runs], [[], []]);

      h.confirmActions = [];
      const result = await call(h, { action: 'run', command: ascii });
      assert.equal(result.status, 'succeeded', 'no dialog, nothing to show');
    });

    it('shows a short command in the message alone', async () => {
      const h = asking();
      h.answers.push('allow');
      await call(h, { action: 'run', command: 'west boards' });
      assert.ok(!h.details[0].includes('Command:'), h.details[0]);
    });

    it('escapes control characters in the dialog, which shows every line of the command', async () => {
      const h = asking();
      h.answers.push('allow');
      await call(h, { action: 'run', command: 'west boards\necho \u001b[2Jdone' });
      assert.match(h.asked[0], /run "west boards\\necho \\u001b\[2Jdone" in/);
    });
  });

  describe('the task', () => {
    it('bash: sources the env script in C:/ form, then runs the command, with the terminal environment', async () => {
      const h = harness();
      const result = await call(h, { action: 'run', command: 'west boards | head -3' });
      const { task, options } = h.runs[0];
      const script = posix(path.join(h.root, 'tools', 'env.sh'));
      assert.equal(task.execution.commandLine, `. '${script}' && west boards | head -3`);
      assert.equal(task.execution.options.executable, '/bin/bash');
      assert.deepEqual(task.execution.options.shellArgs, ['-c']);
      assert.deepEqual(task.execution.options.env, {
        ZEPHYR_BASE: path.join(h.wsRoot, 'zephyr'), BOARD: 'nrf52840dk/nrf52840', PYTHON_VENV_PATH: path.join(h.wsRoot, '.venv'),
      });
      assert.equal(task.name, 'blinky (primary) Command');
      assert.equal(task.definition.type, 'zephyr-workbench-shell');
      assert.equal(options.header, '> [agent test-agent] west boards | head -3');
      assert.equal(options.reveal, vscode.TaskRevealKind.Never);
      assert.deepEqual(h.groupShells, ['/bin/bash'], 'the environment is built for the terminal shell');
      assert.equal(result.result.shell, 'bash');
    });

    it('PowerShell: sources env.ps1 and carries the exit code out with $LASTEXITCODE', async () => {
      const h = harness();
      h.shell = { path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' };
      const result = await call(h, { action: 'run', command: 'west boards' });
      const { task } = h.runs[0];
      const script = path.join(h.root, 'tools', 'env.ps1');
      assert.equal(task.execution.commandLine,
        `try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {} ; . '${script}' ; $global:LASTEXITCODE = 0 ; west boards\n`
        + '$zwOk = $? ; if ($LASTEXITCODE) { exit $LASTEXITCODE } ; if (-not $zwOk) { exit 1 }');
      assert.deepEqual(task.execution.options.shellArgs, ['-Command']);
      assert.equal(result.result.shell, 'powershell');
    });

    it('hands the command to the shell verbatim, so ${env:NAME} is the shell\'s to expand', async () => {
      const h = harness();
      h.shell = { path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' };
      await call(h, { action: 'run', command: 'Write-Output ${env:ZEPHYR_BASE}' });
      const { task } = h.runs[0];
      assert.equal(task.definition[VERBATIM_COMMAND_MARKER], true);
      assert.ok(task.execution.commandLine.includes('; Write-Output ${env:ZEPHYR_BASE}\n'));
    });

    it('cmd: calls env.bat, whose exit code chain ends with the command\'s, and refuses a second line', async () => {
      const h = harness();
      h.shell = { path: 'C:\\Windows\\System32\\cmd.exe' };
      h.envSetting = path.join(h.root, 'tools', 'env.ps1');
      const result = await call(h, { action: 'run', command: 'west boards' });
      const { task } = h.runs[0];
      const script = path.join(h.root, 'tools', 'env.bat');
      // cmd would expand %NAME% in the command before env.bat set it, so an inner cmd reads it from the environment.
      assert.equal(task.execution.commandLine, `call "${script}" && cmd /d /v:on /s /c "cmd /d /v:off /s /c "!ZW_RUN_COMMAND!""`);
      assert.equal(task.execution.options.env.ZW_RUN_COMMAND, 'west boards');
      assert.equal(task.execution.options.env.BOARD, 'nrf52840dk/nrf52840');
      assert.deepEqual(task.execution.options.shellArgs, ['/d', '/c']);
      assert.equal(result.result.shell, 'cmd');
      assert.equal((await errorOf(call(h, { action: 'run', command: 'west boards\nwest list' }))).code, 'INVALID_ARGUMENT');
    });

    it('gives every run a task of its own, so two runs of one command never share a job', async () => {
      const h = harness();
      h.behaviour = 'until-stopped';
      const first = await call(h, { action: 'run', command: 'west boards', wait_sec: 0 });
      const second = await call(h, { action: 'run', command: 'west boards', wait_sec: 0 });
      assert.notEqual(first.job_id, second.job_id);
      assert.equal(second.attached, undefined);
      assert.notEqual(h.runs[0].task.definition.__commandId, h.runs[1].task.definition.__commandId);
    });
  });

  describe('the job', () => {
    it('is a run job with the redacted command, the exit code and the output, never parsed for diagnostics', async () => {
      const h = harness();
      h.behaviour = { exitCode: 3, output: 'main.c:1:1: error: nope\n' };
      const result = await call(h, { action: 'run', command: 'python gen.py --token s3cr3t' });
      assert.equal(result.kind, 'run');
      assert.equal(result.status, 'failed');
      assert.equal(result.exit_code, 3);
      assert.equal(result.command, 'python gen.py --token <redacted>');
      assert.match(result.log.tail, /error: nope/);
      assert.equal(result.diagnostics, undefined);
      assert.deepEqual(result.result, { shell: 'bash', cwd: h.appRoot, timed_out: false });
      assert.ok(h.runs[0].task.execution.commandLine.includes('--token s3cr3t'), 'the command itself runs unchanged');
      const job = h.jobs.list()[0];
      assert.match(job.spec.lockKey, /^command:[0-9a-f]+$/);
      // No build folder: every job naming one conflicts with a build writing it.
      assert.deepEqual([job.spec.buildDir, job.spec.westWorkspace, job.spec.venvPath, job.spec.writes],
        [undefined, h.wsRoot, path.join(h.wsRoot, '.venv'), undefined]);
    });

    it('stops the command at timeout_sec and says it timed out', async () => {
      const h = harness();
      h.behaviour = 'until-stopped';
      const result = await call(h, { action: 'run', command: 'python loop.py', timeout_sec: 1, wait_sec: 10 });
      assert.equal(h.runs[0].signal.aborted, true);
      assert.equal(result.status, 'failed');
      assert.equal(result.result.timed_out, true);
      assert.match(result.next, /Stopped after 1 seconds by timeout_sec/);
      assert.match(result.log.tail, /Stopped after 1 seconds/);
    });

    it('hands back a running job naming its shell, and job cancel stops the command', async () => {
      const h = harness();
      h.behaviour = 'until-stopped';
      const result = await call(h, { action: 'run', command: 'python server.py', wait_sec: 0 });
      assert.equal(result.status, 'running');
      assert.deepEqual(result.result, { shell: 'bash', cwd: h.appRoot, timed_out: false });
      h.jobs.cancel(result.job_id);
      await until(() => h.runs[0].signal.aborted);
      const job = h.jobs.get(result.job_id) as { done: Promise<void> };
      await job.done;
      assert.equal(h.jobs.view(h.jobs.get(result.job_id) as never).status, 'cancelled');
    });

    it('only reads what it names: a build in the same folder goes on, a west update of the workspace refuses it', async () => {
      const h = harness();
      let release: () => void = () => undefined;
      const blocker = () => new Promise<{ exitCode: number }>(resolve => { release = () => resolve({ exitCode: 0 }); });
      h.jobs.start({
        kind: 'build', lockKey: h.buildDir, requestKey: 'build', buildDir: h.buildDir, westWorkspace: h.wsRoot,
        command: 'west build', run: blocker,
      });
      const alongside = await call(h, { action: 'run', command: 'west boards' });
      assert.equal(alongside.status, 'succeeded');
      release();
      await until(() => h.jobs.list().every(job => job.status !== 'running'));

      h.confirmActions = ['command'];
      h.answers.push('allow');
      h.jobs.start({
        kind: 'west', lockKey: h.wsRoot, requestKey: 'update', westWorkspace: h.wsRoot, writes: ['west_workspace'],
        command: 'west update', run: blocker,
      });
      const busy = await errorOf(call(h, { action: 'run', command: 'west boards' }));
      assert.equal(busy.code, 'BUSY');
      assert.match(busy.hint ?? '', /job \{"action": "status"/);
      assert.deepEqual(h.asked, [], 'refused before the user is asked');
      release();
    });

    it('claims the build folder for a command that builds, which a build of the configuration refuses', async () => {
      const h = harness();
      let release: () => void = () => undefined;
      const blocker = () => new Promise<{ exitCode: number }>(resolve => { release = () => resolve({ exitCode: 0 }); });
      h.jobs.start({
        kind: 'build', lockKey: h.buildDir, requestKey: 'build', buildDir: h.buildDir, westWorkspace: h.wsRoot,
        command: 'west build', run: blocker,
      });
      h.confirmActions = ['command'];
      for (const command of ['west build -t rom_report', 'ninja', 'cmake --build .', 'west build -p always']) {
        const busy = await errorOf(call(h, { action: 'run', command }));
        assert.equal(busy.code, 'BUSY', command);
        assert.match(busy.message, /is using the build folder this command builds in/, command);
      }
      assert.deepEqual([h.asked, h.runs], [[], []], 'refused before the user is asked');
      release();
      await until(() => h.jobs.list().every(job => job.status !== 'running'));

      h.confirmActions = [];
      h.behaviour = 'until-stopped';
      const running = await call(h, { action: 'run', command: 'west build -t rom_report', wait_sec: 0 });
      const job = h.jobs.get(running.job_id) as { spec: { buildDir?: string; writes?: readonly string[] } };
      assert.deepEqual([job.spec.buildDir, job.spec.writes], [h.buildDir, ['build_dir']]);
      assert.throws(() => h.jobs.start({
        kind: 'build', lockKey: h.buildDir, requestKey: 'build-2', buildDir: h.buildDir, command: 'west build', run: blocker,
      }), (error: McpToolError) => error.code === 'BUSY', 'a build_app started meanwhile waits for it');
    });

    it('claims the venv as written for a pip install, which a build using that venv refuses', async () => {
      const h = harness();
      let release: () => void = () => undefined;
      const blocker = () => new Promise<{ exitCode: number }>(resolve => { release = () => resolve({ exitCode: 0 }); });
      const venv = path.join(h.wsRoot, '.venv');
      h.jobs.start({
        kind: 'build', lockKey: h.buildDir, requestKey: 'build', buildDir: h.buildDir, westWorkspace: h.wsRoot, venvPath: venv,
        command: 'west build', run: blocker,
      });
      h.confirmActions = ['command'];
      for (const command of ['pip install -U pyocd', 'python -m pip install pyocd', 'pip3 uninstall -y pyocd', 'bash -c "pip install pyocd"']) {
        const busy = await errorOf(call(h, { action: 'run', command }));
        assert.equal(busy.code, 'BUSY', command);
        assert.match(busy.message, /is using the Python environment this command changes/, command);
      }
      assert.deepEqual([h.asked, h.runs], [[], []], 'refused before the user is asked');
      // pip that only reads runs beside the build.
      h.confirmActions = [];
      assert.equal((await call(h, { action: 'run', command: 'pip list' })).status, 'succeeded');
      release();
      await until(() => h.jobs.list().every(job => job.status !== 'running'));

      h.behaviour = 'until-stopped';
      const running = await call(h, { action: 'run', command: 'pip install -U pyocd', wait_sec: 0 });
      const job = h.jobs.get(running.job_id) as { spec: { venvPath?: string; writes?: readonly string[] } };
      assert.deepEqual([job.spec.venvPath, job.spec.writes], [venv, ['venv']]);
      assert.throws(() => h.jobs.start({
        kind: 'build', lockKey: h.buildDir, requestKey: 'build-2', buildDir: h.buildDir, venvPath: venv, command: 'west build', run: blocker,
      }), (error: McpToolError) => error.code === 'BUSY', 'a build_app started meanwhile waits for it');
    });

    it('refuses a build while the user runs a task on the configuration, and lets a command that only reads run', async () => {
      const h = harness();
      const saved = stub.tasks.taskExecutions;
      stub.tasks.taskExecutions = [{
        task: {
          name: 'West Build', definition: { type: 'zephyr-workbench', __appRootPath: h.appRoot, config: 'primary' },
          scope: undefined, group: { id: 'build' },
        },
      }];
      try {
        h.confirmActions = ['command'];
        const busy = await errorOf(call(h, { action: 'run', command: 'west build -p always' }));
        assert.equal(busy.code, 'BUSY_EXTERNAL');
        assert.match(busy.message, /"West Build" is running for primary/);
        assert.deepEqual([h.asked, h.runs], [[], []], 'refused before the user is asked');
        h.confirmActions = [];
        assert.equal((await call(h, { action: 'run', command: 'west boards' })).status, 'succeeded');
      } finally {
        stub.tasks.taskExecutions = saved;
      }
    });

    it('refuses a build when the user started a task on the configuration while the dialog was open', async () => {
      const h = harness();
      const saved = stub.tasks.taskExecutions;
      h.confirmActions = ['command'];
      h.answers.push('allow');
      const confirmations = h.deps.confirmations;
      const require = confirmations.require.bind(confirmations);
      confirmations.require = (async (...params: Parameters<typeof require>) => {
        const outcome = await require(...params);
        stub.tasks.taskExecutions = [{
          task: {
            name: 'West Build', definition: { type: 'zephyr-workbench', __appRootPath: h.appRoot, config: 'primary' },
            scope: undefined, group: { id: 'build' },
          },
        }];
        return outcome;
      }) as typeof confirmations.require;
      try {
        const busy = await errorOf(call(h, { action: 'run', command: 'west build' }));
        assert.equal(busy.code, 'BUSY_EXTERNAL');
        assert.equal(h.asked.length, 1);
        assert.deepEqual(h.runs, [], 'nothing ran');
      } finally {
        stub.tasks.taskExecutions = saved;
      }
    });
  });

  describe('env', () => {
    it('writes a script for the terminal shell under the MCP home, without asking, and says how to use it', async () => {
      const h = harness();
      fs.mkdirSync(h.buildDir, { recursive: true });
      const result = await call(h, { action: 'env' });
      assert.deepEqual(h.asked, [], 'env runs nothing, so it never asks');
      assert.equal(path.dirname(result.path), h.envDir);
      assert.match(path.basename(result.path), /^blinky-primary-[0-9a-f]{12}\.sh$/);
      assert.equal(result.shell, 'bash');
      assert.equal(result.usage, `bash '${posix(result.path)}' west boards`);
      assert.doesNotMatch(result.next, /-DNAME/, 'only PowerShell splits -NAME:VALUE');
      assert.equal(result.env_script, posix(path.join(h.root, 'tools', 'env.sh')));
      assert.deepEqual(result.variables, ['ZEPHYR_BASE', 'BOARD', 'PYTHON_VENV_PATH']);
      assert.equal(result.cwd_default, h.buildDir);
      const text = fs.readFileSync(result.path, 'utf8');
      assert.match(text, /^#!\/usr\/bin\/env bash\n/);
      assert.match(text, /^export BOARD="nrf52840dk\/nrf52840"$/m);
      assert.match(text, /^ {2}"\$@"$/m);
      if (process.platform !== 'win32') {
        assert.equal(fs.statSync(result.path).mode & 0o777, 0o700);
        assert.equal(fs.statSync(h.envDir).mode & 0o777, 0o700);
      }
      assert.deepEqual(fs.readdirSync(h.envDir), [path.basename(result.path)], 'no temporary file is left behind');
      assert.deepEqual(h.runs, []);
    });

    it('keeps one file per target and shell, rewritten on each call', async () => {
      const h = harness();
      const first = await call(h, { action: 'env' });
      fs.writeFileSync(first.path, 'stale');
      const again = await call(h, { action: 'env' });
      assert.equal(again.path, first.path);
      assert.notEqual(fs.readFileSync(again.path, 'utf8'), 'stale');
      // cmd reopens a running batch file by name, so an unchanged script is left alone.
      const past = new Date('2020-01-01T00:00:00Z');
      fs.utimesSync(first.path, past, past);
      await call(h, { action: 'env' });
      assert.equal(fs.statSync(first.path).mtimeMs, past.getTime(), 'the same content is not written again');
      const other = await call(h, { action: 'env', config_name: 'debug' });
      const zsh = await call(h, { action: 'env', shell: 'zsh' });
      const workspace = await call(h, { action: 'env', west_workspace: h.wsRoot });
      assert.equal(new Set([first.path, other.path, zsh.path, workspace.path]).size, 4);
      assert.match(path.basename(workspace.path), /^zephyrproject-[0-9a-f]{12}\.sh$/);
      assert.equal(workspace.cwd_default, h.wsRoot);
    });

    it('writes each shell\'s script, with the environment built for that shell', async () => {
      const h = harness();
      h.envSetting = path.join(h.root, 'tools', 'env.sh');
      const ps = await call(h, { action: 'env', shell: 'powershell' });
      assert.match(ps.path, /\.ps1$/);
      assert.equal(ps.env_script, path.join(h.root, 'tools', 'env.ps1'));
      assert.match(ps.usage, / -NoProfile -ExecutionPolicy Bypass -File ".*\.ps1" west boards$/);
      assert.match(ps.next, /write CMake options as -DNAME=value, not -DNAME:TYPE=value/);
      assert.match(fs.readFileSync(ps.path, 'utf8'), /^\$env:BOARD = 'nrf52840dk\/nrf52840'$/m);
      const cmd = await call(h, { action: 'env', shell: 'cmd' });
      assert.match(cmd.path, /\.bat$/);
      assert.equal(cmd.env_script, path.join(h.root, 'tools', 'env.bat'));
      assert.equal(cmd.usage, `"${cmd.path}" west boards`);
      assert.match(fs.readFileSync(cmd.path, 'utf8'), /^set "BOARD=nrf52840dk\/nrf52840"\r$/m);
      assert.deepEqual(h.groupShells, ['powershell.exe', 'cmd.exe']);
      assert.equal((await errorOf(call(h, { action: 'env', shell: 'fish' }))).code, 'INVALID_ARGUMENT');
    });

    it('defaults to the shell of the VS Code terminal', async () => {
      const h = harness();
      h.shell = { path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' };
      const result = await call(h, { action: 'env' });
      assert.equal(result.shell, 'powershell');
      assert.match(result.usage, /^pwsh -NoProfile/);
    });
  });
});
