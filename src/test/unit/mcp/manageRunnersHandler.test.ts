// manage_runners and remove_or_delete what "pyocd_packs" on the host side:
// the real job manager, confirmation gate and env.yml writers, over a fake
// runner manifest and an env.yml in a temporary folder. The installers, the
// sudo prompt and pyocd are stood in for, so nothing is downloaded,
// installed or elevated.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import yaml from 'yaml';
import { findTool, TOOL_CATALOG } from '../../../mcp/core/catalog';
import { McpToolError } from '../../../mcp/core/errors';
import { ConfirmCategory, permissionForCategories, ToolContext } from '../../../mcp/core/toolSpec';
import { AskAnswer, Confirmations } from '../../../mcp/host/confirmations';
import { HostDeps } from '../../../mcp/host/handlers/deps';
import { manageRunners } from '../../../mcp/host/handlers/manageRunners';
import { pyocdMissingHint } from '../../../mcp/host/handlers/runnerToolsView';
import { removeOrDelete } from '../../../mcp/host/handlers/removals';
import { runnerTools } from '../../../mcp/host/runnerTools';
import { HostServices } from '../../../mcp/host/services';
import { JobManager } from '../../../mcp/jobs/jobManager';
import { collectDebugToolsStatus } from '../../../utils/debugTools/debugToolStatusUtils';
import type { HostDebugToolsInstallPlan } from '../../../utils/installUtils';
import { FAKE_MANIFEST } from './runnerManifestFixture';
import { useUiGuard } from './uiGuard';

interface Harness {
  root: string;
  jobs: JobManager;
  deps: HostDeps;
  asked: Array<{ message: string; detail: string; offerSession: boolean }>;
  answers: AskAnswer[];
  confirmActions: ConfirmCategory[];
  /** What the stand-ins were asked to do. */
  calls: string[];
  tasks: vscode.Task[];
  statusDepths: string[];
  pyocd: {
    version?: string; index?: boolean; packs: Array<{ pack: string; version?: string }>;
    available: boolean[]; dryPacks: string[][]; failUpdate?: boolean;
  };
  taskExit: number | undefined;
  elevateExit: number;
}

let saved: typeof runnerTools;
let savedPyocd: typeof runnerTools.pyocd;
let savedPortable: string | undefined;

function harness(): Harness {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-runners-')));
  process.env.VSCODE_PORTABLE = root;
  fs.mkdirSync(path.join(root, '.zinstaller'), { recursive: true });
  fs.writeFileSync(path.join(root, '.zinstaller', 'env.yml'), yaml.stringify({ global: { version: 1 }, runners: { jlink: { version: '9.54' } } }));
  const services = new HostServices(vscode.Uri.file(os.tmpdir()));
  const jobs = new JobManager({ logPathFor: id => path.join(root, `${id}.log`) });
  const h: Harness = {
    root, jobs, asked: [], answers: [], confirmActions: ['install', 'delete'], calls: [], tasks: [], statusDepths: [],
    pyocd: { version: '0.38.0', index: true, packs: [{ pack: 'Keil.STM32F4xx_DFP', version: '2.17.1' }], available: [], dryPacks: [] },
    taskExit: 0, elevateExit: 0,
    deps: undefined as unknown as HostDeps,
  };
  services.debugToolsManifest = () => FAKE_MANIFEST;
  services.debugToolsStatus = async (depth, opts = {}) => {
    h.statusDepths.push(depth);
    return collectDebugToolsStatus({ manifest: FAKE_MANIFEST, toolIds: opts.toolIds, probe: false });
  };
  const confirmations = new Confirmations({
    permission: tool => permissionForCategories(tool, h.confirmActions),
    waitMs: () => 2000,
    log: { recordConfirmation: () => undefined },
    ask: async (message, detail, offerSession) => {
      h.asked.push({ message, detail, offerSession });
      return h.answers.shift();
    },
  });
  h.deps = {
    services, jobs, confirmations,
    defaultWaitSeconds: 5,
    revealTerminal: 'never',
    permissionOf: tool => permissionForCategories(tool, h.confirmActions),
    kconfig: {} as HostDeps['kconfig'],
    extensionContext: { extensionUri: vscode.Uri.file(path.join(root, 'ext')) } as HostDeps['extensionContext'],
    folders: {} as HostDeps['folders'],
    refreshViews: async () => undefined,
    servedTools: () => new Set(TOOL_CATALOG.map(tool => tool.name)),
  };

  runnerTools.platform = () => 'win32';
  runnerTools.guiSudo = () => ({ available: true });
  runnerTools.envSourcedReady = () => false;
  runnerTools.globalVenv = () => path.join(root, 'global-venv');
  runnerTools.allowPowershellScripts = async () => { h.calls.push('policy'); return true; };
  runnerTools.installTask = (nonRoot: NonNullable<HostDebugToolsInstallPlan['nonRoot']>) =>
    new vscode.Task({ type: 'zephyr-workbench-shell' }, vscode.TaskScope.Workspace, 'Installing Host debug tools', 'Zephyr Workbench',
      new vscode.ShellExecution(nonRoot.command, nonRoot.shellOpts));
  runnerTools.runTask = (async (task: vscode.Task, sink: { onData(text: string): void }) => {
    h.tasks.push(task);
    sink.onData(`ran ${(task.execution as vscode.ShellExecution).commandLine}\n`);
    return { exitCode: h.taskExit, started: true };
  }) as typeof runnerTools.runTask;
  runnerTools.runStep = (async (_name: string, sink: { onData(text: string): void }, signal: AbortSignal,
    work: (log: (text: string) => void, signal: AbortSignal, channels: unknown) => Promise<unknown>) =>
    work(text => sink.onData(text), signal, {})) as typeof runnerTools.runStep;
  runnerTools.elevate = async (command: string) => { h.calls.push(`elevate ${command}`); return h.elevateExit; };
  runnerTools.afterInstall = async (_context: unknown, ids: readonly string[]) => { h.calls.push(`after ${ids.join(',')}`); };
  runnerTools.pyocd = {
    version: async () => h.pyocd.version,
    hasIndex: async () => h.pyocd.index,
    installedPacks: async () => h.pyocd.packs,
    targets: async () => [],
    dryRunInstall: async (pattern: string) => { h.calls.push(`dry ${pattern}`); return h.pyocd.dryPacks.shift() ?? []; },
    updateIndex: async (opts: { show?: boolean }) => {
      h.calls.push(`update show=${opts.show}`);
      if (h.pyocd.failUpdate) {
        throw new Error('pyocd exited with code 1: network down');
      }
      h.pyocd.index = true;
      return '';
    },
    clean: async (opts: { show?: boolean }) => { h.calls.push(`clean show=${opts.show}`); h.pyocd.packs = []; h.pyocd.index = false; return ''; },
    targetOps: {
      checkTarget: async (name: string, venv?: string) => { h.calls.push(`check ${name}${venv ? ` ${venv}` : ''}`); return h.pyocd.available.shift() ?? false; },
      dryRunInstall: async (pattern: string) => { h.calls.push(`dry ${pattern}`); return h.pyocd.dryPacks.shift() ?? []; },
      updateIndex: async () => { h.calls.push('update'); return ''; },
      install: async (name: string, opts: { show?: boolean }) => { h.calls.push(`install ${name} show=${opts.show}`); return ''; },
    },
  } as unknown as typeof runnerTools.pyocd;
  return h;
}

function ctx(h: Harness, tool = 'manage_runners'): ToolContext<HostDeps> {
  return {
    signal: new AbortController().signal,
    progress: () => undefined,
    client: { name: 'test-agent', version: '1', instance: 'agent-1' },
    deps: h.deps,
    tool: findTool(tool)!,
    startedAt: Date.now(),
    audit: {},
  };
}

const call = (h: Harness, args: Record<string, unknown>) => manageRunners(args, ctx(h)) as Promise<any>;
const remove = (h: Harness, args: Record<string, unknown>) => removeOrDelete({ what: 'pyocd_packs', ...args }, ctx(h, 'remove_or_delete')) as Promise<any>;

async function errorOf(promise: Promise<unknown>): Promise<McpToolError> {
  try {
    await promise;
  } catch (error) {
    return error as McpToolError;
  }
  throw new Error('expected the call to fail');
}

function envYml(h: Harness): any {
  return yaml.parse(fs.readFileSync(path.join(h.root, '.zinstaller', 'env.yml'), 'utf8'));
}

describe('mcp/host/handlers/manageRunners', function () {
  this.timeout(20000);
  useUiGuard();
  let h: Harness;

  beforeEach(() => {
    saved = { ...runnerTools };
    savedPyocd = runnerTools.pyocd;
    savedPortable = process.env.VSCODE_PORTABLE;
    h = harness();
  });

  afterEach(() => {
    Object.assign(runnerTools, saved);
    runnerTools.pyocd = savedPyocd;
    if (savedPortable === undefined) {
      delete process.env.VSCODE_PORTABLE;
    } else {
      process.env.VSCODE_PORTABLE = savedPortable;
    }
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  describe('arguments', () => {
    it('refuses an unknown action and an argument the action does not take', async () => {
      assert.equal((await errorOf(call(h, { action: 'uninstall' }))).code, 'INVALID_ARGUMENT');
      const cases: Array<Record<string, unknown>> = [
        { action: 'install', tools: ['nrfutil'], path: 'C:\\x' },
        { action: 'set_path', tool: 'jlink', path: '', pack: 'stm32' },
        { action: 'set_path', tool: 'jlink', path: '', wait_sec: 5 },
        { action: 'set_default', tool: 'openocd-esp32', add_to_path: true },
        { action: 'set_add_to_path', tool: 'jlink', add_to_path: true, extra_paths: { add: [] } },
        { action: 'extra_paths', extra_paths: { add: [h.root] }, tool: 'jlink' },
        { action: 'pyocd_update_index', tools: ['pyocd'] },
        { action: 'pyocd_install_pack', pyocd_target: 'stm32f429zitx', accept_license: true },
      ];
      for (const args of cases) {
        const error = await errorOf(call(h, args));
        assert.equal(error.code, 'INVALID_ARGUMENT', JSON.stringify(args));
        assert.match(error.message, /does not take/, JSON.stringify(args));
      }
      assert.equal(h.asked.length, 0);
    });
  });

  describe('install', () => {
    it('refuses an unknown tool, listing the valid names', async () => {
      const error = await errorOf(call(h, { action: 'install', tools: ['nrfutil', 'openocdd'] }));
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.match(error.message, /openocdd/);
      const available = error.details?.available as string[];
      for (const name of ['openocd', 'jlink', 'nrfutil', 'stlink_gdbserver']) {
        assert.ok(available.includes(name), name);
      }
    });

    it('refuses a tool that does not install on this OS, saying where it does', async () => {
      const error = await errorOf(call(h, { action: 'install', tools: ['udev-rules'] }));
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.deepEqual(error.details?.installs_on, { 'udev-rules': ['linux'] });
      assert.equal(h.tasks.length, 0);
    });

    it('refuses tools with pack, and a call with neither', async () => {
      assert.match((await errorOf(call(h, { action: 'install', tools: ['nrfutil'], pack: 'stm32' }))).message, /not both/);
      assert.match((await errorOf(call(h, { action: 'install' }))).message, /needs tools or pack/);
      const error = await errorOf(call(h, { action: 'install', pack: 'arm' }));
      assert.deepEqual(error.details?.packs, ['stm32', 'esp32']);
    });

    it('never installs a tool only its vendor ships: it returns the vendor page and asks nothing', async () => {
      const result = await call(h, { action: 'install', tools: ['stm32cubeprogrammer', 'stlink_gdbserver'] });
      assert.deepEqual(result.installed, []);
      assert.deepEqual(result.vendor_pages.map((page: { id: string }) => page.id), ['stm32cubeprogrammer', 'stm32cubeclt']);
      assert.equal(result.vendor_pages[0].website, 'https://www.st.com/en/development-tools/stm32cubeprog.html');
      assert.equal(result.vendor_pages[0].reason, 'detect_only');
      assert.match(result.next, /manage_runners \{"action": "set_path"/);
      assert.equal(h.asked.length, 0);
      assert.equal(h.tasks.length, 0);
      assert.equal(h.jobs.list().length, 0);
    });

    it('expands a pack: tools this OS installs, vendor pages, and the rest skipped, in a dry run that asks nothing', async () => {
      const result = await call(h, { action: 'install', pack: 'stm32', accept_license: true, dry_run: true });
      assert.equal(result.dry_run, true);
      assert.deepEqual(result.tools.map((tool: { id: string }) => tool.id), ['openocd-zephyr', 'jlink']);
      assert.deepEqual(result.vendor_pages.map((page: { id: string }) => page.id), ['stm32cubeprogrammer']);
      assert.deepEqual(result.skipped, ['udev-rules']);
      assert.equal(result.needs_admin, true);
      assert.equal(result.admin_prompt, 'uac');
      assert.equal(result.confirmation_required, true, 'J-Link is always asked about');
      assert.match(result.command, /^powershell -File ".*install-debug-tools\.ps1" {2}-D ".*" -Tools {2}openocd-zephyr,jlink$/);
      assert.equal(h.asked.length, 0);
      assert.equal(h.tasks.length, 0);
      assert.equal(h.jobs.list().length, 0);
    });

    it('refuses J-Link without accept_license, before asking the user anything', async () => {
      const error = await errorOf(call(h, { action: 'install', tools: ['jlink'] }));
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.match(error.message, /SEGGER J-Link terms of use/);
      assert.match(error.hint ?? '', /Ask the user whether they accept the SEGGER J-Link terms of use.*accept_license true/);
      assert.equal(h.asked.length, 0);
    });

    it('asks about J-Link every time, even when installs are allowed, and never offers the session', async () => {
      h.confirmActions = [];
      h.answers.push('allow');
      const result = await call(h, { action: 'install', tools: ['jlink'], accept_license: true });
      assert.equal(h.asked.length, 1);
      assert.match(h.asked[0].message, /install the runner tools J-Link Software and accept the SEGGER J-Link terms of use on your behalf/);
      assert.equal(h.asked[0].offerSession, false);
      assert.match(h.asked[0].detail, /always asked/);
      assert.equal(result.status, 'succeeded');
      assert.deepEqual(result.confirmation, { category: 'install', outcome: 'allowed' });
      assert.equal(h.tasks.length, 1);
      assert.match((h.tasks[0].execution as vscode.ShellExecution).commandLine!, /-Tools {2}jlink$/);
      assert.deepEqual(h.calls, ['policy', 'after jlink']);
      assert.deepEqual(result.result.tools.map((tool: { id: string }) => tool.id), ['jlink']);
    });

    it('installs through the alias default, runs the installer as a job and reports the tools afterwards', async () => {
      fs.mkdirSync(path.join(h.root, '.zinstaller', 'tools', 'openocds', 'openocd-zephyr', 'bin'), { recursive: true });
      h.answers.push('allow');
      const result = await call(h, { action: 'install', tools: ['openocd', 'nrfutil'] });
      assert.equal(result.kind, 'install');
      assert.equal(result.status, 'succeeded');
      assert.match(h.asked[0].message, /install the runner tools OpenOCD Zephyr, nRF Util\.$/);
      assert.match(h.asked[0].detail, /install actions on the runners of this machine/);
      const tools = result.result.tools as Array<{ id: string; installed: boolean | null; path?: string }>;
      assert.equal(tools.find(tool => tool.id === 'openocd-zephyr')?.installed, true);
      assert.ok(tools.find(tool => tool.id === 'openocd-zephyr')?.path?.endsWith('bin'));
      assert.match(result.log.tail, /ran powershell -File/);
      assert.deepEqual(h.calls, ['policy', 'after openocd-zephyr,nrfutil']);
    });

    it('keeps an Allow for This Session for the runners of the machine, except for J-Link', async () => {
      h.answers.push('session');
      await call(h, { action: 'install', tools: ['nrfutil'] });
      const second = await call(h, { action: 'install', tools: ['openocd-esp32'] });
      assert.equal(h.asked.length, 1);
      assert.equal(h.asked[0].offerSession, true);
      assert.deepEqual(second.confirmation, { category: 'install', outcome: 'remembered' });
      h.answers.push('allow');
      await call(h, { action: 'install', tools: ['jlink'], accept_license: true });
      assert.equal(h.asked.length, 2, 'a license accepted for the user is asked about every time');
    });

    it('points a custom OpenOCD at the path of its alias, and a driver whose path is found alone at nothing', async () => {
      const custom = await call(h, { action: 'install', tools: ['openocd-custom'] });
      assert.equal(custom.vendor_pages[0].path_tool, 'openocd');
      assert.match(custom.next, /"tool": "openocd"/);
      runnerTools.platform = () => 'linux';
      const esp32 = await call(h, { action: 'install', pack: 'esp32', dry_run: true });
      assert.deepEqual(esp32.vendor_pages, [{
        id: 'cp210x', name: 'CP210x drivers', website: 'https://www.silabs.com/developer-tools/usb-to-uart-bridge-vcp-drivers', reason: 'not_for_this_os',
      }]);
    });

    it('refuses a second runner job before asking while one runs, and joins an identical one', async () => {
      h.confirmActions = [];
      let release: (() => void) | undefined;
      runnerTools.runTask = (async () => {
        await new Promise<void>(resolve => { release = resolve; });
        return { exitCode: 0, started: true };
      }) as typeof runnerTools.runTask;
      const first = await call(h, { action: 'install', tools: ['nrfutil'], wait_sec: 0 });
      assert.equal(first.status, 'running');
      h.confirmActions = ['install'];
      const busy = await errorOf(call(h, { action: 'pyocd_update_index' }));
      assert.equal(busy.code, 'BUSY');
      assert.equal(busy.details?.job_id, first.job_id);
      const again = await call(h, { action: 'install', tools: ['nrfutil'], wait_sec: 0 });
      assert.equal(again.attached, true);
      assert.equal(h.asked.length, 0);
      const deadline = Date.now() + 3000;
      while (!release && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      release!();
      await (h.jobs.get(first.job_id) as { done: Promise<void> }).done;
    });

    it('installs nothing when the user declines', async () => {
      h.answers.push(undefined);
      const error = await errorOf(call(h, { action: 'install', tools: ['nrfutil'] }));
      assert.equal(error.code, 'USER_DENIED');
      assert.equal(h.tasks.length, 0);
      assert.equal(h.jobs.list().length, 0);
    });

    it('asks nothing and runs nothing in a dry run', async () => {
      const result = await call(h, { action: 'install', tools: ['nrfutil', 'stm32cubeprogrammer'], dry_run: true });
      assert.deepEqual(result.tools.map((tool: { id: string }) => tool.id), ['nrfutil']);
      assert.deepEqual(result.vendor_pages.map((page: { id: string }) => page.id), ['stm32cubeprogrammer']);
      assert.equal(result.needs_admin, false);
      assert.equal(result.confirmation_required, true);
      assert.equal(h.asked.length, 0);
      assert.equal(h.tasks.length, 0);
      assert.deepEqual(h.calls, []);
    });

    it('reports a failed installer, with its exit code, as a failed job', async () => {
      h.confirmActions = [];
      h.taskExit = 2;
      const result = await call(h, { action: 'install', tools: ['nrfutil'] });
      assert.equal(result.status, 'failed');
      assert.equal(result.exit_code, 2);
      assert.match(result.result.error, /exited with code 2/);
      assert.match(result.next, /failed/);
      assert.deepEqual(h.calls, ['policy', 'after nrfutil'], 'the runner settings are refreshed whatever the outcome');
    });

    it('fails the job when the installer exits 0 but a tool is still not found, and only warns when it cannot tell', async () => {
      // The installers go on after a tool script fails and exit 0 all the same.
      h.confirmActions = [];
      let installed: boolean | null = false;
      h.deps.services.debugToolsStatus = async () => [
        { id: 'pyocd', isAlias: false, installableHere: true, installed, updateAvailable: false },
      ];
      const failed = await call(h, { action: 'install', tools: ['pyocd'] });
      assert.equal(failed.status, 'failed');
      assert.match(failed.result.error, /pyocd is still not found; see the log/);
      assert.equal(failed.result.warnings, undefined);
      assert.match(failed.next, /job \{"action": "log"/);
      installed = null;
      const unknown = await call(h, { action: 'install', tools: ['pyocd'] });
      assert.equal(unknown.status, 'succeeded');
      assert.match(unknown.result.warnings, /pyocd could not be confirmed yet/);
      assert.equal(unknown.result.error, undefined);
      assert.doesNotMatch(unknown.next, /tools are installed/);
    });

    it('refuses a root tool on Linux when no graphical sudo prompt can be shown', async () => {
      runnerTools.platform = () => 'linux';
      runnerTools.guiSudo = () => ({ available: false, reason: 'headless' });
      const error = await errorOf(call(h, { action: 'install', tools: ['udev-rules', 'nrfutil'] }));
      assert.equal(error.code, 'INTERACTIVE_UNSUPPORTED');
      assert.match(error.hint ?? '', /Install Runners/);
      assert.deepEqual(error.details?.needs_admin, ['udev-rules']);
      assert.equal(h.asked.length, 0);
      assert.equal(h.tasks.length, 0);
    });

    it('elevates the root tools on Linux with the graphical prompt, and installs the others in the Zephyr environment', async () => {
      runnerTools.platform = () => 'linux';
      h.confirmActions = [];
      const result = await call(h, { action: 'install', tools: ['udev-rules', 'nrfutil'] });
      assert.equal(result.status, 'succeeded');
      const elevated = h.calls.find(line => line.startsWith('elevate '))!;
      assert.match(elevated, /install-debug-tools\.sh {2}-D \S+ udev-rules$/);
      assert.equal(h.tasks.length, 1);
      assert.match((h.tasks[0].execution as vscode.ShellExecution).commandLine!, /install-debug-tools\.sh {2}-D \S+ nrfutil$/);
      assert.ok(!h.calls.includes('policy'), 'the PowerShell policy is a Windows matter');
    });

    it('fails the job when the elevated install fails', async () => {
      runnerTools.platform = () => 'linux';
      h.confirmActions = [];
      h.elevateExit = 1;
      const result = await call(h, { action: 'install', tools: ['udev-rules'] });
      assert.equal(result.status, 'failed');
      assert.match(result.result.error, /root-required runners \(udev-rules\) failed or the sudo prompt was dismissed/);
      assert.equal(h.tasks.length, 0);
    });

    it('reports a missing environment script before asking', async () => {
      runnerTools.installTask = () => { throw new Error('Missing Zephyr environment script.', { cause: 'zephyr-workbench.pathToEnvScript' }); };
      const error = await errorOf(call(h, { action: 'install', tools: ['nrfutil'] }));
      assert.equal(error.code, 'ENV_NOT_READY');
      assert.equal(h.asked.length, 0);
    });

    it('stops at the PowerShell policy on Windows without running the installer', async () => {
      h.confirmActions = [];
      runnerTools.allowPowershellScripts = async () => false;
      const result = await call(h, { action: 'install', tools: ['nrfutil'] });
      assert.equal(result.status, 'failed');
      assert.match(result.result.error, /RemoteSigned/);
      assert.equal(h.tasks.length, 0);
    });
  });

  describe('settings in env.yml', () => {
    it('refuses to edit env.yml before the host tools created it', async () => {
      fs.rmSync(path.join(h.root, '.zinstaller', 'env.yml'));
      const error = await errorOf(call(h, { action: 'set_path', tool: 'jlink', path: h.root }));
      assert.equal(error.code, 'ENV_NOT_READY');
      assert.equal(h.asked.length, 0);
    });

    it('records and clears the path of a tool, asking as an install on the runners of the machine', async () => {
      h.answers.push('allow', 'allow');
      const result = await call(h, { action: 'set_path', tool: 'jlink', path: h.root });
      assert.match(h.asked[0].message, /record .* as the path of J-Link Software/);
      assert.deepEqual(result.confirmation, { category: 'install', outcome: 'allowed' });
      assert.equal(envYml(h).runners.jlink.path, h.root.replace(/\\/g, '/'));
      assert.equal(envYml(h).runners.jlink.version, '9.54');
      assert.equal(result.stored.path, h.root.replace(/\\/g, '/'));
      const cleared = await call(h, { action: 'set_path', tool: 'jlink', path: '' });
      assert.deepEqual(cleared.stored, {});
      assert.equal(envYml(h).runners, undefined);
    });

    it('says what clearing the path of an alias also forgets: its variant and add_to_path false', async () => {
      const envFile = path.join(h.root, '.zinstaller', 'env.yml');
      fs.writeFileSync(envFile, yaml.stringify({
        global: { version: 1 }, runners: { openocd: { path: h.root.replace(/\\/g, '/'), default: 'openocd-esp32', do_not_use: true } },
      }));
      const dry = await call(h, { action: 'set_path', tool: 'openocd', path: '', dry_run: true });
      assert.deepEqual([...dry.removed].sort(), ['default', 'do_not_use', 'path']);
      assert.equal(dry.default_now, 'openocd-zephyr');
      assert.equal(h.asked.length, 0);
      h.answers.push('allow');
      const result = await call(h, { action: 'set_path', tool: 'openocd', path: '' });
      assert.match(h.asked[0].message, /its chosen variant openocd-esp32, so openocd goes back to openocd-zephyr/);
      assert.match(h.asked[0].message, /add_to_path false setting, so Zephyr terminals put it on PATH again/);
      assert.deepEqual([...result.removed].sort(), ['default', 'do_not_use', 'path']);
      assert.equal(result.default_now, 'openocd-zephyr');
      assert.equal(envYml(h).runners, undefined);
    });

    it('refuses a program file as the path: the environment scripts put the path itself on PATH', async () => {
      const program = path.join(h.root, 'JLink.exe');
      fs.writeFileSync(program, '');
      const before = fs.readFileSync(path.join(h.root, '.zinstaller', 'env.yml'), 'utf8');
      const error = await errorOf(call(h, { action: 'set_path', tool: 'jlink', path: program }));
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.match(error.message, /not an existing folder/);
      assert.match(error.hint ?? '', /folder that holds the program/);
      assert.equal(fs.readFileSync(path.join(h.root, '.zinstaller', 'env.yml'), 'utf8'), before);
      assert.equal(h.asked.length, 0);
    });

    it('sets the path of an alias, and refuses a variant, a no_edit tool and an unknown id', async () => {
      h.confirmActions = [];
      await call(h, { action: 'set_path', tool: 'openocd', path: h.root });
      assert.equal(envYml(h).runners.openocd.path, h.root.replace(/\\/g, '/'));
      const variant = await errorOf(call(h, { action: 'set_path', tool: 'openocd-custom', path: h.root }));
      assert.match(variant.message, /variant of "openocd"/);
      assert.match(variant.hint ?? '', /set_default/);
      assert.match((await errorOf(call(h, { action: 'set_path', tool: 'pyocd', path: h.root }))).message, /finds pyOCD on its own/);
      const unknown = await errorOf(call(h, { action: 'set_path', tool: 'segger', path: h.root }));
      assert.ok((unknown.details?.available as string[]).includes('openocd'));
    });

    it('refuses a relative path, a missing one, and characters the environment scripts would expand', async () => {
      for (const bad of ['relative/dir', path.join(h.root, 'missing'), path.join(h.root, '$(whoami)'), path.join(h.root, '%PATH%')]) {
        const error = await errorOf(call(h, { action: 'set_path', tool: 'jlink', path: bad }));
        assert.equal(error.code, 'INVALID_ARGUMENT', bad);
      }
      const parens = path.join(h.root, 'Program Files (x86)');
      fs.mkdirSync(parens);
      h.confirmActions = [];
      await call(h, { action: 'set_path', tool: 'jlink', path: parens });
      assert.equal(envYml(h).runners.jlink.path, parens.replace(/\\/g, '/'));
      assert.equal(h.asked.length, 0);
    });

    it('dry runs a path change without asking or writing', async () => {
      const result = await call(h, { action: 'set_path', tool: 'jlink', path: h.root, dry_run: true });
      assert.equal(result.dry_run, true);
      assert.equal(result.confirmation_required, true);
      assert.equal(envYml(h).runners.jlink.path, undefined);
      assert.equal(h.asked.length, 0);
    });

    it('picks the variant of an alias, and refuses a tool that is not a variant', async () => {
      h.answers.push('allow');
      const result = await call(h, { action: 'set_default', tool: 'openocd-esp32' });
      assert.equal(result.alias, 'openocd');
      assert.equal(result.previous_default, 'openocd-zephyr');
      assert.equal(envYml(h).runners.openocd.default, 'openocd-esp32');
      assert.match(h.asked[0].message, /make OpenOCD ESP32 the openocd/);
      const again = await call(h, { action: 'set_default', tool: 'openocd-esp32' });
      assert.equal(again.unchanged, true);
      assert.equal(h.asked.length, 1, 'nothing to change, nothing to ask');
      const error = await errorOf(call(h, { action: 'set_default', tool: 'jlink' }));
      assert.ok((error.details?.variants as string[]).includes('openocd-zephyr'));
    });

    it('stores add_to_path as do_not_use', async () => {
      h.confirmActions = [];
      const off = await call(h, { action: 'set_add_to_path', tool: 'jlink', add_to_path: false });
      assert.equal(envYml(h).runners.jlink.do_not_use, true);
      assert.equal(off.add_to_path, false);
      await call(h, { action: 'set_add_to_path', tool: 'jlink', add_to_path: true });
      assert.equal(envYml(h).runners.jlink.do_not_use, false);
      assert.match((await errorOf(call(h, { action: 'set_add_to_path', tool: 'jlink' }))).message, /needs add_to_path/);
      assert.match((await errorOf(call(h, { action: 'set_add_to_path', tool: 'cp210x', add_to_path: false }))).message, /on its own/);
    });

    it('edits the extra runner folders as a list', async () => {
      h.confirmActions = [];
      const a = path.join(h.root, 'a');
      const b = path.join(h.root, 'b');
      fs.mkdirSync(a);
      fs.mkdirSync(b);
      const slash = (p: string) => p.replace(/\\/g, '/');
      let result = await call(h, { action: 'extra_paths', extra_paths: { add: [a, b, a] } });
      assert.deepEqual(result.extra_paths, [slash(a), slash(b)]);
      result = await call(h, { action: 'extra_paths', extra_paths: { remove: [b] } });
      assert.deepEqual(result.extra_paths, [slash(a)]);
      assert.deepEqual(envYml(h).other.EXTRA_RUNNERS.path, [slash(a)]);
      result = await call(h, { action: 'extra_paths', extra_paths: { set: [] } });
      assert.deepEqual(result.extra_paths, []);
      assert.equal(envYml(h).other, undefined);
      const unknown = await errorOf(call(h, { action: 'extra_paths', extra_paths: { remove: [b] } }));
      assert.match(unknown.message, /not in the list/);
      assert.match((await errorOf(call(h, { action: 'extra_paths', extra_paths: { set: [a], add: [b] } }))).message, /cannot be combined/);
      const file = path.join(h.root, 'file.txt');
      fs.writeFileSync(file, '');
      assert.match((await errorOf(call(h, { action: 'extra_paths', extra_paths: { add: [file] } }))).message, /not an existing folder/);
      assert.match((await errorOf(call(h, { action: 'extra_paths', extra_paths: {} }))).message, /needs set, add or remove/);
    });
  });

  describe('pyOCD packs', () => {
    it('refuses when pyOCD is not installed, naming the install', async () => {
      h.pyocd.version = undefined;
      const error = await errorOf(call(h, { action: 'pyocd_update_index' }));
      assert.equal(error.code, 'RUNNER_TOOL_MISSING');
      assert.match(error.hint ?? '', /"tools": \["pyocd"\]/);
    });

    it('updates the pack index as a job, never revealing the output channel', async () => {
      h.pyocd.index = false;
      const dry = await call(h, { action: 'pyocd_update_index', dry_run: true });
      assert.equal(dry.pack_index, false);
      assert.equal(h.asked.length, 0);
      h.answers.push('allow');
      const result = await call(h, { action: 'pyocd_update_index' });
      assert.equal(result.status, 'succeeded');
      assert.equal(result.result.pack_index, true);
      assert.deepEqual(h.calls, ['update show=false']);
      assert.match(h.asked[0].message, /pyocd pack update/);
    });

    it('fails the index job with what pyocd said', async () => {
      h.confirmActions = [];
      h.pyocd.failUpdate = true;
      const result = await call(h, { action: 'pyocd_update_index' });
      assert.equal(result.status, 'failed');
      assert.match(result.result.error, /network down/);
    });

    it('refuses a target name that is not one', async () => {
      assert.match((await errorOf(call(h, { action: 'pyocd_install_pack', pyocd_target: 'stm32 f4; rm' }))).message, /pyOCD target name/);
    });

    it('answers without asking when pyOCD already supports the target', async () => {
      h.pyocd.available = [true];
      const result = await call(h, { action: 'pyocd_install_pack', pyocd_target: 'stm32f429zitx' });
      assert.equal(result.already_available, true);
      assert.equal(h.asked.length, 0);
      assert.equal(h.jobs.list().length, 0);
    });

    it('dry runs from the local index only, and says when the index is missing', async () => {
      h.pyocd.dryPacks = [['Keil.STM32F4xx_DFP.2.17.1']];
      const withIndex = await call(h, { action: 'pyocd_install_pack', pyocd_target: 'stm32f429zitx', dry_run: true });
      assert.deepEqual(withIndex.packs, ['Keil.STM32F4xx_DFP.2.17.1']);
      h.pyocd.index = false;
      const calls = h.calls.length;
      const without = await call(h, { action: 'pyocd_install_pack', pyocd_target: 'stm32f429zitx', dry_run: true });
      assert.equal(without.packs, undefined);
      assert.match(without.notes[0], /never downloaded/);
      assert.ok(!h.calls.slice(calls).some(line => line.startsWith('dry ')), 'no dry run may download the index');
      assert.equal(h.asked.length, 0);
    });

    it('installs the pack of a target as a job and checks pyOCD knows it afterwards', async () => {
      h.pyocd.available = [false, false, true];
      h.pyocd.dryPacks = [['Keil.STM32F4xx_DFP.2.17.1']];
      h.answers.push('allow');
      const result = await call(h, { action: 'pyocd_install_pack', pyocd_target: 'stm32f429zitx' });
      assert.equal(result.status, 'succeeded');
      assert.deepEqual(result.result.packs, ['Keil.STM32F4xx_DFP.2.17.1']);
      assert.ok(h.calls.includes('install stm32f429zitx show=false'));
      assert.match(h.asked[0].message, /pyocd pack install stm32f429zitx/);
    });

    it('fails the job when no pack provides the target', async () => {
      h.confirmActions = [];
      h.pyocd.available = [false, false];
      const result = await call(h, { action: 'pyocd_install_pack', pyocd_target: 'nosuchchip' });
      assert.equal(result.status, 'failed');
      assert.match(result.result.error, /No CMSIS pack provides the pyOCD target nosuchchip/);
      assert.ok(h.calls.includes('update'), 'a stale index is refreshed once');
    });

    it('takes the target of the board of a build, and says when the build has none yet', async () => {
      const appRoot = path.join(h.root, 'app');
      const config = {
        name: 'primary', active: true, boardIdentifier: 'nucleo_f429zi',
        getBuildDir: () => path.join(appRoot, 'build', 'primary'),
        getBuildArtifactPath: () => undefined,
        getPyOCDTarget: () => 'stm32f429zitx',
      };
      const app = { appRootPath: appRoot, appName: 'app', venvPath: path.join(h.root, 'venv'), appWorkspaceFolder: { uri: { fsPath: appRoot }, name: 'app', index: 0 }, buildConfigs: [config] };
      h.deps.services.listApplications = async () => [app] as never;
      h.deps.services.knownRoots = async () => [appRoot];
      h.pyocd.available = [true];
      const known = await call(h, { action: 'pyocd_install_pack', app_path: appRoot });
      assert.equal(known.target, 'stm32f429zitx');
      assert.equal(known.venv_path, path.join(h.root, 'venv'));
      assert.ok(h.calls.includes(`check stm32f429zitx ${path.join(h.root, 'venv')}`), 'checked in the venv the debug session uses');
      config.getPyOCDTarget = () => undefined as unknown as string;
      const error = await errorOf(call(h, { action: 'pyocd_install_pack', app_path: appRoot }));
      assert.equal(error.code, 'NOT_BUILT');
    });

    it('sends a pyOCD missing from the venv of an application to an installer of that venv, not to the global install', async () => {
      const appRoot = path.join(h.root, 'app');
      const venv = path.join(h.root, 'venv');
      const config = {
        name: 'primary', active: true, boardIdentifier: 'nucleo_f429zi',
        getBuildDir: () => path.join(appRoot, 'build', 'primary'),
        getBuildArtifactPath: () => undefined,
        getPyOCDTarget: () => 'stm32f429zitx',
      };
      const app = { appRootPath: appRoot, appName: 'app', venvPath: venv, appWorkspaceFolder: { uri: { fsPath: appRoot }, name: 'app', index: 0 }, buildConfigs: [config] };
      h.deps.services.listApplications = async () => [app] as never;
      h.deps.services.knownRoots = async () => [appRoot];
      h.pyocd.version = undefined;
      const error = await errorOf(call(h, { action: 'pyocd_install_pack', app_path: appRoot }));
      assert.equal(error.code, 'RUNNER_TOOL_MISSING');
      assert.ok(error.hint?.includes(`the global Python environment ${path.join(h.root, 'global-venv')} only, not in ${venv}`), error.hint);
      assert.ok(error.hint?.includes(`manage_app {"action":"create_venv","app_path":${JSON.stringify(appRoot)}}`), error.hint);
      assert.ok(error.hint?.includes(`run_command {"action":"run","app_path":${JSON.stringify(appRoot)},"command":"pip install -U pyocd"}`), error.hint);
      assert.ok(error.hint!.indexOf('manage_app') < error.hint!.indexOf('run_command'), 'the installer that claims the venv comes first');
      assert.doesNotMatch(error.hint ?? '', /"tools": \["pyocd"\]/);
    });

    it('sends a pyOCD missing from the venv of a west workspace to install_python_deps, naming run_command only when it is served', () => {
      const venv = path.join(h.root, 'ws', '.venv');
      const owner = { appPath: path.join(h.root, 'ws', 'app'), westWorkspace: path.join(h.root, 'ws') };
      const served = pyocdMissingHint(ctx(h), venv, owner);
      assert.ok(served.includes(`manage_west_workspace ${JSON.stringify({ action: 'install_python_deps', west_workspace: owner.westWorkspace })}`), served);
      assert.ok(served.indexOf('install_python_deps') < served.indexOf('run_command'), served);
      assert.doesNotMatch(served, /manage_app/);

      h.deps.servedTools = () => new Set(TOOL_CATALOG.map(tool => tool.name).filter(name => name !== 'run_command' && name !== 'manage_west_workspace'));
      const unserved = pyocdMissingHint(ctx(h), venv, owner);
      assert.doesNotMatch(unserved, /run_command/);
      assert.match(unserved, /allow manage_west_workspace in the AI Manager, whose action "install_python_deps" installs it/);
      assert.match(pyocdMissingHint(ctx(h), undefined), /manage_runners \{"action": "install", "tools": \["pyocd"\]\}/);
    });
  });

  describe('remove_or_delete pyocd_packs', () => {
    it('lists what would go in a dry run, and refuses an argument it does not take', async () => {
      const dry = await remove(h, { dry_run: true });
      assert.deepEqual(dry.packs, [{ pack: 'Keil.STM32F4xx_DFP', version: '2.17.1' }]);
      assert.equal(dry.confirmation_required, true);
      assert.equal(h.asked.length, 0);
      assert.equal((await errorOf(remove(h, { app_path: h.root }))).code, 'INVALID_ARGUMENT');
    });

    it('deletes the index and the packs as a job after asking as a deletion', async () => {
      h.answers.push('allow');
      const result = await remove(h, {});
      assert.equal(result.kind, 'clean');
      assert.equal(result.status, 'succeeded');
      assert.deepEqual(result.result.removed_packs, ['Keil.STM32F4xx_DFP']);
      assert.deepEqual(result.confirmation, { category: 'delete', outcome: 'allowed' });
      assert.match(h.asked[0].message, /delete the pyOCD pack index and every installed CMSIS pack \(1 pack\)/);
      assert.deepEqual(h.calls, ['clean show=false']);
    });

    it('asks nothing when there is nothing to delete', async () => {
      h.pyocd.packs = [];
      h.pyocd.index = false;
      const result = await remove(h, {});
      assert.equal(result.removed, false);
      assert.equal(h.asked.length, 0);
    });
  });
});
