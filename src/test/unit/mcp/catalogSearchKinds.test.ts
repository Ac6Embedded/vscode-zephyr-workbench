// search_zephyr_catalog's project, revision, template and blob kinds, with the
// workspace, the manifest and every remote lookup replaced by fakes, so what
// the handler does with the agent's arguments is tested on its own.

import { strict as assert } from 'assert';
import { findTool } from '../../../mcp/core/catalog';
import { CatalogKind } from '../../../mcp/core/catalogSearch';
import { McpToolError } from '../../../mcp/core/errors';
import { AuditBag, ToolContext } from '../../../mcp/core/toolSpec';
import { searchZephyrCatalog } from '../../../mcp/host/handlers/catalogSearch';
import { HostDeps } from '../../../mcp/host/handlers/deps';
import { useUiGuard } from './uiGuard';

const UPSTREAM = 'https://github.com/zephyrproject-rtos/zephyr';

const DETAILS = {
  name: 'ws', rootPath: '/ws', version: '4.2.0', configPath: '/ws/.west/config', manifestPath: '/ws/manifest/west.yml',
  zephyrBase: 'deps/zephyr', zephyrWestPath: '/ws/deps/zephyr/west.yml', submanifestPaths: [],
  zephyrRepoUrl: UPSTREAM, zephyrRevision: 'v4.2.0', supported: true,
  importAll: false, availableProjects: ['cmsis_6', 'hal_nordic', 'hal_stm32'], selectedProjects: ['cmsis_6', 'hal_stm32'],
  rustEnabled: false,
};

interface Calls { upstream: string[]; revisions: Array<{ url: string; timeoutMs: number }>; lists: string[] }

function lookups(over: { tags?: string[] | Error; branches?: string[] | Error; supportsBlobs?: boolean; workspaces?: number } = {}) {
  const calls: Calls = { upstream: [], revisions: [], lists: [] };
  const workspace = {
    rootUri: { fsPath: '/ws' }, version: '4.2.0', manifestPath: 'manifest', manifestFile: 'west.yml', zephyrBase: 'deps/zephyr',
    supportsBlobs: over.supportsBlobs ?? true,
  };
  const services = {
    listWestWorkspaces: () => Array.from({ length: over.workspaces ?? 1 }, () => workspace),
    resolveWestWorkspace: async () => ({ workspace }),
    catalog: {
      list: (kind: CatalogKind) => {
        calls.lists.push(kind);
        return Promise.resolve({
          source: 'west blobs list', skippedRoots: [], cached: false, listedAt: 0,
          entries: [
            { name: 'img/a.bin', module: 'hal_nordic', status: 'missing' },
            { name: 'lib/b.a', module: 'hal_silabs', status: 'present' },
          ],
        });
      },
      workspaceProjects: () => ({ details: DETAILS, projectFilter: [], rustModulePresent: false }),
      upstreamProjects: async (url: string, revision: string) => {
        calls.upstream.push(`${url}@${revision}`);
        return ['cmsis_6', 'hal_nxp', 'hal_stm32'];
      },
      revisions: async (url: string, timeoutMs: number) => {
        calls.revisions.push({ url, timeoutMs });
        return { tags: over.tags ?? ['v4.2.0', 'v4.1.0'], branches: over.branches ?? ['main'] };
      },
      templates: (_uri: unknown, revision?: string) => ({
        templates: [{ name: 'STM32', modules: ['hal_stm32'], default: true }, { name: 'NXP', modules: ['hal_nxp'] }],
        ...(revision ? { baseModules: ['cmsis_6', 'picolibc'] } : {}),
      }),
    },
  };
  const ctx: ToolContext<HostDeps> = {
    signal: new AbortController().signal,
    progress: () => undefined,
    client: { name: 'test' },
    deps: { services, defaultWaitSeconds: 45, extensionContext: { extensionUri: { fsPath: '/ext' } } } as unknown as HostDeps,
    tool: findTool('search_zephyr_catalog')!,
    startedAt: Date.now(),
    audit: {} as AuditBag,
  };
  return { calls, run: (args: Record<string, unknown>) => searchZephyrCatalog(args, ctx) as Promise<Record<string, any>> };
}

async function rejectsWith(pending: Promise<unknown>, code: string): Promise<McpToolError> {
  let caught: unknown;
  try {
    await pending;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof McpToolError, `expected ${code}, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  return caught;
}

describe('mcp/host/handlers/catalogSearch: projects, revisions, templates and blobs', () => {
  useUiGuard();

  it('refuses url, revision and workspace arguments a kind does not take, before any lookup', async () => {
    const { calls, run } = lookups();
    await rejectsWith(run({ kind: 'board', url: 'https://example.com/x/y' }), 'INVALID_ARGUMENT');
    await rejectsWith(run({ kind: 'revision', revision: 'main' }), 'INVALID_ARGUMENT');
    await rejectsWith(run({ kind: 'project', revision: 'main' }), 'INVALID_ARGUMENT');
    await rejectsWith(run({ kind: 'project', url: 'https://example.com/x/zephyr' }), 'INVALID_ARGUMENT');
    await rejectsWith(run({ kind: 'revision', url: 'https://example.com/x/zephyr', west_workspace: '/ws' }), 'INVALID_ARGUMENT');
    await rejectsWith(run({ kind: 'template', west_workspace: '/ws' }), 'INVALID_ARGUMENT');
    assert.deepEqual(calls, { upstream: [], revisions: [], lists: [] });
  });

  it('refuses a URL or revision that could reach a shell', async () => {
    const { calls, run } = lookups();
    await rejectsWith(run({ kind: 'revision', url: 'https://example.com/x/y;id' }), 'INVALID_ARGUMENT');
    await rejectsWith(run({ kind: 'revision', url: '--upload-pack=x' }), 'INVALID_ARGUMENT');
    await rejectsWith(run({ kind: 'project', url: 'https://example.com/x/zephyr', revision: '-main' }), 'INVALID_ARGUMENT');
    assert.deepEqual(calls.revisions, []);
  });

  it('lists the projects of the workspace manifest with what it imports', async () => {
    const { run } = lookups();
    const out = await run({ kind: 'project' });
    assert.equal(out.manifest.zephyr_revision, 'v4.2.0');
    assert.equal(out.manifest.import_all, false);
    assert.equal(out.west_config.manifest_file, 'west.yml');
    assert.deepEqual(out.items, [
      { name: 'cmsis_6', selected: true }, { name: 'hal_nordic', selected: false }, { name: 'hal_stm32', selected: true },
    ]);
    const filtered = await run({ kind: 'project', pattern: 'hal_*' });
    assert.equal(filtered.total_matches, 2);
  });

  it('lists the projects of a repository revision', async () => {
    const { calls, run } = lookups();
    const out = await run({ kind: 'project', url: UPSTREAM, revision: 'v4.2.0' });
    assert.deepEqual(calls.upstream, [`${UPSTREAM}@v4.2.0`]);
    assert.deepEqual(out.items.map((p: { name: string }) => p.name), ['cmsis_6', 'hal_nxp', 'hal_stm32']);
  });

  it('lists tags then branches of the workspace repository, marking the current revision, under the call budget', async () => {
    const { calls, run } = lookups();
    const out = await run({ kind: 'revision' });
    assert.equal(out.url, UPSTREAM);
    assert.equal(out.current_revision, 'v4.2.0');
    assert.deepEqual(out.items, [
      { name: 'v4.2.0', type: 'tag', current: true }, { name: 'v4.1.0', type: 'tag' }, { name: 'main', type: 'branch' },
    ]);
    assert.ok(calls.revisions[0].timeoutMs <= 30_000 && calls.revisions[0].timeoutMs >= 1000);
  });

  it('asks upstream Zephyr when there is no single workspace, and returns the half that answered', async () => {
    const { calls, run } = lookups({ workspaces: 2, branches: new Error('ls-remote timed out') });
    const out = await run({ kind: 'revision' });
    assert.equal(calls.revisions[0].url, UPSTREAM);
    assert.deepEqual(out.items.map((r: { name: string }) => r.name), ['v4.2.0', 'v4.1.0']);
    assert.match(out.note, /branches could not be read/);
    const failing = lookups({ tags: new Error('did not finish'), branches: new Error('did not finish') });
    await rejectsWith(failing.run({ kind: 'revision', url: 'https://example.com/zephyr' }), 'TIMEOUT');
  });

  it('lists templates, and the base modules of a revision', async () => {
    const { run } = lookups();
    const out = await run({ kind: 'template' });
    assert.deepEqual(out.items.map((t: { name: string }) => t.name), ['STM32', 'NXP']);
    assert.equal(out.base_modules, undefined);
    const withRevision = await run({ kind: 'template', revision: 'v4.2.0', pattern: 'hal_nxp' });
    assert.deepEqual(withRevision.base_modules, ['cmsis_6', 'picolibc']);
    assert.deepEqual(withRevision.items.map((t: { name: string }) => t.name), ['NXP'], 'a pattern also matches template modules');
  });

  it('lists blobs, matched by module, and refuses a Zephyr without west blobs', async () => {
    const { calls, run } = lookups();
    const out = await run({ kind: 'blob', pattern: 'hal_nordic' });
    assert.deepEqual(calls.lists, ['blob']);
    assert.deepEqual(out.items.map((b: { name: string }) => b.name), ['img/a.bin']);
    assert.match(out.note, /fetch_blobs/);
    const old = lookups({ supportsBlobs: false });
    await rejectsWith(old.run({ kind: 'blob' }), 'INVALID_ARGUMENT');
    assert.deepEqual(old.calls.lists, []);
  });
});
