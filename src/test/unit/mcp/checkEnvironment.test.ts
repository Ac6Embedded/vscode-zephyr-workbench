import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'yaml';
import { TOOL_CATALOG } from '../../../mcp/core/catalog';
import { McpToolError } from '../../../mcp/core/errors';
import { AuditBag, ToolContext } from '../../../mcp/core/toolSpec';
import { HostDeps } from '../../../mcp/host/handlers/deps';
import { checkEnvironment, TOTAL_BUDGET_MS } from '../../../mcp/host/handlers/environment';
import { HostServices } from '../../../mcp/host/services';
import type { DebugToolStatus } from '../../../utils/debugTools/debugToolStatusUtils';
import type { DebugToolsManifest } from '../../../utils/debugTools/debugToolVersionUtils';
import type { HostToolsStatus } from '../../../utils/hostToolsStatusCollector';
import { useUiGuard } from './uiGuard';

// The handler runs against stub services, the shipped runner manifest and the
// vscode stub, whose settings are all empty: the environment script is not
// configured, which is the machine this tool is mostly called on.

const REPO = path.resolve(__dirname, '../../../..');

type UriStub = { file: unknown; joinPath: unknown };
// The raw stub module, whose exports can be swapped for this file's tests.
const stub = require('vscode') as { Uri: UriStub };
const MANIFEST: DebugToolsManifest = yaml.parse(fs.readFileSync(path.join(REPO, 'scripts/runners/debug-tools.yml'), 'utf8'));
const META = TOOL_CATALOG.find(tool => tool.name === 'check_environment')!;

function hostStatus(internalDir: string): HostToolsStatus {
  return {
    internalDir,
    installed: true,
    complete: true,
    envFile: { path: path.join(internalDir, 'env.sh'), exists: true },
    stamp: { path: path.join(internalDir, 'zinstaller_version'), exists: true },
    zinstaller: { installedVersion: '2.1', minimum: '2.0', upToDate: true },
    parts: [{ part: 'cmake', label: 'CMake', present: true, detectedVersion: '', systemDetected: false }],
    presence: { cmake: true },
    undetermined: [],
    missing: [],
    versionCheck: { ran: false },
    errors: [],
  };
}

interface FakeApp {
  appRootPath: string;
  toolchainVariant: string;
  westWorkspaceRootPath: string;
  zephyrSdkPath: string;
  isGlobalSdk: boolean;
  venvPath?: string;
  buildConfigs: FakeConfig[];
}
interface FakeConfig {
  name: string;
  defaultRunner: string;
  getBuildDir(): string;
  getBuildArtifactPath(app: unknown, ...segments: string[]): string | undefined;
}

function harness(opts: {
  apps?: FakeApp[];
  tools?: DebugToolStatus[];
  /** Replaces the tool probes, such as with one that never answers. */
  debugTools?: () => Promise<DebugToolStatus[]>;
  signal?: AbortSignal;
  startedAt?: number;
  /** What xcode-select would say about the macOS Command Line Tools. */
  developerToolsMissing?: boolean;
} = {}) {
  const calls = {
    host: [] as string[],
    hostOptions: [] as { developerToolsMissing?: boolean }[],
    debug: [] as { depth: string; toolIds?: readonly string[] }[],
    developerTools: 0,
  };
  const apps = opts.apps ?? [];
  const services = {
    debugToolsManifest: () => MANIFEST,
    listApplications: async () => apps,
    resolveApp: async (appPath: string) => {
      const app = apps.find(a => a.appRootPath === appPath);
      if (!app) {
        throw new McpToolError('APP_NOT_FOUND', `No application at ${appPath}.`);
      }
      return app;
    },
    resolveConfig: (app: FakeApp, name?: string) => {
      const config = name ? app.buildConfigs.find(c => c.name === name) : app.buildConfigs[0];
      if (!config) {
        throw new McpToolError('CONFIG_NOT_FOUND', `No configuration ${name}.`);
      }
      return config;
    },
    hostToolsStatus: async (depth: string, _timeoutMs?: number, o: { developerToolsMissing?: boolean } = {}) => {
      calls.host.push(depth);
      calls.hostOptions.push(o);
      return hostStatus('/home/u/.zinstaller');
    },
    macDeveloperToolsMissing: async () => {
      calls.developerTools++;
      return opts.developerToolsMissing ?? false;
    },
    debugToolsStatus: async (depth: string, o: { toolIds?: readonly string[] } = {}) => {
      calls.debug.push({ depth, ...(o.toolIds ? { toolIds: o.toolIds } : {}) });
      if (opts.debugTools) {
        return opts.debugTools();
      }
      return (opts.tools ?? []).filter(t => !o.toolIds || o.toolIds.includes(t.id));
    },
    listSdks: async () => [],
  };
  const progress: number[] = [];
  const ctx: ToolContext<HostDeps> = {
    signal: opts.signal ?? new AbortController().signal,
    progress: report => { progress.push(report.progress); },
    client: { name: 'test' },
    deps: { services: services as unknown as HostServices } as HostDeps,
    tool: META,
    startedAt: opts.startedAt ?? Date.now(),
    audit: {} as AuditBag,
  };
  return { ctx, calls, progress };
}

async function errorOf(promise: Promise<unknown>): Promise<McpToolError> {
  try {
    await promise;
  } catch (error) {
    return error as McpToolError;
  }
  assert.fail('expected the call to fail');
}

type Result = Record<string, any>;

describe('check_environment', () => {
  useUiGuard();

  // The internal dir, env.yml and the managed venv follow VSCODE_PORTABLE:
  // point them at an empty folder so the answer does not depend on this machine.
  let saved: string | undefined;
  let root: string;
  // The settings reader tests `scope instanceof vscode.Uri`, which needs a
  // constructor; the shared stub's Uri is a plain object.
  let savedUri: UriStub;
  before(() => {
    savedUri = stub.Uri;
    stub.Uri = Object.assign(function Uri() { /* stub */ }, savedUri);
  });
  after(() => {
    stub.Uri = savedUri;
  });
  beforeEach(() => {
    saved = process.env.VSCODE_PORTABLE;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-checkenv-'));
    process.env.VSCODE_PORTABLE = root;
  });
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.VSCODE_PORTABLE;
    } else {
      process.env.VSCODE_PORTABLE = saved;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses an unknown tool name before probing anything, listing the valid names', async () => {
    const { ctx, calls } = harness();
    const error = await errorOf(checkEnvironment({ tools: ['jlink', 'no-such-probe'] }, ctx));
    assert.equal(error.code, 'INVALID_ARGUMENT');
    assert.match(error.message, /no-such-probe/);
    const available = (error.details as { available: string[] }).available;
    assert.ok(available.includes('openocd') && available.includes('stlink_gdbserver'));
    assert.deepEqual(calls.host, []);
    assert.deepEqual(calls.debug, []);
  });

  it('refuses a tool name that could never be a manifest name', async () => {
    const { ctx } = harness();
    const error = await errorOf(checkEnvironment({ tools: ['jlink; rm -rf ~'] }, ctx));
    assert.equal(error.code, 'INVALID_ARGUMENT');
  });

  it('refuses config_name when no application is selected', async () => {
    const two = [fakeApp('/ws/a'), fakeApp('/ws/b')];
    const { ctx } = harness({ apps: two });
    const error = await errorOf(checkEnvironment({ config_name: 'primary' }, ctx));
    assert.equal(error.code, 'INVALID_ARGUMENT');
  });

  it('checks the machine, not AMBIGUOUS_APP, when several applications are open', async () => {
    const { ctx } = harness({ apps: [fakeApp('/ws/a'), fakeApp('/ws/b')] });
    const result = await checkEnvironment({ depth: 'quick' }, ctx) as Result;
    assert.equal(result.runners, undefined);
    assert.ok(result.notes.some((n: string) => n.includes('/ws/a') && n.includes('/ws/b')));
  });

  it('runs no process at depth quick, and reports the unset env script as a problem, not an error', async () => {
    const { ctx, calls } = harness();
    const result = await checkEnvironment({ depth: 'quick' }, ctx) as Result;
    assert.deepEqual(calls.host, ['quick']);
    assert.deepEqual(calls.debug.map(c => c.depth), ['quick']);
    assert.equal(result.depth, 'quick');
    assert.equal(result.ready, false);
    assert.equal(result.settings.env_script.ok, false);
    assert.ok(result.problems.some((p: { code: string }) => p.code === 'ENV_SCRIPT_NOT_SET'));
    assert.ok(result.next_steps.some((s: string) => s.includes('"Install Host Tools"')));
    assert.equal(result.python.venv.version, undefined);
    assert.equal(result.west.version, undefined);
  });

  it('probes no tool through an env script that cannot be sourced, and says why', async () => {
    const { ctx, calls } = harness();
    const result = await checkEnvironment({ sections: ['debug_tools'] }, ctx) as Result;
    assert.equal(result.depth, 'full');
    assert.deepEqual(calls.debug.map(c => c.depth), ['quick']);
    assert.ok(result.notes.some((n: string) => /not probed because the environment script cannot be sourced/.test(n)));
  });

  it('runs no macOS developer tools stub when the Command Line Tools are missing, and says how to install them', async () => {
    const { ctx, calls } = harness({ developerToolsMissing: true });
    const result = await checkEnvironment({ sections: ['host_tools'] }, ctx) as Result;
    assert.deepEqual(calls.host, ['quick', 'full']);
    assert.deepEqual(calls.hostOptions[1], { developerToolsMissing: true }, 'the installer check must skip the stubs');
    const clt = result.problems.find((p: { code: string }) => p.code === 'XCODE_CLT_MISSING');
    assert.match(clt?.fix ?? '', /xcode-select --install/);
    assert.ok(result.notes.some((n: string) => /Command Line Tools are not installed/.test(n)));
  });

  it('does not ask about the macOS developer tools at depth quick, which runs no process', async () => {
    const { ctx, calls } = harness({ developerToolsMissing: true });
    const result = await checkEnvironment({ depth: 'quick' }, ctx) as Result;
    assert.equal(calls.developerTools, 0);
    assert.ok(!result.problems.some((p: { code: string }) => p.code === 'XCODE_CLT_MISSING'));
  });

  it('returns only the sections asked for, with ready and problems computed from every area', async () => {
    const { ctx, calls } = harness();
    const result = await checkEnvironment({ depth: 'quick', sections: ['settings'] }, ctx) as Result;
    assert.ok(result.settings);
    for (const skipped of ['host_tools', 'python', 'west', 'sdks', 'debug_tools']) {
      assert.equal(result[skipped], undefined, `${skipped} was not asked for`);
    }
    assert.equal(result.ready, false);
    assert.ok(result.problems.some((p: { code: string }) => p.code === 'NO_SDK'));
    assert.deepEqual(calls.host, ['quick'], 'readiness still reads the host tools');
    assert.deepEqual(calls.debug, []);
  });

  it('cross-checks the runners of a built configuration against their tools', async () => {
    const build = fs.mkdtempSync(path.join(root, 'build-'));
    fs.mkdirSync(path.join(build, 'zephyr'));
    fs.writeFileSync(path.join(build, 'zephyr', 'runners.yaml'), yaml.stringify({
      runners: ['jlink', 'openocd', 'stlink_gdbserver', 'qemu'],
      'flash-runner': 'stlink_gdbserver',
      'debug-runner': 'openocd',
    }));
    const app = fakeApp('/ws/app', build);
    const tools: DebugToolStatus[] = [
      tool('jlink', true),
      { ...tool('openocd', true), isAlias: true, updateAvailable: true, name: 'OpenOCD' },
      { ...tool('stm32cubeclt', false), name: 'STM32CubeCLT' },
    ];
    const { ctx, calls } = harness({ apps: [app], tools });
    const result = await checkEnvironment({ app_path: '/ws/app', tools: ['jlink'], sections: ['debug_tools'] }, ctx) as Result;

    assert.deepEqual([...(calls.debug[0].toolIds ?? [])].sort(), ['jlink', 'openocd', 'stm32cubeclt'],
      'the runners\' tools are probed even when tools names others');
    assert.equal(result.runners.built, true);
    assert.equal(result.runners.default_flash_runner, 'stlink_gdbserver');
    const byRunner = Object.fromEntries(result.runners.compatible.map((r: { runner: string }) => [r.runner, r]));
    assert.deepEqual(byRunner.stlink_gdbserver.tool_ids, ['stm32cubeclt']);
    assert.equal(byRunner.stlink_gdbserver.installed, false);
    assert.equal(byRunner.jlink.installed, true);
    assert.equal(byRunner.qemu.installed, null);
    assert.ok(byRunner.qemu.note);

    const missing = result.problems.find((p: { code: string }) => p.code === 'RUNNER_TOOL_MISSING');
    assert.equal(missing.severity, 'error');
    assert.match(missing.message, /stlink_gdbserver/);
    assert.match(missing.message, /STM32CubeCLT/);
    assert.ok(result.problems.some((p: { code: string; message: string }) => p.code === 'RUNNER_TOOL_OUTDATED' && /openocd/.test(p.message)));
    assert.deepEqual(ctx.audit.target, { app_path: '/ws/app', config_name: 'primary' });
  });

  it('raises no missing-tool error for a runner whose tool probe timed out, and says how to retry', async () => {
    const build = fs.mkdtempSync(path.join(root, 'build-'));
    fs.mkdirSync(path.join(build, 'zephyr'));
    fs.writeFileSync(path.join(build, 'zephyr', 'runners.yaml'), yaml.stringify({ runners: ['jlink'], 'flash-runner': 'jlink' }));
    // What the collector reports for a PATH-only tool whose version command was killed.
    const tools: DebugToolStatus[] = [{ ...tool('jlink', false), installed: null, timedOut: true, name: 'J-Link Software' }];
    const { ctx } = harness({ apps: [fakeApp('/ws/app', build)], tools });
    const result = await checkEnvironment({ app_path: '/ws/app', sections: ['debug_tools'] }, ctx) as Result;

    assert.ok(!result.problems.some((p: { code: string }) => p.code === 'RUNNER_TOOL_MISSING'));
    assert.equal(result.runners.compatible[0].installed, null);
    const note = result.notes.find((n: string) => /J-Link Software did not answer in time/.test(n));
    assert.match(note ?? '', /the jlink runner's tool is installed is unknown/);
    assert.match(note ?? '', /tools \["jlink"\]/);
  });

  it('sends an application\'s own venv without west to the application venv command, not Reinstall VENV', async () => {
    const venv = path.join(root, 'app-venv');
    fs.mkdirSync(venv);
    const { ctx } = harness({ apps: [{ ...fakeApp('/ws/app'), venvPath: venv }] });
    const result = await checkEnvironment({ depth: 'quick', sections: ['python'] }, ctx) as Result;
    assert.equal(result.python.venv.source, 'application');
    const west = result.problems.find((p: { code: string }) => p.code === 'WEST_MISSING');
    assert.match(west.fix, /"Create local Python Virtual Environment" on the application/);
    assert.ok(!west.fix.includes('Reinstall VENV'), 'Reinstall VENV rebuilds only the host tools venv');
  });

  it('says a configuration that was never built has unknown runners', async () => {
    const app = fakeApp('/ws/app', path.join(root, 'never-built'));
    const { ctx } = harness({ apps: [app] });
    const result = await checkEnvironment({ depth: 'quick' }, ctx) as Result;
    assert.equal(result.runners.built, false);
    assert.match(result.runners.note, /no runners\.yaml/);
  });

  it('stops waiting when the call budget runs out, and says what did not finish', async () => {
    // Only 300 ms of the budget left, and tool probes that never answer.
    const { ctx } = harness({
      debugTools: () => new Promise<DebugToolStatus[]>(() => undefined),
      startedAt: Date.now() - TOTAL_BUDGET_MS + 300,
    });
    const began = Date.now();
    const result = await checkEnvironment({ depth: 'quick', sections: ['debug_tools'] }, ctx) as Result;
    assert.ok(Date.now() - began < 5000, 'the call returned at the budget');
    assert.equal(result.debug_tools, undefined);
    assert.ok(result.notes.some((n: string) => /flash and debug tool probes did not finish within the 40 second budget/.test(n)));
    assert.ok(Array.isArray(result.problems), 'the rest of the answer is still there');
  });

  it('stops waiting when the agent cancels the call', async () => {
    const abort = new AbortController();
    const { ctx } = harness({ debugTools: () => new Promise<DebugToolStatus[]>(() => undefined), signal: abort.signal });
    setTimeout(() => abort.abort(), 50);
    const result = await checkEnvironment({ depth: 'quick', sections: ['debug_tools'] }, ctx) as Result;
    assert.ok(result.notes.some((n: string) => /not finished when the call was cancelled/.test(n)));
  });

  it('reports an SDK inside the host tools folder, and survives a half-deleted one', async () => {
    const internal = path.join(root, '.zinstaller');
    const sdk = path.join(internal, 'zephyr-sdk-0.17.0');
    fs.mkdirSync(path.join(internal, 'tools'), { recursive: true });
    fs.mkdirSync(sdk);
    // sdk_version alone: reading the SDK throws on the missing toolchain list.
    fs.writeFileSync(path.join(sdk, 'sdk_version'), '0.17.0\n');
    let result = await checkEnvironment({ depth: 'quick', sections: ['sdks'] }, harness().ctx) as Result;
    assert.equal(result.sdks.internal, undefined);

    fs.writeFileSync(path.join(sdk, 'sdk_gnu_toolchains'), 'arm-zephyr-eabi\n');
    result = await checkEnvironment({ depth: 'quick', sections: ['sdks'] }, harness().ctx) as Result;
    assert.equal(result.sdks.internal, sdk);
  });

  it('uses no em-dash anywhere in its answer', async () => {
    const { ctx } = harness({ apps: [fakeApp('/ws/a'), fakeApp('/ws/b')] });
    const result = await checkEnvironment({ depth: 'quick' }, ctx);
    assert.ok(!JSON.stringify(result).includes('—'));
  });
});

function fakeApp(appRootPath: string, buildDir = path.join(appRootPath, 'build', 'primary')): FakeApp {
  return {
    appRootPath,
    toolchainVariant: 'zephyr',
    westWorkspaceRootPath: '',
    zephyrSdkPath: '',
    isGlobalSdk: false,
    buildConfigs: [{
      name: 'primary',
      defaultRunner: '',
      getBuildDir: () => buildDir,
      getBuildArtifactPath: (_app: unknown, ...segments: string[]) => {
        const candidate = path.join(buildDir, ...segments);
        return fs.existsSync(candidate) ? candidate : undefined;
      },
    }],
  };
}

function tool(id: string, installed: boolean): DebugToolStatus {
  return { id, isAlias: false, installableHere: true, installed, updateAvailable: false };
}
