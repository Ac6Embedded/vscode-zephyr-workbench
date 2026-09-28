// The runner tool side of list_runners: the tools behind the runners of a
// build, the pyOCD state, and every tool of the manifest, read from a fake
// manifest, an env.yml in a temporary folder and a stand-in for pyocd. It must
// run no installer, download nothing and show no UI.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import yaml from 'yaml';
import { findTool, TOOL_CATALOG } from '../../../mcp/core/catalog';
import { McpToolError } from '../../../mcp/core/errors';
import { ToolContext } from '../../../mcp/core/toolSpec';
import { listRunners } from '../../../mcp/host/handlers/artifacts';
import { HostDeps } from '../../../mcp/host/handlers/deps';
import { runnerTools } from '../../../mcp/host/runnerTools';
import { HostServices } from '../../../mcp/host/services';
import { collectDebugToolsStatus } from '../../../utils/debugTools/debugToolStatusUtils';
import { PyOCDTargetInfo } from '../../../utils/execUtils';
import { getPyOcdTargetFromRunnersYaml, readRunnersYamlFile } from '../../../utils/zephyr/runnersYamlUtils';
import { FAKE_MANIFEST } from './runnerManifestFixture';
import { useUiGuard } from './uiGuard';

const RUNNERS_YAML = `
runners: [openocd, jlink, pyocd, stlink_gdbserver, blackmagicprobe]
flash-runner: openocd
debug-runner: openocd
args:
  pyocd: ['--dt-flash=y', '--target=stm32f429zitx']
`;

interface Harness {
  root: string;
  appRoot: string;
  deps: HostDeps;
  statusCalls: Array<{ depth: string; toolIds?: readonly string[] }>;
  pyocd: { version?: string; index?: boolean; targets: PyOCDTargetInfo[]; venvs: Array<string | undefined> };
}

function harness(built = true): Harness {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-list-runners-')));
  process.env.VSCODE_PORTABLE = root;
  fs.mkdirSync(path.join(root, '.zinstaller'), { recursive: true });
  fs.writeFileSync(path.join(root, '.zinstaller', 'env.yml'), yaml.stringify({
    global: { version: 1 },
    runners: { jlink: { path: 'C:/SEGGER/JLink', do_not_use: true } },
    other: { EXTRA_RUNNERS: { path: ['C:/extra/runners'] } },
  }));
  const appRoot = path.join(root, 'app');
  const buildDir = path.join(appRoot, 'build', 'primary');
  const runnersYaml = path.join(buildDir, 'zephyr', 'runners.yaml');
  fs.mkdirSync(path.dirname(runnersYaml), { recursive: true });
  if (built) {
    fs.writeFileSync(runnersYaml, RUNNERS_YAML);
  }
  const artifact = (...parts: string[]) => {
    const file = path.join(buildDir, ...parts);
    return fs.existsSync(file) ? file : undefined;
  };
  const config = {
    name: 'primary', active: true, boardIdentifier: 'nucleo_f429zi', defaultRunner: '', customArgs: '',
    getBuildDir: () => buildDir,
    getBuildArtifactPath: (_app: unknown, ...parts: string[]) => artifact(...parts),
    getDomainBuildArtifactPath: (_app: unknown, _domain: unknown, ...parts: string[]) => artifact(...parts),
    getPyOCDTarget: () => getPyOcdTargetFromRunnersYaml(readRunnersYamlFile(runnersYaml)),
  };
  const app = { appRootPath: appRoot, appName: 'app', venvPath: path.join(root, 'venv'), appWorkspaceFolder: { uri: { fsPath: appRoot }, name: 'app', index: 0 }, buildConfigs: [config] };
  const services = new HostServices(vscode.Uri.file(os.tmpdir()));
  services.listApplications = async () => [app] as never;
  services.knownRoots = async () => [appRoot];
  const h: Harness = {
    root, appRoot, statusCalls: [],
    pyocd: { version: '0.38.0', index: false, targets: [], venvs: [] },
    deps: {
      services, jobs: {} as HostDeps['jobs'], confirmations: {} as HostDeps['confirmations'],
      defaultWaitSeconds: 5, revealTerminal: 'never', permissionOf: () => 'allow',
      kconfig: {} as HostDeps['kconfig'], extensionContext: {} as HostDeps['extensionContext'], folders: {} as HostDeps['folders'],
      refreshViews: async () => undefined, servedTools: () => new Set(TOOL_CATALOG.map(tool => tool.name)),
    },
  };
  services.debugToolsManifest = () => FAKE_MANIFEST;
  services.debugToolsStatus = async (depth, opts = {}) => {
    h.statusCalls.push({ depth, toolIds: opts.toolIds });
    return collectDebugToolsStatus({ manifest: FAKE_MANIFEST, toolIds: opts.toolIds, probe: false });
  };
  runnerTools.platform = () => 'win32';
  runnerTools.envSourcedReady = () => false;
  runnerTools.globalVenv = () => undefined;
  runnerTools.pyocd = {
    ...runnerTools.pyocd,
    version: async (venv?: string) => { h.pyocd.venvs.push(venv); return h.pyocd.version; },
    hasIndex: async () => h.pyocd.index,
    installedPacks: async () => [{ pack: 'Keil.STM32F4xx_DFP', version: '2.17.1' }],
    targets: async () => h.pyocd.targets,
    dryRunInstall: async () => { throw new Error('list_runners must never resolve packs: that may download the index'); },
    updateIndex: async () => { throw new Error('list_runners must never download the index'); },
  } as typeof runnerTools.pyocd;
  return h;
}

function ctx(h: Harness): ToolContext<HostDeps> {
  return {
    signal: new AbortController().signal, progress: () => undefined, client: { name: 'test-agent' },
    deps: h.deps, tool: findTool('list_runners')!, startedAt: Date.now(), audit: {},
  };
}

const call = (h: Harness, args: Record<string, unknown>) => listRunners(args, ctx(h)) as Promise<any>;

async function errorOf(promise: Promise<unknown>): Promise<McpToolError> {
  try {
    await promise;
  } catch (error) {
    return error as McpToolError;
  }
  throw new Error('expected the call to fail');
}

describe('mcp/host/handlers/artifacts list_runners (runner tools)', function () {
  this.timeout(20000);
  useUiGuard();
  let h: Harness;
  let saved: typeof runnerTools;
  let savedPortable: string | undefined;

  beforeEach(() => {
    saved = { ...runnerTools };
    savedPortable = process.env.VSCODE_PORTABLE;
    h = harness();
  });

  afterEach(() => {
    Object.assign(runnerTools, saved);
    if (savedPortable === undefined) {
      delete process.env.VSCODE_PORTABLE;
    } else {
      process.env.VSCODE_PORTABLE = savedPortable;
    }
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('keeps its plain answer when nothing is included', async () => {
    const result = await call(h, {});
    assert.deepEqual(result.runners.map((runner: { name: string }) => runner.name), ['openocd', 'jlink', 'pyocd', 'stlink_gdbserver', 'blackmagicprobe']);
    assert.equal(result.runners[0].tools, undefined);
    assert.equal(result.pyocd, undefined);
    assert.equal(h.statusCalls.length, 0);
  });

  it('adds the tool behind each runner, with its state, path and what to do when it is missing', async () => {
    fs.mkdirSync(path.join(h.root, '.zinstaller', 'tools', 'openocds', 'openocd-zephyr', 'bin'), { recursive: true });
    const result = await call(h, { include: ['tools'] });
    const byName = new Map(result.runners.map((runner: { name: string }) => [runner.name, runner]));
    const openocd = (byName.get('openocd') as any).tools[0];
    assert.equal(openocd.id, 'openocd');
    assert.equal(openocd.default_tool, 'openocd-zephyr');
    assert.equal(openocd.installed, true);
    assert.ok(openocd.path.endsWith('bin'));
    const jlink = (byName.get('jlink') as any).tools[0];
    assert.equal(jlink.path, 'C:/SEGGER/JLink', 'the configured path');
    const clt = (byName.get('stlink_gdbserver') as any).tools[0];
    assert.equal(clt.id, 'stm32cubeclt');
    assert.equal(clt.installed, false);
    assert.match(clt.hint, /installed by the user from its vendor \(https:\/\/www\.st\.com/);
    assert.match(clt.hint, /manage_runners \{"action": "set_path"/);
    assert.match((byName.get('blackmagicprobe') as any).tools_note, /does not manage a tool/);
    assert.deepEqual([...h.statusCalls[0].toolIds!].sort(), ['jlink', 'openocd', 'pyocd', 'stm32cubeclt']);
    assert.equal(h.statusCalls[0].depth, 'quick', 'no version command without the Zephyr environment');
    assert.match(result.tools_note, /filesystem only/);
  });

  it('hints the install of a missing tool the workbench installs', async () => {
    const result = await call(h, { include: ['tools'] });
    const openocd = result.runners.find((runner: { name: string }) => runner.name === 'openocd').tools[0];
    assert.equal(openocd.installed, false);
    assert.equal(openocd.hint, 'Install it with manage_runners {"action": "install", "tools": ["openocd"]}.');
  });

  it('probes the versions when the Zephyr environment can be sourced', async () => {
    runnerTools.envSourcedReady = () => true;
    const result = await call(h, { include: ['tools'] });
    assert.equal(h.statusCalls[0].depth, 'full');
    assert.equal(result.tools_note, undefined);
  });

  it('adds the pyOCD state from the venv of the debug session, the board target and a target search, without downloading', async () => {
    h.pyocd.targets = [
      { name: 'stm32f429zitx', vendor: 'STMicroelectronics', partNumber: 'STM32F429ZITx', source: 'pack' },
      ...Array.from({ length: 60 }, (_, i) => ({ name: `stm32f4${i.toString().padStart(2, '0')}xx`, vendor: 'STMicroelectronics', source: 'pack' })),
      { name: 'nrf52840', vendor: 'Nordic Semiconductor', source: 'builtin' },
    ];
    const result = await call(h, { include: ['pyocd'], pyocd_target: 'STM32F4' });
    const pyocd = result.pyocd;
    assert.equal(pyocd.installed, true);
    assert.equal(pyocd.version, '0.38.0');
    assert.equal(pyocd.venv_path, path.join(h.root, 'venv'));
    assert.deepEqual(h.pyocd.venvs, [path.join(h.root, 'venv')]);
    assert.equal(pyocd.pack_index, false);
    assert.match(pyocd.notes.join(' '), /never downloaded.*pyocd_install_pack/);
    assert.deepEqual(pyocd.installed_packs, [{ pack: 'Keil.STM32F4xx_DFP', version: '2.17.1' }]);
    assert.deepEqual(pyocd.board, { target: 'stm32f429zitx', available: true, source: 'pack' });
    assert.equal(pyocd.search.total, 61);
    assert.equal(pyocd.search.targets.length, 50);
    const nordic = await call(h, { include: ['pyocd'], pyocd_target: 'nordic' });
    assert.deepEqual(nordic.pyocd.search.targets, [{ name: 'nrf52840', vendor: 'Nordic Semiconductor', source: 'builtin' }]);
  });

  it('says how to get support for a board target pyOCD does not know', async () => {
    h.pyocd.targets = [{ name: 'nrf52840', source: 'builtin' }];
    const result = await call(h, { include: ['pyocd'] });
    assert.equal(result.pyocd.board.available, false);
    assert.match(result.pyocd.board.hint, /manage_runners \{"action": "pyocd_install_pack", "pyocd_target": "stm32f429zitx"\}/);
  });

  it('says pyOCD is missing, with the install to make in the venv that was checked', async () => {
    h.pyocd.version = undefined;
    const result = await call(h, { include: ['pyocd'] });
    assert.equal(result.pyocd.installed, false);
    // manage_runners install only reaches the global venv, not the one of the application.
    assert.ok(result.pyocd.hint.includes(`not in ${path.join(h.root, 'venv')}`), result.pyocd.hint);
    // An installer that claims the venv comes first; run_command only after it.
    assert.ok(result.pyocd.hint.includes(`manage_app ${JSON.stringify({ action: 'create_venv', app_path: h.appRoot })}`), result.pyocd.hint);
    assert.ok(result.pyocd.hint.includes(`run_command {"action":"run","app_path":${JSON.stringify(h.appRoot)}`), result.pyocd.hint);
    assert.doesNotMatch(result.pyocd.hint, /"tools": \["pyocd"\]/);
    const global = await call(h, { all_tools: true, include: ['pyocd'] });
    assert.equal(global.pyocd.installed, false);
    assert.match(global.pyocd.hint, /manage_runners \{"action": "install", "tools": \["pyocd"\]\}/);
    // An application on the global venv is fixed by the install.
    runnerTools.globalVenv = () => `${path.join(h.root, 'venv')}${path.sep}`;
    const same = await call(h, { include: ['pyocd'] });
    assert.match(same.pyocd.hint, /manage_runners \{"action": "install", "tools": \["pyocd"\]\}/);
  });

  it('lists every tool of the manifest with all_tools, whatever this OS installs', async () => {
    const result = await call(h, { all_tools: true });
    assert.equal(result.all_tools, true);
    const tools = new Map<string, any>(result.tools.map((tool: { id: string }) => [tool.id, tool]));
    assert.deepEqual([...tools.keys()], (FAKE_MANIFEST.debug_tools ?? []).map(tool => tool.tool));
    const jlink = tools.get('jlink');
    assert.equal(jlink.needs_admin, true);
    assert.deepEqual(jlink.license, { name: 'SEGGER J-Link terms of use', url: 'https://www.segger.com/downloads/jlink/' });
    assert.equal(jlink.configured_path, 'C:/SEGGER/JLink');
    assert.equal(jlink.add_to_path, false, 'do_not_use is true');
    assert.equal(jlink.path_editable, true);
    assert.equal(jlink.reference_version, '9.54');
    assert.deepEqual(tools.get('stm32cubeprogrammer').vendor_download, { website: 'https://www.st.com/en/development-tools/stm32cubeprog.html' });
    assert.equal(tools.get('stm32cubeprogrammer').installable_here, false);
    assert.equal(tools.get('udev-rules').installable_here, false);
    assert.equal(tools.get('cp210x').installable_here, true);
    assert.equal(tools.get('openocd-zephyr').default_for_alias, true);
    assert.equal(tools.get('openocd-zephyr').path_editable, false);
    assert.equal(tools.get('openocd-zephyr').add_to_path, undefined, 'a variant has no PATH setting of its own');
    assert.equal(tools.get('pyocd').path_editable, false);
    assert.deepEqual(result.aliases[0].variants, ['openocd-zephyr', 'openocd-esp32', 'openocd-custom']);
    assert.equal(result.aliases[0].default_tool, 'openocd-zephyr');
    assert.deepEqual(result.packs.map((pack: { pack: string }) => pack.pack), ['stm32', 'esp32']);
    assert.deepEqual(result.extra_paths, ['C:/extra/runners']);
    assert.equal(result.platform, 'win32');
    // Only the tools this OS can run are worth a version command.
    const probed = h.statusCalls.flatMap(call => call.toolIds ?? []);
    assert.ok(probed.includes('udev-rules'), 'still reported');
    assert.equal(result.pyocd, undefined);
  });

  it('adds the pyOCD state to all_tools without a board', async () => {
    const result = await call(h, { all_tools: true, include: ['pyocd'] });
    assert.equal(result.pyocd.installed, true);
    assert.equal(result.pyocd.board, undefined);
    assert.deepEqual(h.pyocd.venvs, [undefined], 'the pyOCD of the host tools');
  });

  it('refuses what all_tools does not take, and a search without include pyocd', async () => {
    assert.match((await errorOf(call(h, { all_tools: true, app_path: h.appRoot }))).message, /does not take app_path/);
    assert.match((await errorOf(call(h, { all_tools: true, include: ['tools'] }))).message, /include "tools"/);
    assert.match((await errorOf(call(h, { pyocd_target: 'stm32' }))).message, /needs include \["pyocd"\]/);
    assert.equal((await errorOf(call(h, { include: ['everything'] }))).code, 'INVALID_ARGUMENT');
    assert.equal((await errorOf(call(h, { include: ['pyocd'], pyocd_target: 'a"b' }))).code, 'INVALID_ARGUMENT');
  });

  it('says the tools need a build when the configuration is not built', async () => {
    fs.rmSync(path.join(h.appRoot, 'build', 'primary', 'zephyr', 'runners.yaml'));
    const result = await call(h, { include: ['tools', 'pyocd'] });
    assert.equal(result.built, false);
    assert.match(result.tools_note, /built configuration only/);
    assert.equal(result.pyocd.board.target, null);
    assert.equal(h.statusCalls.length, 0);
  });
});
