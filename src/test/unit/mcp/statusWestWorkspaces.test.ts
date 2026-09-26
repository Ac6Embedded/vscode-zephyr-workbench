// What get_status says about west workspaces, folder changes an agent asked
// for, and which tools its next steps name, against real workspace folders
// and stubbed window services.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TOOL_CATALOG } from '../../../mcp/core/catalog';
import { AuditBag, Permissions, selectTools, ToolContext } from '../../../mcp/core/toolSpec';

const FULL: Permissions = { preset: 'full', tools: {} };
import { HostDeps } from '../../../mcp/host/handlers/deps';
import { getStatus } from '../../../mcp/host/handlers/queries';
import { westWorkspaceStatus } from '../../../mcp/host/handlers/westWorkspaces';
import type { WestWorkspace } from '../../../models/WestWorkspace';
import type { ZephyrApplication } from '../../../models/ZephyrApplication';
import { useUiGuard } from './uiGuard';

const stub = require('vscode') as Record<string, any>;

class TestUri {
  constructor(readonly fsPath: string) {}
  static file(fsPath: string) { return new TestUri(fsPath); }
  static joinPath(base: { fsPath: string }, ...parts: string[]) { return new TestUri(path.join(base.fsPath, ...parts)); }
}

function write(file: string, text = ''): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function makeWorkspace(parent: string, name: string): string {
  const root = path.join(parent, name);
  write(path.join(root, '.west', 'config'), '[manifest]\npath = manifest\nfile = west.yml\nproject-filter = +zephyr-lang-rust\n\n[zephyr]\nbase = deps/zephyr\n');
  write(path.join(root, 'manifest', 'west.yml'), 'manifest:\n  projects:\n    - name: zephyr\n      revision: v4.2.0\n      import: true\n');
  write(path.join(root, 'deps', 'zephyr', 'VERSION'), 'VERSION_MAJOR = 4\nVERSION_MINOR = 2\nPATCHLEVEL = 0\n');
  return root;
}

describe('get_status: west workspaces and next steps', () => {
  useUiGuard();

  let tmp: string;
  let settings: Map<string, unknown>;
  let saved: Record<string, unknown>;

  beforeEach(() => {
    saved = { Uri: stub.Uri, getConfiguration: stub.workspace.getConfiguration, workspaceFolders: stub.workspace.workspaceFolders, portable: process.env.VSCODE_PORTABLE };
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-status-west-')));
    process.env.VSCODE_PORTABLE = tmp;
    settings = new Map();
    stub.Uri = TestUri;
    stub.workspace.getConfiguration = (section?: string) => {
      const full = (key: string) => (section ? `${section}.${key}` : key);
      return {
        get: (key: string, fallback?: unknown) => (settings.has(full(key)) ? settings.get(full(key)) : fallback),
        inspect: (key: string) => ({ workspaceFolderValue: settings.get(full(key)) }),
        update: async () => undefined,
      };
    };
  });

  afterEach(() => {
    stub.Uri = saved.Uri;
    stub.workspace.getConfiguration = saved.getConfiguration;
    stub.workspace.workspaceFolders = saved.workspaceFolders;
    if (saved.portable === undefined) {
      delete process.env.VSCODE_PORTABLE;
    } else {
      process.env.VSCODE_PORTABLE = saved.portable as string;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('describes each workspace folder, and the workspaces applications link to that are not folders', () => {
    const { getWestWorkspace } = require('../../../utils/utils') as typeof import('../../../utils/utils');
    const root = makeWorkspace(tmp, 'ws');
    const linked = makeWorkspace(tmp, 'linked');
    fs.mkdirSync(path.join(root, '.venv'));
    fs.mkdirSync(path.join(root, 'deps', 'zephyr', 'scripts', 'pylib', 'zspdx', 'serializers', 'spdx3'), { recursive: true });
    stub.workspace.workspaceFolders = [{ uri: TestUri.file(root), name: 'ws', index: 0 }];
    settings.set('zephyr-workbench.env.BOARD_ROOT', [path.join(root, 'boards')]);
    const apps = [
      { appRootPath: path.join(root, 'app'), westWorkspaceRootPath: root },
      { appRootPath: path.join(tmp, 'free'), westWorkspaceRootPath: linked },
    ] as unknown as ZephyrApplication[];

    const [folder, other] = westWorkspaceStatus([getWestWorkspace(root)], apps);
    assert.deepEqual(folder, {
      path: root,
      zephyr_version: '4.2.0',
      zephyr_base: path.join(root, 'deps', 'zephyr'),
      is_folder: true,
      venv: { path: path.join(root, '.venv'), source: 'auto' },
      manifest_path: path.join(root, 'manifest', 'west.yml'),
      zephyr_revision: 'v4.2.0',
      rust_enabled: true,
      blobs_supported: true,
      spdx3_supported: true,
      env_roots: { BOARD_ROOT: [path.join(root, 'boards')] },
      application_count: 1,
    });
    assert.equal(other.path, linked);
    assert.equal(other.is_folder, false);
    assert.equal(other.spdx3_supported, false, 'a Zephyr without the SPDX 3.0 serializer');
    assert.equal(other.application_count, 1);
  });

  it('never fails on a workspace it cannot read', () => {
    const broken = { rootUri: { fsPath: '/nowhere' }, version: 'No version found' } as unknown as WestWorkspace;
    assert.deepEqual(westWorkspaceStatus([broken], []), [{ path: '/nowhere', zephyr_version: 'No version found', is_folder: false, venv: { source: 'global' }, application_count: 0 }]);
  });

  function status(permissions: Permissions, folders: Partial<HostDeps['folders']> = {}) {
    const services = {
      listApplications: async () => [],
      listWestWorkspaces: () => [],
      listSdks: async () => [],
      hostToolsStatus: async () => ({ installed: true, complete: true, zinstaller: { upToDate: true } }),
      findUnregisteredCandidates: async () => [path.join(tmp, 'loose')],
      isBuilt: () => false,
    };
    const served = new Set(selectTools(TOOL_CATALOG, permissions).map(tool => tool.name));
    const ctx: ToolContext<HostDeps> = {
      signal: new AbortController().signal,
      progress: () => undefined,
      client: { name: 'test' },
      deps: {
        services, jobs: { list: () => [] }, permissionOf: () => 'allow', servedTools: () => served, folders,
      } as unknown as HostDeps,
      tool: TOOL_CATALOG.find(tool => tool.name === 'get_status')!,
      startedAt: Date.now(),
      audit: {} as AuditBag,
    };
    return getStatus({}, ctx) as Promise<Record<string, any>>;
  }

  it('names the tools the window serves, and the Zephyr Workbench commands for the ones the user blocked', async () => {
    const full = (await status(FULL)).next_steps.join('\n');
    assert.match(full, /manage_west_workspace action "create"/);
    assert.match(full, /manage_toolchain action "install"/);
    assert.match(full, /manage_app action "create"/);
    assert.match(full, /Register it with manage_app action "import"/);

    const blocked = (await status({ preset: 'custom', tools: { manage_west_workspace: 'block', manage_toolchain: 'block' } }))
      .next_steps.join('\n');
    assert.doesNotMatch(blocked, /manage_west_workspace|manage_toolchain/);
    assert.match(blocked, /"Add West Workspace"/);
    assert.match(blocked, /"Add Toolchain"/);
    assert.match(blocked, /manage_app action "create"/, 'manage_app is still served');
  });

  it('reports the restart a folder change caused, and the changes still waiting', async () => {
    const note = { at: new Date().toISOString(), reason: 'west workspace created', added: ['/ws'], removed: [] };
    const pending = [{ add: ['/other'], remove: [], reason: 'import', requested_at: note.at }];
    const out = await status(FULL, { restartNotice: () => note, pending: () => pending });
    assert.deepEqual(out.restart_notice, note);
    assert.deepEqual(out.pending_folder_changes, pending);
    const quiet = await status(FULL, { restartNotice: () => undefined, pending: () => [] });
    assert.equal(quiet.restart_notice, undefined);
    assert.equal(quiet.pending_folder_changes, undefined);
  });
});
