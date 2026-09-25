// manage_west_workspace, configure target "west_workspace" and the west
// workspace removals, run against real west workspace folders on disk. The
// settings store, the application list, the catalog and the folder scheduler
// are stood in for; the confirmation gate, the job manager, the fence and the
// manifest editing are the production code. The last block runs a whole
// creation through the real task runner with a fake west.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findTool, TOOL_CATALOG } from '../../../mcp/core/catalog';
import { McpToolError } from '../../../mcp/core/errors';
import { ConfirmCategory, ToolContext } from '../../../mcp/core/toolSpec';
import { AskAnswer, Confirmations } from '../../../mcp/host/confirmations';
import { HostDeps } from '../../../mcp/host/handlers/deps';
import { manageWestWorkspace, removeWestWorkspaceItem, updateWestWorkspace } from '../../../mcp/host/handlers/westWorkspaces';
import { JobManager, JobSpec } from '../../../mcp/jobs/jobManager';
import { useUiGuard } from './uiGuard';

const stub = require('vscode') as Record<string, any>;

const MANIFEST = `manifest:
  remotes:
    - name: zephyrproject
      url-base: https://github.com/zephyrproject-rtos
  projects:
    - name: zephyr
      repo-path: zephyr
      remote: zephyrproject
      revision: v4.2.0
      import:
        path-prefix: deps
        name-allowlist:
          - cmsis_6
          - hal_stm32
  self:
    path: manifest
`;

const ZEPHYR_WEST = `manifest:
  projects:
    - name: cmsis_6
    - name: hal_stm32
    - name: hal_nordic
`;

class TestUri {
  constructor(readonly fsPath: string) {}
  static file(fsPath: string) { return new TestUri(fsPath); }
  static joinPath(base: { fsPath: string }, ...parts: string[]) { return new TestUri(path.join(base.fsPath, ...parts)); }
}

function write(file: string, text = ''): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A west workspace as west update leaves it, with the Zephyr version given. */
function makeWorkspace(parent: string, name: string, version: [number, number, number] = [4, 2, 0]): string {
  const root = path.join(parent, name);
  write(path.join(root, '.west', 'config'), '[manifest]\npath = manifest\nfile = west.yml\n\n[zephyr]\nbase = deps/zephyr\n');
  write(path.join(root, 'manifest', 'west.yml'), MANIFEST);
  write(path.join(root, 'deps', 'zephyr', 'VERSION'), `VERSION_MAJOR = ${version[0]}\nVERSION_MINOR = ${version[1]}\nPATCHLEVEL = ${version[2]}\n`);
  write(path.join(root, 'deps', 'zephyr', 'west.yml'), ZEPHYR_WEST);
  return root;
}

interface FakeApp {
  appRootPath: string;
  appName: string;
  westWorkspaceRootPath: string;
  isWestWorkspaceApplication: boolean;
  buildConfigs: Array<{ name: string }>;
}

interface Harness {
  tmp: string;
  root: string;
  deps: HostDeps;
  jobs: JobManager;
  apps: FakeApp[];
  asked: string[];
  settings: Map<string, unknown>;
  updates: Array<[string, unknown]>;
  applied: Array<{ add?: string[]; remove?: string[]; jobId?: string; settingsExisted: boolean }>;
  invalidated: string[];
  refreshed: string[][];
  confirmActions: ConfirmCategory[];
  external?: { task: { name: string } };
  folderOutcome: { applied: boolean; restart_pending: boolean };
  /** Runs while the confirmation dialog is open, before it is answered. */
  onAsk?: () => void;
  ctx(tool: string): ToolContext<HostDeps>;
  answer(value: AskAnswer): void;
}

function harness(version: [number, number, number] = [4, 2, 0], confirmActions: ConfirmCategory[] = ['workspace', 'install', 'delete', 'settings']): Harness {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-west-handler-')));
  const root = makeWorkspace(tmp, 'ws', version);
  const envScript = path.join(tmp, 'env.sh');
  write(envScript, '');
  const h = { tmp, root, apps: [], asked: [], updates: [], applied: [], invalidated: [], refreshed: [], confirmActions } as unknown as Harness;
  h.settings = new Map<string, unknown>([['zephyr-workbench.pathToEnvScript', envScript]]);
  h.folderOutcome = { applied: true, restart_pending: false };

  stub.workspace.workspaceFolders = [{ uri: TestUri.file(root), name: 'ws', index: 0 }];
  stub.workspace.getConfiguration = (section?: string) => {
    const full = (key: string) => (section ? `${section}.${key}` : key);
    return {
      get: (key: string, fallback?: unknown) => (h.settings.has(full(key)) ? h.settings.get(full(key)) : fallback),
      update: async (key: string, value: unknown) => {
        h.updates.push([full(key), value]);
        if (value === undefined) {
          h.settings.delete(full(key));
        } else {
          h.settings.set(full(key), value);
        }
      },
      inspect: (key: string) => ({ workspaceFolderValue: h.settings.get(full(key)) }),
      has: (key: string) => h.settings.has(full(key)),
    };
  };

  const { getWestWorkspace } = require('../../../utils/utils') as typeof import('../../../utils/utils');
  const services = {
    resolveWestWorkspace: async (requested?: string) => {
      if (requested && path.resolve(requested) !== root) {
        throw new McpToolError('INVALID_ARGUMENT', `not a workspace: ${requested}`);
      }
      return { workspace: getWestWorkspace(root) };
    },
    listApplications: async () => h.apps,
    listWestWorkspaces: () => [getWestWorkspace(root)],
    externalRun: () => h.external,
    knownRoots: async () => [tmp],
    withFolderSettingsLock: <T>(_folder: string, work: () => Promise<T>) => work(),
    listSdks: async () => [],
    listOtherToolchains: async () => ({ armGnu: [], iar: [], rust: [] }),
    kconfigEditors: () => [],
    catalog: {
      invalidate: (dir: string) => { h.invalidated.push(dir); },
      list: async (kind: string) => ({
        source: 'fake', skippedRoots: [], cached: false, listedAt: 0,
        entries: kind === 'blob'
          ? [{ name: 'img/a.bin', module: 'hal_nordic', status: 'missing' }]
          : [{ name: 'qemu_x86' }],
      }),
      upstreamProjects: async () => ['cmsis_6', 'hal_nordic', 'hal_stm32', 'hal_nxp'],
    },
  };
  const jobs = new JobManager({ logPathFor: id => path.join(tmp, `${id}.log`) });
  const answers: AskAnswer[] = [];
  const confirmations = new Confirmations({
    categories: () => h.confirmActions,
    waitMs: () => 2000,
    log: { recordConfirmation: () => undefined },
    ask: async message => {
      h.asked.push(message);
      h.onAsk?.();
      return answers.length > 0 ? answers.shift() : 'allow';
    },
  });
  const deps = {
    services, jobs, confirmations,
    defaultWaitSeconds: 10,
    revealTerminal: 'never',
    get confirmActions() { return h.confirmActions; },
    kconfig: { inUseWithin: () => [], closeWithin: async () => () => undefined },
    extensionContext: { extensionUri: TestUri.file(path.resolve(__dirname, '../../../..')) },
    folders: {
      apply: async (change: { add?: string[]; remove?: string[] }, opts: { jobId?: string }) => {
        const target = change.add?.[0] ?? change.remove?.[0] ?? '';
        h.applied.push({ ...change, jobId: opts.jobId, settingsExisted: fs.existsSync(path.join(target, '.vscode', 'settings.json')) });
        return h.folderOutcome;
      },
      pending: () => [],
      restartNotice: () => undefined,
    },
    refreshViews: async (views: string[]) => { h.refreshed.push(views); },
    servedTools: () => new Set(TOOL_CATALOG.map(tool => tool.name)),
  } as unknown as HostDeps;
  Object.assign(h, {
    deps, jobs,
    ctx: (tool: string) => ({
      signal: new AbortController().signal,
      progress: () => undefined,
      client: { name: 'test-agent', version: '1', instance: 'session-1' },
      deps,
      tool: findTool(tool)!,
      startedAt: Date.now(),
      audit: {},
    }),
    answer: (value: AskAnswer) => answers.push(value),
  });
  return h;
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    assert.ok(error instanceof McpToolError, String(error));
    return error.code;
  }
}

const manage = (h: Harness, args: Record<string, unknown>) => manageWestWorkspace(args, h.ctx('manage_west_workspace')) as Promise<Record<string, any>>;
const configure = (h: Harness, args: Record<string, unknown>) =>
  updateWestWorkspace({ target: 'west_workspace', action: 'update', ...args }, h.ctx('configure')) as Promise<Record<string, any>>;
const remove = (h: Harness, args: Record<string, unknown>) => removeWestWorkspaceItem(args, h.ctx('remove_or_delete')) as Promise<Record<string, any>>;

/** A job that uses the workspace until the test lets it go. */
function holdWorkspace(h: Harness, spec: Partial<JobSpec>): () => void {
  let release: () => void = () => undefined;
  h.jobs.start({
    kind: 'build', lockKey: 'held', requestKey: 'held', command: 'west build',
    run: () => new Promise(resolve => { release = () => resolve({ exitCode: 0 }); }),
    ...spec,
  } as JobSpec);
  return () => release();
}

describe('mcp/host/handlers/westWorkspaces', () => {
  useUiGuard();

  let saved: Record<string, unknown>;
  before(() => {
    saved = { Uri: stub.Uri, getConfiguration: stub.workspace.getConfiguration, workspaceFolders: stub.workspace.workspaceFolders };
    stub.Uri = TestUri;
  });
  after(() => {
    stub.Uri = saved.Uri;
    stub.workspace.getConfiguration = saved.getConfiguration;
    stub.workspace.workspaceFolders = saved.workspaceFolders;
  });

  describe('manage_west_workspace create', () => {
    it('returns the generated west.yml and the steps on a dry run, asking and writing nothing', async () => {
      const h = harness();
      const out = await manage(h, {
        action: 'create', source: 'template', destination: h.tmp, folder_name: 'fresh', revision: 'v4.2.0', templates: ['stm32'], dry_run: true,
      });
      assert.equal(out.west_workspace, path.join(h.tmp, 'fresh'));
      assert.match(out.manifest.text, /revision: v4\.2\.0/);
      assert.match(out.manifest.text, /- hal_stm32/);
      assert.ok(out.steps.some((step: string) => step.startsWith('west init -l')));
      assert.ok(out.steps.includes('west update'));
      assert.equal(out.confirmation_required, true);
      assert.deepEqual(h.asked, []);
      assert.equal(fs.existsSync(path.join(h.tmp, 'fresh')), false);
    });

    it('adds extra projects after the base and template modules, checked against the Zephyr west.yml', async () => {
      const h = harness();
      const args = { action: 'create', source: 'template', destination: h.tmp, revision: 'v4.2.0', templates: ['STM32'], projects: ['hal_nxp'], dry_run: true };
      const out = await manage(h, args);
      assert.match(out.manifest.text, /- hal_stm32\n\s+- hal_nxp/);
      assert.equal(await codeOf(manage(h, { ...args, projects: ['hal_unknown'] })), 'INVALID_ARGUMENT');
    });

    it('refuses bad sources, URLs, revisions and destinations before anything else', async () => {
      const h = harness();
      const base = { action: 'create', destination: h.tmp, revision: 'v4.2.0' };
      for (const args of [
        { ...base, source: 'remote', url: 'https://github.com/x/y;rm -rf ~' },
        { ...base, source: 'remote', url: 'https://github.com/x/y', revision: '-x' },
        { ...base, source: 'remote', url: 'https://github.com/x/y', manifest_file: '../west.yml' },
        { ...base, source: 'remote', url: 'https://github.com/x/y', templates: ['STM32'] },
        { ...base, source: 'template', templates: ['NoSuchVendor'] },
        { ...base, source: 'template', template_mode: 'full', templates: ['STM32'] },
        { ...base, source: 'template' },
        { ...base, source: 'template', templates: ['STM32'], destination: 'relative' },
        { ...base, source: 'template', templates: ['STM32'], destination: path.join(h.tmp, 'with space') },
        { ...base, source: 'template', templates: ['STM32'], folder_name: '../escape' },
        { ...base, source: 'manifest', manifest_path: path.join(h.tmp, 'missing.yml') },
        { ...base, source: 'template', templates: ['STM32'], path: '/x' },
      ]) {
        assert.equal(await codeOf(manage(h, args)), 'INVALID_ARGUMENT', JSON.stringify(args));
      }
      assert.deepEqual(h.asked, []);
    });

    it('refuses a folder that is not empty or already holds a workspace', async () => {
      const h = harness();
      write(path.join(h.tmp, 'used', 'notes.txt'));
      const args = { action: 'create', source: 'template', destination: h.tmp, revision: 'v4.2.0', templates: ['STM32'] };
      assert.equal(await codeOf(manage(h, { ...args, folder_name: 'used' })), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(manage(h, { ...args, folder_name: 'ws' })), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(manage(h, { ...args, destination: h.root, folder_name: 'nested' })), 'INVALID_ARGUMENT', 'no workspace inside another');
    });

    it('refuses a folder_name that names an existing file, with a hint', async () => {
      const h = harness();
      write(path.join(h.tmp, 'notes'), 'not a folder');
      await assert.rejects(manage(h, { action: 'create', source: 'template', destination: h.tmp, folder_name: 'notes', revision: 'v4.2.0', templates: ['STM32'] }),
        (error: unknown) => error instanceof McpToolError && error.code === 'INVALID_ARGUMENT' && /is a file/.test(error.message) && error.hint === 'Pick another folder_name.');
      assert.deepEqual(h.asked, []);
    });

    it('says in the confirmation that a remote manifest can bring code, and asks under workspace', async () => {
      const h = harness();
      h.answer(undefined);
      const ctx = h.ctx('manage_west_workspace');
      await assert.rejects(manageWestWorkspace({
        action: 'create', source: 'remote', destination: h.tmp, url: 'https://github.com/acme/manifest', revision: 'main',
      }, ctx), (error: McpToolError) => error.code === 'USER_DENIED');
      assert.equal(ctx.audit.confirmCategory, 'workspace');
      assert.match(h.asked[0], /west extension commands and module CMake code/);
    });

    it('says the same for a local manifest file, which anyone may have written', async () => {
      const h = harness();
      const manifest = path.join(h.tmp, 'agent', 'west.yml');
      write(manifest, MANIFEST.replace('https://github.com/zephyrproject-rtos', 'https://attacker.example'));
      h.answer(undefined);
      await assert.rejects(manage(h, { action: 'create', source: 'manifest', manifest_path: manifest, destination: h.tmp }),
        (error: McpToolError) => error.code === 'USER_DENIED');
      assert.match(h.asked[0], new RegExp(`from the manifest ${manifest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(h.asked[0], /45 minutes\. The manifest decides .*run on this machine\.$/);
      assert.equal(fs.existsSync(path.join(h.tmp, 'zephyrproject')), false);
    });

    it('does not warn about the upstream Zephyr manifest the template flow renders', async () => {
      const h = harness();
      h.answer(undefined);
      await assert.rejects(manage(h, { action: 'create', source: 'template', destination: h.tmp, revision: 'v4.2.0', templates: ['STM32'] }),
        (error: McpToolError) => error.code === 'USER_DENIED');
      assert.doesNotMatch(h.asked[0], /west extension commands/);
      assert.match(h.asked[0], /45 minutes\.$/);
    });
  });

  describe('manage_west_workspace import', () => {
    it('writes the folder settings before adding the folder, and reports a deferred restart', async () => {
      const h = harness();
      const other = makeWorkspace(h.tmp, 'other');
      h.folderOutcome = { applied: false, restart_pending: true };
      const out = await manage(h, { action: 'import', path: other });
      assert.equal(out.restart_pending, true);
      assert.deepEqual(h.applied.map(entry => [entry.add, entry.settingsExisted]), [[[other], true]]);
      const settings = JSON.parse(fs.readFileSync(path.join(other, '.vscode', 'settings.json'), 'utf8'));
      assert.equal(settings['cmake.enableAutomaticKitScan'], false);
      assert.equal(out.boards, 1);
    });

    it('refuses a folder without .west, and answers at once for one already in the window', async () => {
      const h = harness();
      fs.mkdirSync(path.join(h.tmp, 'plain'));
      assert.equal(await codeOf(manage(h, { action: 'import', path: path.join(h.tmp, 'plain') })), 'INVALID_ARGUMENT');
      const again = await manage(h, { action: 'import', path: h.root });
      assert.equal(again.already_registered, true);
      assert.deepEqual(h.asked, []);
    });
  });

  describe('manage_west_workspace update', () => {
    it('refuses while an agent build or a VS Code build of a linked application runs', async () => {
      const h = harness();
      const release = holdWorkspace(h, { westWorkspace: h.root, buildDir: path.join(h.tmp, 'app', 'build', 'primary') });
      assert.equal(await codeOf(manage(h, { action: 'update' })), 'BUSY');
      release();
      await new Promise(resolve => setTimeout(resolve, 10));
      h.apps = [{ appRootPath: path.join(h.tmp, 'app'), appName: 'app', westWorkspaceRootPath: h.root, isWestWorkspaceApplication: false, buildConfigs: [{ name: 'primary' }] }];
      h.external = { task: { name: 'West Build' } };
      assert.equal(await codeOf(manage(h, { action: 'update' })), 'BUSY_EXTERNAL');
      assert.deepEqual(h.asked, []);
    });

    it('describes the update on a dry run', async () => {
      const h = harness();
      const out = await manage(h, { action: 'update', dry_run: true });
      assert.equal(out.command, 'west update');
      assert.equal(out.zephyr_version, '4.2.0');
    });
  });

  describe('manage_west_workspace set_manifest', () => {
    it('diffs on a dry run, then writes the allowlist and says an update is needed', async () => {
      const h = harness();
      const dry = await manage(h, { action: 'set_manifest', allowlist: { add: ['hal_nordic'] }, dry_run: true });
      assert.deepEqual(dry.changed, ['allowlist']);
      assert.match(dry.diff, /^\+ +- hal_nordic$/m);
      assert.doesNotMatch(fs.readFileSync(path.join(h.root, 'manifest', 'west.yml'), 'utf8'), /hal_nordic/);

      const out = await manage(h, { action: 'set_manifest', allowlist: { add: ['hal_nordic'] }, revision: 'v4.3.0' });
      assert.deepEqual(out.changed, ['revision', 'allowlist']);
      assert.equal(out.needs_update, true);
      const text = fs.readFileSync(path.join(h.root, 'manifest', 'west.yml'), 'utf8');
      assert.match(text, /hal_nordic/);
      assert.match(text, /revision: v4\.3\.0/);
      assert.deepEqual(h.invalidated, [h.root]);
    });

    it('refuses unknown projects, conflicting arguments, and an edit under a west job', async () => {
      const h = harness();
      assert.equal(await codeOf(manage(h, { action: 'set_manifest', allowlist: { add: ['hal_nope'] } })), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(manage(h, { action: 'set_manifest', import_all: true, allowlist: { set: ['cmsis_6'] } })), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(manage(h, { action: 'set_manifest' })), 'INVALID_ARGUMENT');
      const release = holdWorkspace(h, { kind: 'west', lockKey: h.root, westWorkspace: h.root, writes: ['west_workspace'] });
      assert.equal(await codeOf(manage(h, { action: 'set_manifest', enable_rust: true })), 'BUSY');
      release();
    });

    it('with update, refuses a build found running after the dialog before writing the manifest', async () => {
      const h = harness();
      const manifest = path.join(h.root, 'manifest', 'west.yml');
      h.apps = [{ appRootPath: path.join(h.tmp, 'app'), appName: 'app', westWorkspaceRootPath: h.root, isWestWorkspaceApplication: false, buildConfigs: [{ name: 'primary' }] }];
      h.onAsk = () => { h.external = { task: { name: 'West Build' } }; };
      assert.equal(await codeOf(manage(h, { action: 'set_manifest', allowlist: { add: ['hal_nordic'] }, update: true })), 'BUSY_EXTERNAL');
      assert.equal(h.asked.length, 1);
      assert.equal(fs.readFileSync(manifest, 'utf8'), MANIFEST, 'nothing written');
      assert.deepEqual(h.invalidated, []);
    });

    it('with update, reports the written manifest when west update still cannot start', async () => {
      const h = harness();
      const start = h.jobs.start.bind(h.jobs);
      h.jobs.start = () => { throw new McpToolError('BUSY', 'A build job is already running for this west workspace.', { hint: 'Wait for it.' }); };
      try {
        const out = await manage(h, { action: 'set_manifest', allowlist: { add: ['hal_nordic'] }, update: true });
        assert.deepEqual(out.changed, ['allowlist']);
        assert.match(out.diff, /^\+ +- hal_nordic$/m);
        assert.equal(out.needs_update, true);
        assert.equal(out.update_error.code, 'BUSY');
        assert.match(out.next, /manifest is written.*manage_west_workspace with action "update"/);
        assert.match(fs.readFileSync(path.join(h.root, 'manifest', 'west.yml'), 'utf8'), /hal_nordic/);
        assert.deepEqual(h.refreshed, [['westWorkspaces']]);
      } finally {
        h.jobs.start = start;
      }
    });

    it('with update and no manifest change, fails as update does when west update cannot start', async () => {
      const h = harness();
      const manifest = path.join(h.root, 'manifest', 'west.yml');
      const start = h.jobs.start.bind(h.jobs);
      h.jobs.start = () => { throw new Error('EACCES: could not open the job log'); };
      try {
        await assert.rejects(manage(h, { action: 'set_manifest', revision: 'v4.2.0', update: true }), /could not open the job log/);
        assert.equal(h.asked.length, 1);
        assert.equal(fs.readFileSync(manifest, 'utf8'), MANIFEST, 'nothing written');
        assert.deepEqual(h.invalidated, []);
        assert.deepEqual(h.refreshed, []);
      } finally {
        h.jobs.start = start;
      }
    });

    it('reports an unsupported manifest topology with the West Manager reason', async () => {
      const h = harness();
      write(path.join(h.root, 'manifest', 'west.yml'), 'manifest:\n  projects:\n    - name: zephyr\n      import: submanifests/\n');
      await assert.rejects(manage(h, { action: 'set_manifest', import_all: true }),
        (error: McpToolError) => error.code === 'INVALID_ARGUMENT' && /topology is not supported/.test(error.message));
    });
  });

  describe('venv and blobs', () => {
    it('refuses west packages below Zephyr 3.6', async () => {
      const h = harness([3, 5, 0]);
      fs.mkdirSync(path.join(h.root, '.venv'));
      await assert.rejects(manage(h, { action: 'install_python_deps' }),
        (error: McpToolError) => error.code === 'INVALID_ARGUMENT' && /create_venv/.test(error.hint ?? ''));
    });

    it('reports the auto-detected workspace venv it would install into', async () => {
      const h = harness();
      fs.mkdirSync(path.join(h.root, '.venv'));
      const out = await manage(h, { action: 'install_python_deps', dry_run: true });
      assert.equal(out.venv_path, path.join(h.root, '.venv'));
      assert.equal(out.venv_source, 'auto');
    });

    it('says the venv installs pyOCD with the Zephyr requirements', async () => {
      const h = harness();
      const out = await manage(h, { action: 'create_venv', dry_run: true });
      assert.equal(out.venv_path, path.join(h.root, '.venv'));
      assert.match(out.installs, /pyOCD/);
    });

    it('refuses blobs below Zephyr 3.2, and click-through licenses without the user', async () => {
      assert.equal(await codeOf(manage(harness([3, 1, 0]), { action: 'fetch_blobs' })), 'INVALID_ARGUMENT');
      const h = harness([4, 2, 0]);
      await assert.rejects(manage(h, { action: 'fetch_blobs' }),
        (error: McpToolError) => error.code === 'INVALID_ARGUMENT' && /accept_blob_licenses/.test(error.hint ?? ''));
      assert.equal(await codeOf(manage(h, { action: 'fetch_blobs', accept_blob_licenses: true, modules: ['hal_nope'] })), 'INVALID_ARGUMENT');
    });

    it('always asks before accepting blob licenses, even with install confirmations off', async () => {
      const h = harness([4, 2, 0], []);
      h.answer(undefined);
      const ctx = h.ctx('manage_west_workspace');
      await assert.rejects(manageWestWorkspace({ action: 'fetch_blobs', accept_blob_licenses: true }, ctx),
        (error: McpToolError) => error.code === 'USER_DENIED');
      assert.equal(h.asked.length, 1);
      assert.match(h.asked[0], /click-through licenses/);
      const dry = await manage(h, { action: 'fetch_blobs', accept_blob_licenses: true, dry_run: true });
      assert.equal(dry.confirmation_required, true);
      assert.deepEqual(dry.to_fetch, [{ module: 'hal_nordic', path: 'img/a.bin', status: 'missing' }]);
    });

    it('refuses arguments an action does not take', async () => {
      const h = harness();
      assert.equal(await codeOf(manage(h, { action: 'update', modules: ['x'] })), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(manage(h, { action: 'nope' })), 'INVALID_ARGUMENT');
    });
  });

  describe('configure target west_workspace', () => {
    it('plans root lists and writes them portably under the folder, then invalidates the catalog', async () => {
      const h = harness();
      fs.mkdirSync(path.join(h.root, 'boards'));
      const dry = await configure(h, { roots: { BOARD_ROOT: { add: ['boards'] } }, dry_run: true });
      assert.deepEqual(dry.roots, { BOARD_ROOT: [path.join(h.root, 'boards')] });
      assert.equal(h.updates.length, 0);

      const out = await configure(h, { roots: { BOARD_ROOT: { add: ['boards'] }, DTS_ROOT: { set: [path.join(h.root, 'dts')] } } });
      assert.deepEqual(out.changed, ['roots.BOARD_ROOT', 'roots.DTS_ROOT']);
      assert.deepEqual(h.updates.map(([key]) => key), ['zephyr-workbench.env.BOARD_ROOT', 'zephyr-workbench.env.DTS_ROOT']);
      assert.deepEqual(h.updates[0][1], ['${workspaceFolder}/boards'], 'stored the way the tree stores it');
      assert.ok(out.warnings.some((w: string) => /does not exist yet/.test(w)));
      assert.deepEqual(h.invalidated, [h.root]);
      assert.deepEqual(h.refreshed, [['westWorkspaces']]);
    });

    it('refuses roots outside the window, unknown keys, and a venv that is not one', async () => {
      const h = harness();
      assert.equal(await codeOf(configure(h, { roots: { BOARD_ROOT: { add: ['/etc'] } } })), 'PATH_OUTSIDE_WORKSPACE');
      assert.equal(await codeOf(configure(h, { roots: { EXTRA_CONF_FILE: { add: ['x'] } } })), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(configure(h, { venv: { mode: 'path', path: path.join(h.tmp, 'novenv') } })), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(configure(h, { board: 'qemu_x86', roots: { BOARD_ROOT: { set: [] } } })), 'INVALID_ARGUMENT');
      assert.equal(await codeOf(configure(h, {})), 'INVALID_ARGUMENT');
    });

    it('sets and clears the workspace venv', async () => {
      const h = harness();
      const venv = path.join(h.tmp, 'venv');
      write(path.join(venv, 'bin', 'python3'));
      const out = await configure(h, { venv: { mode: 'path', path: venv } });
      assert.deepEqual(out.changed, ['venv']);
      assert.deepEqual(h.updates, [['zephyr-workbench.venv.path', venv]]);
      await configure(h, { venv: { mode: 'inherit' } });
      assert.deepEqual(h.updates[1], ['zephyr-workbench.venv.path', undefined]);
      const again = await configure(h, { venv: { mode: 'inherit' } });
      assert.deepEqual(again.changed, []);
    });
  });

  describe('remove_or_delete', () => {
    it('removes a workspace from the window unless a linked application needs it', async () => {
      const h = harness();
      h.apps = [{ appRootPath: path.join(h.tmp, 'app'), appName: 'app', westWorkspaceRootPath: h.root, isWestWorkspaceApplication: false, buildConfigs: [] }];
      assert.equal(await codeOf(remove(h, { what: 'west_workspace' })), 'INVALID_ARGUMENT');
      const out = await remove(h, { what: 'west_workspace', force: true });
      assert.equal(out.kept_files, true);
      assert.deepEqual(h.applied.map(entry => entry.remove), [[h.root]]);
      assert.ok(fs.existsSync(h.root));
    });

    it('fences the deletion of a workspace, measures it on a dry run, then deletes it', async () => {
      const h = harness();
      (h.deps.services as unknown as { listSdks: () => Promise<unknown[]> }).listSdks = async () => [{ rootUri: { fsPath: path.join(h.root, 'sdk') } }];
      fs.mkdirSync(path.join(h.root, 'sdk'));
      assert.equal(await codeOf(remove(h, { what: 'west_workspace_files' })), 'PATH_OUTSIDE_WORKSPACE');
      (h.deps.services as unknown as { listSdks: () => Promise<unknown[]> }).listSdks = async () => [];

      const dry = await remove(h, { what: 'west_workspace_files', dry_run: true });
      assert.ok(dry.size_bytes > 0);
      assert.equal(fs.existsSync(h.root), true);

      const out = await remove(h, { what: 'west_workspace_files' });
      assert.equal(out.deleted, true);
      assert.equal(fs.existsSync(h.root), false);
      assert.deepEqual(h.applied.map(entry => entry.remove), [[h.root]]);
      assert.ok(h.applied[0].jobId, 'the folder change knows the job that asked for it');
    });

    it('fences the deletion again after the dialog, with what the window holds by then', async () => {
      const h = harness();
      const services = h.deps.services as unknown as { listSdks: () => Promise<unknown[]> };
      // A toolchain registered inside the workspace while the dialog was open.
      fs.mkdirSync(path.join(h.root, 'sdk'));
      h.onAsk = () => { services.listSdks = async () => [{ rootUri: { fsPath: path.join(h.root, 'sdk') } }]; };
      assert.equal(await codeOf(remove(h, { what: 'west_workspace_files' })), 'PATH_OUTSIDE_WORKSPACE');
      assert.ok(fs.existsSync(h.root));
      services.listSdks = async () => [];

      // An application outside it linked to it meanwhile.
      h.onAsk = () => {
        h.apps = [{ appRootPath: path.join(h.tmp, 'app'), appName: 'app', westWorkspaceRootPath: h.root, isWestWorkspaceApplication: false, buildConfigs: [] }];
      };
      assert.equal(await codeOf(remove(h, { what: 'west_workspace_files' })), 'INVALID_ARGUMENT');
      assert.ok(fs.existsSync(h.root));

      // A VS Code build of an application inside it found running.
      h.apps = [{ appRootPath: path.join(h.root, 'app'), appName: 'app', westWorkspaceRootPath: h.root, isWestWorkspaceApplication: true, buildConfigs: [{ name: 'primary' }] }];
      h.onAsk = () => { h.external = { task: { name: 'West Build' } }; };
      assert.equal(await codeOf(remove(h, { what: 'west_workspace_files' })), 'BUSY_EXTERNAL');
      assert.ok(fs.existsSync(h.root));
      assert.deepEqual(h.applied, [], 'never taken out of the window');
    });

    it('refuses to remove the workspace venv when a build is found running after the dialog', async () => {
      const h = harness();
      fs.mkdirSync(path.join(h.root, '.venv', 'bin'), { recursive: true });
      h.apps = [{ appRootPath: path.join(h.tmp, 'app'), appName: 'app', westWorkspaceRootPath: h.root, isWestWorkspaceApplication: false, buildConfigs: [{ name: 'primary' }] }];
      h.onAsk = () => { h.external = { task: { name: 'West Build' } }; };
      assert.equal(await codeOf(remove(h, { what: 'workspace_venv' })), 'BUSY_EXTERNAL');
      assert.equal(h.asked.length, 1);
      assert.ok(fs.existsSync(path.join(h.root, '.venv')));
    });

    it('removes the workspace venv setting and its managed folder only', async () => {
      const h = harness();
      const nothing = await remove(h, { what: 'workspace_venv' });
      assert.equal(nothing.nothing_to_remove, true);
      fs.mkdirSync(path.join(h.root, '.venv', 'bin'), { recursive: true });
      h.settings.set('zephyr-workbench.venv.path', '${workspaceFolder}/.venv');
      const release = holdWorkspace(h, { venvPath: path.join(h.root, '.venv'), buildDir: path.join(h.tmp, 'b') });
      assert.equal(await codeOf(remove(h, { what: 'workspace_venv' })), 'BUSY');
      release();
      await new Promise(resolve => setTimeout(resolve, 10));
      const out = await remove(h, { what: 'workspace_venv' });
      assert.equal(out.removed, true);
      assert.equal(fs.existsSync(path.join(h.root, '.venv')), false);
      assert.equal(h.settings.has('zephyr-workbench.venv.path'), false);
    });

    it('refuses to clean blobs below Zephyr 3.2 and lists fetched ones on a dry run', async () => {
      assert.equal(await codeOf(remove(harness([3, 0, 0]), { what: 'west_blobs' })), 'INVALID_ARGUMENT');
      const out = await remove(harness(), { what: 'west_blobs', dry_run: true });
      assert.equal(out.command, 'west blobs clean');
      assert.deepEqual(out.would_delete, []);
    });
  });
});

describe('mcp/host/handlers/westWorkspaces: a whole creation with a fake west', function () {
  this.timeout(30000);
  useUiGuard();

  class FakeEmitter<T> {
    private listeners: Array<(value: T) => void> = [];
    event = (listener: (value: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    };
    fire(value: T): void {
      for (const listener of [...this.listeners]) {
        listener(value);
      }
    }
    dispose(): void {
      this.listeners = [];
    }
  }
  class FakeCustomExecution {
    constructor(readonly callback: () => Promise<{ onDidWrite(l: unknown): unknown; onDidClose(l: unknown): unknown; open(d: unknown): void }>) {}
  }

  const MODULES = ['../../../mcp/host/capturedTask', '../../../mcp/host/taskRunner', '../../../mcp/host/handlers/westWorkspaces']
    .map(m => require.resolve(m));
  const added: string[] = [];
  let saved: Record<string, unknown>;
  let handlers: typeof import('../../../mcp/host/handlers/westWorkspaces');
  let calls: string;

  before(function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    saved = { Uri: stub.Uri, getConfiguration: stub.workspace.getConfiguration, workspaceFolders: stub.workspace.workspaceFolders, tasks: stub.tasks };
    stub.Uri = TestUri;
    for (const [key, value] of Object.entries({ EventEmitter: FakeEmitter, CustomExecution: FakeCustomExecution })) {
      if (!(key in stub)) {
        added.push(key);
        stub[key] = value;
      }
    }
    for (const file of MODULES) {
      delete require.cache[file];
    }
    handlers = require('../../../mcp/host/handlers/westWorkspaces');
    stub.tasks = {
      ...(saved.tasks as object),
      executeTask: async (task: { execution: FakeCustomExecution }) => {
        const pty = await task.execution.callback();
        pty.onDidWrite(() => undefined);
        pty.onDidClose(() => undefined);
        pty.open(undefined);
        return { task };
      },
    };
  });

  after(() => {
    if (!saved) {
      return;
    }
    stub.Uri = saved.Uri;
    stub.workspace.getConfiguration = saved.getConfiguration;
    stub.workspace.workspaceFolders = saved.workspaceFolders;
    stub.tasks = saved.tasks;
    for (const key of added) {
      delete stub[key];
    }
    for (const file of MODULES) {
      delete require.cache[file];
    }
  });

  /** A harness whose env script puts a fake west first on PATH. */
  function withFakeWest(): Harness {
    const h = harness();
    const bin = path.join(h.tmp, 'bin');
    calls = path.join(h.tmp, 'calls.txt');
    write(path.join(bin, 'west'), [
      '#!/bin/sh',
      `echo "$*" >> "${calls}"`,
      'if [ "$1" = "$FAKE_WEST_FAIL" ]; then echo "west $1 failed" >&2; exit 3; fi',
      'case "$1" in',
      '  init)',
      '    if [ "$2" = "-l" ]; then top=$(dirname "$5"); mpath=$(basename "$5"); mfile="$4"; else top="$6"; mpath=manifest; mfile=west.yml; fi',
      '    mkdir -p "$top/.west"',
      '    printf "[manifest]\\npath = %s\\nfile = %s\\n\\n[zephyr]\\nbase = deps/zephyr\\n" "$mpath" "$mfile" > "$top/.west/config" ;;',
      '  update)',
      '    mkdir -p deps/zephyr',
      '    printf "VERSION_MAJOR = 4\\nVERSION_MINOR = 3\\nPATCHLEVEL = 0\\n" > deps/zephyr/VERSION ;;',
      'esac',
      '',
    ].join('\n'));
    fs.chmodSync(path.join(bin, 'west'), 0o755);
    write(h.settings.get('zephyr-workbench.pathToEnvScript') as string, `export PATH="${bin}:$PATH"\n`);
    return h;
  }

  const run = (h: Harness, args: Record<string, unknown>) =>
    handlers.manageWestWorkspace(args, h.ctx('manage_west_workspace')) as Promise<Record<string, any>>;

  it('runs west init, the Rust module, west update and west boards, then writes the settings and adds the folder', async () => {
    const h = withFakeWest();
    h.folderOutcome = { applied: false, restart_pending: true };
    const target = path.join(h.tmp, 'created');
    const out = await run(h, {
      action: 'create', source: 'template', destination: h.tmp, folder_name: 'created', revision: 'v4.3.0', templates: ['STM32'], enable_rust: true, wait_sec: 20,
    });
    assert.equal(out.status, 'succeeded', out.log?.tail);
    const made = fs.readFileSync(calls, 'utf8').trim().split('\n');
    assert.deepEqual(made.map(line => line.split(' ')[0]), ['init', 'config', 'update']);
    assert.match(made[0], new RegExp(`^init -l --mf west.yml ${path.join(target, 'manifest')}$`));
    assert.match(made[1], /manifest\.project-filter -- \+zephyr-lang-rust/);
    assert.deepEqual(h.applied.map(entry => [entry.add, entry.settingsExisted, entry.jobId]), [[[target], true, out.job_id]]);
    assert.equal(out.result.restart_pending, true);
    assert.deepEqual(out.result.west_workspace, { path: target, zephyr_version: '4.3.0', zephyr_base: path.join(target, 'deps', 'zephyr') });
    assert.match(out.next, /get_status/);
    assert.match(out.next, /create_venv/);
    assert.match(fs.readFileSync(path.join(target, 'manifest', 'west.yml'), 'utf8'), /zephyr-lang-rust/);
  });

  it('updates a workspace, reports the Zephyr version before and after, and drops its catalog', async () => {
    const h = withFakeWest();
    const out = await run(h, { action: 'update', wait_sec: 20 });
    assert.equal(out.status, 'succeeded', out.log?.tail);
    assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), ['update']);
    assert.equal(out.result.zephyr_version_before, '4.2.0');
    assert.equal(out.result.zephyr_version_after, '4.3.0');
    assert.deepEqual(h.invalidated, [h.root]);
    assert.match(out.next, /pristine "always"/);
  });

  it('edits the manifest, then runs west update on it when set_manifest asks for it', async () => {
    const h = withFakeWest();
    const out = await run(h, { action: 'set_manifest', allowlist: { add: ['hal_nordic'] }, update: true, wait_sec: 20 });
    assert.equal(out.job.status, 'succeeded', out.job.log?.tail);
    assert.deepEqual(out.changed, ['allowlist']);
    assert.equal(out.needs_update, false);
    assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), ['update']);
    assert.match(fs.readFileSync(path.join(h.root, 'manifest', 'west.yml'), 'utf8'), /hal_nordic/);
  });

  it('installs the Python packages into the venv the workspace auto-detects', async () => {
    const h = withFakeWest();
    fs.mkdirSync(path.join(h.root, '.venv'));
    write(path.join(h.tmp, 'bin', 'west'), `#!/bin/sh\necho "$* into $PYTHON_VENV_PATH" >> "${calls}"\n`);
    const out = await run(h, { action: 'install_python_deps', wait_sec: 20 });
    assert.equal(out.status, 'succeeded', out.log?.tail);
    assert.equal(fs.readFileSync(calls, 'utf8').trim(), `packages pip --install into ${path.join(h.root, '.venv')}`);
  });

  describe('a cancelled create_venv', () => {
    const until = async (check: () => boolean, ms = 10000) => {
      const end = Date.now() + ms;
      while (!check() && Date.now() < end) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    const recorded = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []);

    /**
     * A harness whose venv installer creates the venv folder, then runs as
     * long as FAKE_INSTALLER_HANG asks, and whose venv west (for
     * `west packages pip --install`) hangs as long as FAKE_VENV_WEST_HANG
     * asks. Python only records the fallback install of requirements.txt.
     */
    function withFakeInstaller(): Harness {
      const h = withFakeWest();
      const extension = path.join(h.tmp, 'extension');
      const installer = [
        '#!/bin/bash',
        'while [ $# -gt 0 ]; do case "$1" in --venv-path) venv="$2"; shift 2 ;; *) shift ;; esac; done',
        'mkdir -p "$venv/bin"',
        `printf '#!/bin/sh\\necho "venv west $*" >> "${calls}"\\nsleep \${FAKE_VENV_WEST_HANG:-0}\\necho "venv west done" >> "${calls}"\\n' > "$venv/bin/west"`,
        `printf '#!/bin/sh\\necho "venv python $*" >> "${calls}"\\n' > "$venv/bin/python3"`,
        'chmod +x "$venv/bin/west" "$venv/bin/python3"',
        `echo installer >> "${calls}"`,
        'sleep ${FAKE_INSTALLER_HANG:-0}',
        '',
      ].join('\n');
      write(path.join(extension, 'scripts', 'hosttools', 'install-mac.sh'), installer);
      write(path.join(extension, 'scripts', 'hosttools', 'install.sh'), installer);
      write(path.join(h.root, 'deps', 'zephyr', 'scripts', 'requirements.txt'), 'west\n');
      (h.deps as { extensionContext: unknown }).extensionContext = { extensionUri: TestUri.file(extension) };
      return h;
    }

    async function cancelWhen(h: Harness, seen: string): Promise<{ ended: boolean; status: string }> {
      const out = await run(h, { action: 'create_venv', wait_sec: 0 });
      await until(() => recorded().includes(seen));
      assert.ok(recorded().includes(seen), `the job reached "${seen}": ${recorded().join(' | ')}`);
      h.jobs.cancel(out.job_id);
      const job = h.jobs.get(out.job_id) as { done: Promise<void>; endedAt?: number; status: string };
      await Promise.race([job.done, new Promise(resolve => setTimeout(resolve, 5000))]);
      return { ended: job.endedAt !== undefined, status: job.status };
    }

    afterEach(() => {
      delete process.env.FAKE_INSTALLER_HANG;
      delete process.env.FAKE_VENV_WEST_HANG;
    });

    it('stops at the installer, and installs and records nothing after it', async () => {
      const h = withFakeInstaller();
      process.env.FAKE_INSTALLER_HANG = '30';
      const { ended, status } = await cancelWhen(h, 'installer');
      assert.equal(ended, true, 'the job ends at once');
      assert.equal(status, 'cancelled');
      assert.ok(fs.existsSync(path.join(h.root, '.venv')), 'the installer had created the venv folder');
      assert.deepEqual(recorded(), ['installer'], 'neither west packages nor pip runs');
      assert.ok(!h.updates.some(([key]) => key === 'zephyr-workbench.venv.path'), 'no venv.path is written');
      assert.deepEqual(h.refreshed, []);
    });

    it('kills west packages pip --install and starts no fallback', async () => {
      const h = withFakeInstaller();
      process.env.FAKE_VENV_WEST_HANG = '30';
      const { ended, status } = await cancelWhen(h, 'venv west packages pip --install');
      assert.equal(ended, true, 'the job ends at once');
      assert.equal(status, 'cancelled');
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.deepEqual(recorded(), ['installer', 'venv west packages pip --install'], 'west packages was killed and pip -r never ran');
      assert.ok(!h.updates.some(([key]) => key === 'zephyr-workbench.venv.path'), 'no venv.path is written');
      assert.deepEqual(h.refreshed, []);
    });
  });

  it('stops at the step that fails, with its exit code, and adds nothing', async () => {
    const h = withFakeWest();
    process.env.FAKE_WEST_FAIL = 'update';
    try {
      const out = await run(h, { action: 'create', source: 'template', destination: h.tmp, revision: 'v4.3.0', templates: ['STM32'], wait_sec: 20 });
      assert.equal(out.status, 'failed');
      assert.equal(out.exit_code, 3);
      assert.equal(out.result.failed_step, 'west update');
      assert.deepEqual(h.applied, []);
      assert.match(out.next, /delete the folder/);
    } finally {
      delete process.env.FAKE_WEST_FAIL;
    }
  });
});
