// set_kconfig's register_fragment against configure, both running at once on one
// configuration. The settings writers, the settings lock, the confirmation gate and both
// handlers are the production code; only VS Code's settings store, the application list
// and the Kconfig session are stood in for. The session is held open, as a cold start
// holds it, so configure can change the configuration while set_kconfig waits.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { findTool, TOOL_CATALOG } from '../../../mcp/core/catalog';
import { ToolContext } from '../../../mcp/core/toolSpec';
import { Confirmations } from '../../../mcp/host/confirmations';
import { configure } from '../../../mcp/host/handlers/buildConfigs';
import { HostDeps } from '../../../mcp/host/handlers/deps';
import { setKconfig } from '../../../mcp/host/handlers/kconfig';
import { HostServices } from '../../../mcp/host/services';
import { JobManager } from '../../../mcp/jobs/jobManager';
import { ZephyrApplication } from '../../../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../../../models/ZephyrBuildConfig';
import { findFragmentAssignments } from '../../../utils/kconfig/fragmentStaleness';

const vscodeStub = require('vscode') as Record<string, any>;

class FakeUri {
  constructor(readonly fsPath: string) {}
  static file(fsPath: string): FakeUri { return new FakeUri(fsPath); }
  static joinPath(base: FakeUri, ...parts: string[]): FakeUri { return new FakeUri(path.join(base.fsPath, ...parts)); }
  toString(): string { return `file://${this.fsPath}`; }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Answers the two calls set_kconfig makes, for the one bool symbol these tests assign. */
const client = {
  state: 'ready',
  recentStderr: [] as string[],
  async call(method: string, params: any): Promise<unknown> {
    if (method === 'find') {
      return { found: { LOG: { kind: 'symbol', id: 1, type: 'bool', hasPrompt: true, choice: null, value: 'n', nodeIds: [1] } }, unknown: {} };
    }
    const winner = findFragmentAssignments(params.fragments, ['LOG']).get('LOG')?.slice(-1)[0];
    return {
      ok: true,
      symbols: {
        LOG: {
          userValue: winner?.value ?? null, value: winner?.value ?? 'n', took: true, failure: null, promptless: false,
          assignedAt: winner ? { file: winner.file, line: winner.line } : null,
          missingDeps: [], activeSelectors: [], activeRange: null, choice: null,
        },
      },
      current: { LOG: 'n' }, before: { LOG: 'n' }, newFailures: {}, existingFailures: {}, existingFailuresTotal: 0,
      newWarnings: [], sideEffects: [], sideEffectsTotal: 0, discarded: [], discardedTotal: 0, missingFragments: [],
    };
  },
  async dispose(): Promise<void> { /* nothing to stop */ },
};

describe('set_kconfig registering a fragment while configure changes the configuration', () => {
  let savedGetConfiguration: unknown;
  let savedUri: unknown;
  let root: string;
  let stored: Record<string, any>[];
  let ctx: (tool: string) => ToolContext<HostDeps>;
  /** Lets the held Kconfig session answer. */
  let openSession: () => void;
  let sessionEntered: Promise<void>;

  before(() => {
    savedGetConfiguration = vscodeStub.workspace.getConfiguration;
    savedUri = vscodeStub.Uri;
    vscodeStub.Uri = FakeUri;
  });
  after(() => {
    vscodeStub.workspace.getConfiguration = savedGetConfiguration;
    vscodeStub.Uri = savedUri;
  });

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-kreg-')));
    const app = path.join(root, 'app');
    const buildDir = path.join(app, 'build', 'primary');
    fs.mkdirSync(path.join(buildDir, 'zephyr'), { recursive: true });
    for (const file of ['build.ninja', path.join('zephyr', '.config'), path.join('zephyr', 'edt.pickle')]) {
      fs.writeFileSync(path.join(buildDir, file), '');
    }
    const prj = path.join(app, 'prj.conf');
    fs.writeFileSync(prj, 'CONFIG_GPIO=y\n');
    fs.writeFileSync(path.join(buildDir, 'build_info.yml'),
      ['cmake:', '  kconfig:', '    files:', `     - '${prj}'`, '    user-files:', `     - '${prj}'`, ''].join('\n'));

    const folder = { uri: FakeUri.file(app), name: 'app', index: 0 };
    stored = [{ name: 'primary', board: 'qemu_x86', active: 'true', 'env.EXTRA_CONF_FILE': ['${workspaceFolder}/prj-extra.conf'] }];
    vscodeStub.workspace.getConfiguration = () => ({
      get: (key: string, fallback?: unknown) => (key === 'build.configurations' ? clone(stored) : fallback),
      update: async (key: string, value: unknown) => {
        // A real update lands a moment later, which is when a lost update shows.
        await new Promise(resolve => setTimeout(resolve, 5));
        if (key === 'build.configurations') {
          stored = clone(value) as Record<string, any>[];
        }
      },
      has: () => false,
      inspect: () => undefined,
    });

    const services = new HostServices(vscode.Uri.file(os.tmpdir()));
    services.listApplications = async () => [{
      appRootPath: app, appName: 'app', appWorkspaceFolder: folder, isWestWorkspaceApplication: false,
      intellisenseProvider: 'cpptools', venvPath: undefined, westWorkspaceRootPath: undefined,
      buildConfigs: stored.map(raw => {
        const config = new ZephyrBuildConfig(raw.name);
        config.parseSettings(raw, folder as never);
        return config;
      }),
    } as unknown as ZephyrApplication];
    services.knownRoots = async () => [root];
    services.externalRun = () => undefined;
    services.externalTaskName = () => undefined;

    let entered!: () => void;
    sessionEntered = new Promise(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { openSession = resolve; });
    const deps: HostDeps = {
      services,
      jobs: new JobManager({ logPathFor: id => path.join(root, `${id}.log`) }),
      confirmations: new Confirmations({
        permission: () => 'allow', waitMs: () => 2000, log: { recordConfirmation: () => undefined }, ask: async () => undefined,
      }),
      defaultWaitSeconds: 10,
      revealTerminal: 'never',
      permissionOf: () => 'allow',
      kconfig: {
        use: async (dir: string, _options: unknown, fn: (session: unknown) => Promise<unknown>) => {
          entered();
          await held;
          return fn({ client, spec: { configPath: path.join(dir, 'zephyr', '.config'), zephyrBase: root }, cold: true });
        },
      } as unknown as HostDeps['kconfig'],
      extensionContext: {} as HostDeps['extensionContext'],
      folders: {} as HostDeps['folders'],
      refreshViews: async () => undefined,
      servedTools: () => new Set(TOOL_CATALOG.map(tool => tool.name)),
    };
    ctx = (tool: string) => ({
      signal: new AbortController().signal,
      progress: () => undefined,
      client: { name: 'test-agent' },
      deps,
      tool: findTool(tool)!,
      startedAt: Date.now(),
      audit: {},
    });
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const register = () => setKconfig({
    assignments: [{ symbol: 'LOG', value: 'y' }], target: 'fragment',
    fragment_path: path.join(root, 'app', 'extra.conf'), register_fragment: true,
  }, ctx('set_kconfig')) as Promise<any>;

  it('adds the fragment to the list as stored when it writes, keeping what configure added meanwhile', async () => {
    const setting = register();
    await sessionEntered;
    await configure({ target: 'build_config', action: 'update', config_name: 'primary', env: { EXTRA_CONF_FILE: { add: ['debug.conf'] } } },
      ctx('configure'));
    openSession();
    const result = await setting;
    assert.equal(result.written, true);
    assert.equal(result.target.registered, true);
    assert.deepEqual(stored[0]['env.EXTRA_CONF_FILE'],
      ['${workspaceFolder}/prj-extra.conf', '${workspaceFolder}/debug.conf', '${workspaceFolder}/extra.conf']);
  });

  it('reports a configuration renamed meanwhile instead of claiming the fragment was registered', async () => {
    const setting = register();
    await sessionEntered;
    await configure({ target: 'build_config', action: 'rename', config_name: 'primary', new_name: 'main' }, ctx('configure'));
    openSession();
    const result = await setting;
    assert.equal(result.written, true, 'the fragment itself is written');
    assert.equal(result.target.registered, false);
    assert.match(result.registration_error, /renamed or removed/);
    assert.deepEqual(stored.map(config => config.name), ['main']);
    assert.deepEqual(stored[0]['env.EXTRA_CONF_FILE'], ['${workspaceFolder}/prj-extra.conf']);
  });

  it('refuses the registration when the configuration switched to sysbuild meanwhile', async () => {
    const setting = register();
    await sessionEntered;
    await configure({ target: 'build_config', action: 'update', config_name: 'primary', sysbuild: true }, ctx('configure'));
    openSession();
    const result = await setting;
    assert.equal(result.target.registered, false);
    assert.match(result.registration_error, /sysbuild/);
    assert.deepEqual(stored[0]['env.EXTRA_CONF_FILE'], ['${workspaceFolder}/prj-extra.conf']);
  });
});
