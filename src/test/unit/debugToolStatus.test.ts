import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The module's vscode import resolves to the stub under src/test/unit/stubs
// (NODE_PATH). The version commands run through the env-sourced shell, so the
// stub's settings are swapped to point the env script at an empty file.
import {
  collectDebugToolsStatus,
  describeProbeOutcome,
  PROBE_STOPPED_STATUS,
  PROBE_TIMED_OUT_STATUS,
  probeDebugToolAliasStatus,
  probeDebugToolStatus,
} from '../../utils/debugTools/debugToolStatusUtils';
import type { DebugToolEnvData } from '../../utils/debugTools/debugToolManifestUtils';
import type { DebugToolEntry, DebugToolsManifest } from '../../utils/debugTools/debugToolVersionUtils';

type UriStub = { file: unknown; joinPath: unknown };
type GetConfiguration = (...args: unknown[]) => unknown;
// The raw stub module, whose exports can be swapped for this file's tests.
const stub = require('vscode') as { Uri: UriStub; workspace: { getConfiguration: GetConfiguration } };

/** A node one-liner as a shell command, so the version command is the same on every OS. */
function node(script: string): string {
  return `"${process.execPath}" -e "${script.replace(/"/g, '\\"')}"`;
}

// Answers after 3 s: longer than every limit these tests give it.
const SLOW: DebugToolEntry = {
  tool: 'zw-slow',
  version: '1.0',
  ['version-command']: node("setTimeout(()=>console.log('Slow 1.0'),3000)"),
  ['version-regex']: 'Slow (\\d+\\.\\d+)',
};
const FAST: DebugToolEntry = {
  tool: 'zw-fast',
  version: '1.0',
  ['version-command']: node("console.log('Fast 1.0')"),
  ['version-regex']: 'Fast (\\d+\\.\\d+)',
};
const MANIFEST: DebugToolsManifest = {
  aliases: [{ alias: 'zw-alias', ['version-command']: SLOW['version-command'], ['version-regex']: SLOW['version-regex'] }],
  debug_tools: [SLOW, FAST, { tool: 'zw-alias-a', alias: 'zw-alias', version: '1.0' }],
};

describe('debug tool status', () => {
  describe('describeProbeOutcome', () => {
    const answered = { installed: false, updateAvailable: false };

    it('keeps a finished probe\'s answer, "Not installed" included', () => {
      const outcome = describeProbeOutcome(answered, () => true);
      assert.equal(outcome.installed, false);
      assert.equal(outcome.status, 'Not installed');
      assert.equal(describeProbeOutcome({ installed: true, version: '2.0', updateAvailable: true }, () => null).status, 'New Version Available');
    });

    it('never reads a probe that timed out as not installed', () => {
      const pathOnly = describeProbeOutcome({ ...answered, timedOut: true }, () => null);
      assert.equal(pathOnly.installed, null, 'only a probe could tell, and none answered');
      assert.equal(pathOnly.status, PROBE_TIMED_OUT_STATUS);
      assert.equal(pathOnly.timedOut, true);

      const detected = describeProbeOutcome({ ...answered, timedOut: true }, () => true);
      assert.equal(detected.installed, true, 'the install root on disk still answers');
      assert.equal(detected.status, 'Installed');

      // An explicit-detect tool whose paths match nothing is absent whatever the probe says.
      assert.equal(describeProbeOutcome({ ...answered, timedOut: true }, () => false).status, 'Not installed');
    });

    it('treats a stopped probe like one that timed out, and never claims an update without an answer', () => {
      const stopped = describeProbeOutcome({ installed: true, updateAvailable: true, aborted: true }, () => null);
      assert.equal(stopped.installed, null);
      assert.equal(stopped.status, PROBE_STOPPED_STATUS);
      assert.equal(stopped.updateAvailable, false);
      assert.ok(!PROBE_TIMED_OUT_STATUS.includes('—') && !PROBE_STOPPED_STATUS.includes('—'));
    });

    it('leaves the status empty for a tool whose reference version is ignored', () => {
      assert.equal(describeProbeOutcome({ ...answered, timedOut: true }, () => null, true).status, '');
    });
  });

  describe('probing through the env-sourced shell', function () {
    this.timeout(20000);
    let saved: string | undefined;
    let root: string;
    let savedUri: UriStub;
    let savedGetConfiguration: GetConfiguration;

    before(function () {
      // The env script is a POSIX shell script here; Windows sources env.ps1.
      if (process.platform === 'win32') {
        this.skip();
      }
    });
    beforeEach(() => {
      saved = process.env.VSCODE_PORTABLE;
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-debugtools-'));
      process.env.VSCODE_PORTABLE = root;
      const envScript = path.join(root, 'env.sh');
      fs.writeFileSync(envScript, '# empty env script\n');
      savedUri = stub.Uri;
      savedGetConfiguration = stub.workspace.getConfiguration;
      // The settings reader tests `scope instanceof vscode.Uri`, which needs a constructor.
      stub.Uri = Object.assign(function Uri() { /* stub */ }, savedUri);
      stub.workspace.getConfiguration = () => ({
        get: (key: string) => (key === 'zephyr-workbench.pathToEnvScript' ? envScript : undefined),
        inspect: () => undefined,
        update: async () => undefined,
      });
    });
    afterEach(() => {
      stub.Uri = savedUri;
      stub.workspace.getConfiguration = savedGetConfiguration;
      if (saved === undefined) {
        delete process.env.VSCODE_PORTABLE;
      } else {
        process.env.VSCODE_PORTABLE = saved;
      }
      fs.rmSync(root, { recursive: true, force: true });
    });

    const envData: DebugToolEnvData = {};

    it('reports a PATH-only tool whose version command timed out as unknown, not absent', async () => {
      const [row] = await collectDebugToolsStatus({ manifest: MANIFEST, envData, toolIds: ['zw-slow'], probe: true, timeoutMs: 500 });
      assert.equal(row.timedOut, true);
      assert.equal(row.installed, null, 'a killed probe is no evidence the tool is missing');
      assert.match(row.note ?? '', /did not answer in time/);
    });

    it('answers a timed-out tool from its install on disk', async () => {
      const install = fs.mkdtempSync(path.join(root, 'install-'));
      const withPath: DebugToolEnvData = { runners: { 'zw-slow': { path: install }, 'zw-alias-a': { path: install } } };
      const [tool] = await collectDebugToolsStatus({ manifest: MANIFEST, envData: withPath, toolIds: ['zw-slow'], probe: true, timeoutMs: 500 });
      assert.equal(tool.installed, true);
      assert.equal(tool.detectedPath, install);
      const [alias] = await collectDebugToolsStatus({ manifest: MANIFEST, envData: withPath, toolIds: ['zw-alias'], probe: true, timeoutMs: 500 });
      assert.equal(alias.timedOut, true);
      assert.equal(alias.installed, true, 'the alias follows its selected variant\'s install');
      assert.equal(alias.detectedPath, install);
    });

    it('does not start a probe with too little of the deadline left, and answers from the filesystem', async () => {
      const started = Date.now();
      const [row] = await collectDebugToolsStatus({
        manifest: MANIFEST, envData, toolIds: ['zw-slow'], probe: true, timeoutMs: 15000, deadline: Date.now() + 500,
      });
      assert.ok(!row.timedOut, 'the probe was never started, so it could not be killed');
      assert.equal(row.installed, null);
      assert.match(row.note ?? '', /Not probed/);
      assert.ok(Date.now() - started < 400, 'nothing waited on a spawn');
    });

    it('still probes a tool with enough time left', async () => {
      const [row] = await collectDebugToolsStatus({
        manifest: MANIFEST, envData, toolIds: ['zw-fast'], probe: true, timeoutMs: 15000, deadline: Date.now() + 15000,
      });
      assert.equal(row.installed, true);
      assert.equal(row.version, '1.0');
      assert.equal(row.note, undefined);
    });

    it('shows no answer in the Install Runners panel instead of "Not installed"', async () => {
      const tool = await probeDebugToolStatus(MANIFEST, SLOW, envData, { timeoutMs: 500 });
      assert.equal(tool.status, PROBE_TIMED_OUT_STATUS);
      assert.equal(tool.installed, null);
      const alias = await probeDebugToolAliasStatus(MANIFEST, envData, 'zw-alias', { timeoutMs: 500 });
      assert.equal(alias?.status, PROBE_TIMED_OUT_STATUS);
    });
  });
});
