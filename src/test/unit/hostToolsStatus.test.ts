import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as vscode from 'vscode';

// The modules' vscode import resolves to the stub under src/test/unit/stubs
// (NODE_PATH), like the other unit tests.
import { getAdvancedRowParts, getHostToolsParts, HostToolsPartDef } from '../../utils/hostToolsPartsRegistry';
import {
  buildHostToolsPartsStatus,
  displayHostToolVersion,
  parseHostToolsCheckOutput,
  parseWestVersionOutput,
  probeWestVersion,
} from '../../utils/hostToolsStatusUtils';
import { collectHostToolsStatus } from '../../utils/hostToolsStatusCollector';
import { getEnvScriptFilename } from '../../utils/utils';
import { toTerminalText, describeUnfinishedCheck } from '../../utils/hostToolsVerify';

const REPO = path.resolve(__dirname, '../../..');

describe('host tools status', () => {
  describe('parseHostToolsCheckOutput', () => {
    it('reads the byte-stable name [version] lines and nothing else', () => {
      const map = parseHostToolsCheckOutput([
        '------ Check Installed Packages ------',
        'python [3.13.5]',
        'Ninja.exe [1.12.1]',
        '7z [24.08 (x64)]',
        'gperf [NOT INSTALLED]',
        'WARN: -Tools is ignored with -OnlyCheck',
        '',
        'All specified packages are installed.',
      ].join('\r\n'));
      assert.deepEqual(map, { python: '3.13.5', ninja: '1.12.1', '7z': '24.08 (x64)', gperf: 'NOT INSTALLED' });
    });
  });

  describe('buildHostToolsPartsStatus', () => {
    const parts: HostToolsPartDef[] = [
      { id: 'cmake', label: 'CMake', versionKey: 'cmake', targetKey: 'cmake', row: true, selectable: true, probe: { artifact: 'tools/cmake' } },
      { id: 'git', label: 'Git', provider: 'brew', versionKey: 'git', availableText: 'brew', row: true, selectable: true, probe: { cmds: ['git'] } },
      { id: 'system', label: 'System packages', provider: 'distro packages', sudo: true, availableText: 'distro', row: true, selectable: true, probe: { versionKeysAllOf: ['git', 'dtc'] } },
    ];

    it('keeps the Advanced panel row fields exactly as the panel built them', () => {
      const rows = buildHostToolsPartsStatus({ cmake: false, git: true, system: true }, { cmake: '3.28.1', git: '2.44', dtc: 'NOT INSTALLED' }, parts);
      assert.deepEqual(rows.map(({ part, label, present, detectedVersion, systemDetected }) => ({ part, label, present, detectedVersion, systemDetected })), [
        // Absent from .zinstaller but found on PATH: the system provides it.
        { part: 'cmake', label: 'CMake', present: false, detectedVersion: '3.28.1', systemDetected: true },
        { part: 'git', label: 'Git', present: true, detectedVersion: '2.44', systemDetected: false },
        // A batch row lists what it found, and a provider row is never "system only".
        { part: 'system', label: 'System packages', present: true, detectedVersion: 'git 2.44', systemDetected: false },
      ]);
    });

    it('adds the provider, sudo and target version only when asked for targets', () => {
      const withoutTargets = buildHostToolsPartsStatus({}, {}, parts);
      assert.equal(withoutTargets[0].targetVersion, undefined);
      assert.equal(withoutTargets[1].detectedVersion, '-', 'an empty provider cell reads as a dash');
      const rows = buildHostToolsPartsStatus({}, {}, parts, { cmake: '3.31.0' });
      assert.equal(rows[0].targetVersion, '3.31.0');
      assert.equal(rows[1].targetVersion, 'brew');
      assert.equal(rows[1].provider, 'brew');
      assert.equal(rows[2].sudo, true);
    });

    it('never shows NOT INSTALLED as a version', () => {
      assert.equal(displayHostToolVersion('NOT INSTALLED'), '');
      assert.equal(displayHostToolVersion('not installed'), '');
      assert.equal(displayHostToolVersion(undefined), '');
      assert.equal(displayHostToolVersion('1.2'), '1.2');
    });
  });

  describe('west version', () => {
    it('reads the number from west --version output', () => {
      assert.equal(parseWestVersionOutput('West version: v1.2.0\n'), '1.2.0');
      assert.equal(parseWestVersionOutput('west 1.3.0'), '1.3.0');
      assert.equal(parseWestVersionOutput('usage: west'), undefined);
    });

    it('runs west without a shell and settles when it cannot start', async () => {
      const result = await probeWestVersion(path.join(os.tmpdir(), 'no-such-dir-zw', 'west'), 5000);
      assert.equal(result.ok, false);
      assert.ok(result.error);
    });

    it('reads the version from a west launcher', async function () {
      if (process.platform === 'win32') {
        this.skip();
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-west-'));
      try {
        const west = path.join(dir, 'west');
        fs.writeFileSync(west, '#!/bin/sh\necho "West version: v1.4.2"\n', { mode: 0o755 });
        const result = await probeWestVersion(west, 5000);
        assert.deepEqual(result, { ok: true, version: '1.4.2' });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('collectHostToolsStatus without the version check', () => {
    // The internal dir follows VSCODE_PORTABLE, so each test gets its own.
    let saved: string | undefined;
    let root: string;
    const extensionUri = vscode.Uri.file(REPO);
    const internal = () => path.join(root, '.zinstaller');

    beforeEach(() => {
      saved = process.env.VSCODE_PORTABLE;
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-hosttools-'));
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

    it('reports nothing installed on an empty machine, and runs no check', async () => {
      const status = await collectHostToolsStatus(extensionUri);
      assert.equal(status.internalDir, internal());
      assert.equal(status.installed, false);
      assert.equal(status.complete, false);
      assert.equal(status.stamp.exists, false);
      assert.equal(status.zinstaller.upToDate, false);
      assert.equal(status.versionCheck.ran, false);
      assert.equal(status.checkedVersions, undefined);
      assert.deepEqual(status.errors, []);
      assert.equal(status.parts.length, getHostToolsParts().length);
    });

    it('never calls a part missing when only a probe could tell, and leaves python and the venv to their own checks', async () => {
      const status = await collectHostToolsStatus(extensionUri);
      const rows = new Set(getAdvancedRowParts().map(p => p.id));
      for (const id of status.missing) {
        assert.ok(rows.has(id), `${id} is not an installer step`);
        assert.ok(!status.undetermined.includes(id), `${id} is both missing and unknown`);
      }
      for (const part of getHostToolsParts()) {
        const filesOnly = !!part.probe.artifact || !!part.probe.artifactPrefixScan;
        if (!filesOnly) {
          assert.ok(status.undetermined.includes(part.id), `${part.id} can only be confirmed by a probe`);
        } else if (part.row) {
          assert.ok(status.missing.includes(part.id), `${part.id} is known to be absent`);
        }
      }
    });

    it('needs the tools folder, the env script and the completion stamp to call the install complete', async () => {
      fs.mkdirSync(path.join(internal(), 'tools'), { recursive: true });
      fs.writeFileSync(path.join(internal(), getEnvScriptFilename()), '# env\n');
      let status = await collectHostToolsStatus(extensionUri);
      assert.equal(status.installed, true);
      assert.equal(status.envFile.exists, true);
      assert.equal(status.complete, false, 'no stamp: the install did not finish');

      fs.writeFileSync(path.join(internal(), 'zinstaller_version'), 'Script Version: 2.1\n');
      status = await collectHostToolsStatus(extensionUri);
      assert.equal(status.complete, true);
      assert.deepEqual(status.zinstaller, { installedVersion: '2.1', minimum: status.zinstaller.minimum, upToDate: true });

      fs.writeFileSync(path.join(internal(), 'zinstaller_version'), 'Script Version: 1.0\n');
      status = await collectHostToolsStatus(extensionUri);
      assert.equal(status.zinstaller.upToDate, false);
    });
  });

  describe('Verify Host Tools terminal text', () => {
    it('ends every line with CRLF, once', () => {
      assert.equal(toTerminalText('a\nb\r\nc'), 'a\r\nb\r\nc');
    });

    it('explains a check that did not finish, and says nothing otherwise', () => {
      assert.match(describeUnfinishedCheck({ ran: false, error: 'spawn ENOENT' }) ?? '', /could not start: spawn ENOENT/);
      assert.match(describeUnfinishedCheck({ ran: true, timedOut: true }) ?? '', /did not finish in time/);
      assert.equal(describeUnfinishedCheck({ ran: true, exitCode: 254 }), undefined, 'missing packages are the listing, not a failure');
    });
  });
});
