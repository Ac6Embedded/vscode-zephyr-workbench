import { strict as assert } from 'assert';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  DEVELOPER_TOOLS_MISSING_ENV,
  findOnMacPath,
  isXcodeStub,
  macDeveloperToolsMissing,
  pythonCandidatesWithoutStubs,
  XCODE_STUB_COMMANDS,
} from '../../utils/macDeveloperTools';
import { probePythonInterpreter, runHostToolsOnlyCheck } from '../../utils/hostToolsStatusUtils';

const REPO = path.resolve(__dirname, '../../..');
const INSTALL_MAC = path.join(REPO, 'scripts', 'hosttools', 'install-mac.sh');

/** Whether this Mac has its developer tools, asked the one way that never opens a dialog. */
function hasDeveloperTools(): boolean {
  return spawnSync('/usr/bin/xcode-select', ['-p']).status === 0;
}

describe('macOS developer tools', () => {
  describe('macDeveloperToolsMissing', () => {
    it('asks nothing off macOS', async () => {
      let ran = false;
      const missing = await macDeveloperToolsMissing({ platform: 'linux', run: async () => { ran = true; return { exitCode: 2, stdout: '' }; } });
      assert.equal(missing, false);
      assert.equal(ran, false);
    });

    it('reads xcode-select: no developer folder, or one that is gone, is missing', async () => {
      const ask = (exitCode: number | null, stdout: string, exists = true) =>
        macDeveloperToolsMissing({ platform: 'darwin', run: async () => ({ exitCode, stdout }), exists: () => exists });
      assert.equal(await ask(2, ''), true, 'xcode-select exits 2 when no developer folder is set');
      assert.equal(await ask(0, '/Library/Developer/CommandLineTools\n'), false);
      assert.equal(await ask(0, '/Applications/Xcode.app/Contents/Developer\n', false), true, 'a selection left on a deleted Xcode');
      assert.equal(await ask(null, ''), false, 'no answer is not proof they are missing');
    });
  });

  describe('the system Python candidates without the developer tools', () => {
    const executables = (...paths: string[]) => (target: string) => paths.includes(target);

    it('never keeps a /usr/bin stub, and keeps a real Python found first', () => {
      assert.deepEqual(pythonCandidatesWithoutStubs(['python3', 'python'], '/usr/bin:/opt/py/bin',
        executables('/usr/bin/python3', '/opt/py/bin/python3', '/opt/py/bin/python')), ['/opt/py/bin/python'],
      'python3 resolves to the stub first, as the shell would run it');
      assert.deepEqual(pythonCandidatesWithoutStubs(['python3', 'python'], '/opt/homebrew/bin:/usr/bin',
        executables('/opt/homebrew/bin/python3', '/usr/bin/python3')), ['/opt/homebrew/bin/python3']);
      assert.deepEqual(pythonCandidatesWithoutStubs(['python3', 'python'], '/usr/bin:/bin', executables('/usr/bin/python3')), []);
    });

    it('resolves a name as the shell would, first match on PATH', () => {
      assert.equal(findOnMacPath('git', '/a:/b/:/c', executables('/b/git', '/c/git')), '/b/git');
      assert.equal(findOnMacPath('git', '', executables('/usr/bin/git')), undefined);
    });

    it('knows the stubs by their /usr/bin path only', () => {
      for (const name of XCODE_STUB_COMMANDS) {
        assert.equal(isXcodeStub(`/usr/bin/${name}`), true, name);
        assert.equal(isXcodeStub(`/opt/homebrew/bin/${name}`), false, name);
      }
      assert.equal(isXcodeStub('/usr/bin/file'), false, 'a real system binary');
    });
  });

  describe('install-mac.sh check mode', () => {
    it('skips every stub the TypeScript side knows of', () => {
      const script = fs.readFileSync(INSTALL_MAC, 'utf8');
      assert.ok(script.includes(DEVELOPER_TOOLS_MISSING_ENV));
      const pattern = /case "\$\(command -v "\$probe_cmd"\)" in\s+([^)]+)\)/.exec(script)?.[1] ?? '';
      assert.deepEqual(pattern.split('|').map(p => p.trim()).sort(), XCODE_STUB_COMMANDS.map(name => `/usr/bin/${name}`).sort());
    });

    it('reports a stub as not installed without running it, and keeps every other row', function () {
      if (process.platform !== 'darwin') {
        this.skip();
      }
      this.timeout(60000);
      const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-onlycheck-'));
      const check = (flag: boolean) => spawnSync('/bin/bash', [INSTALL_MAC, '--only-check', installDir], {
        encoding: 'utf8',
        // /usr/bin/make stays the stub: Homebrew installs GNU make as gmake.
        env: { ...process.env, PATH: '/usr/bin:/bin', ...(flag ? { [DEVELOPER_TOOLS_MISSING_ENV]: '1' } : {}) },
      }).stdout;
      try {
        const flagged = check(true);
        assert.match(flagged, /^make \[NOT INSTALLED\]$/m);
        assert.match(flagged, /^file \[\d[^\]]*\]$/m, 'a real /usr/bin tool is still checked');
        if (hasDeveloperTools()) {
          // Only here is running the stub safe; it proves the flag is what skipped it.
          assert.match(check(false), /^make \[\d[^\]]*\]$/m);
        }
      } finally {
        fs.rmSync(installDir, { recursive: true, force: true });
      }
    });
  });

  describe('runHostToolsOnlyCheck', () => {
    const restore: Array<() => void> = [];
    afterEach(() => {
      restore.splice(0).reverse().forEach(undo => undo());
    });
    /** Set an environment variable for this test only. */
    const setEnv = (key: string, value: string) => {
      const saved = process.env[key];
      restore.push(() => {
        if (saved === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved;
        }
      });
      process.env[key] = value;
    };

    it('hands the missing developer tools to the installer check, which then runs no stub', async function () {
      if (process.platform !== 'darwin') {
        this.skip();
      }
      this.timeout(60000);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-onlycheck-'));
      restore.push(() => fs.rmSync(root, { recursive: true, force: true }));
      setEnv('VSCODE_PORTABLE', root);
      setEnv('PATH', '/usr/bin:/bin');
      const check = await runHostToolsOnlyCheck({ fsPath: REPO } as never, { timeoutMs: 30000, developerToolsMissing: true });
      assert.equal(check.ran, true, check.error);
      assert.equal(check.versions.make, 'NOT INSTALLED');
      assert.ok(check.versions.file && check.versions.file !== 'NOT INSTALLED', 'the other rows are still checked');
    });
  });

  describe('probePythonInterpreter', () => {
    let savedPath: string | undefined;
    let dir: string | undefined;
    beforeEach(function () {
      if (process.platform !== 'darwin') {
        this.skip();
      }
      savedPath = process.env.PATH;
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-python-'));
    });
    afterEach(() => {
      if (dir) {
        if (savedPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = savedPath;
        }
        fs.rmSync(dir, { recursive: true, force: true });
        dir = undefined;
      }
    });

    it('does not run /usr/bin/python3 when the developer tools are missing', async () => {
      process.env.PATH = '/usr/bin:/bin';
      const result = await probePythonInterpreter('system', undefined, { developerToolsMissing: true });
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /Command Line Tools are not installed/);
    });

    it('still probes a Python found before the stub, by its full path', async () => {
      const fake = path.join(dir!, 'python3');
      fs.writeFileSync(fake, `#!/bin/sh\necho ${fake}\necho 3.12.4\n`, { mode: 0o755 });
      process.env.PATH = `${dir}:/usr/bin:/bin`;
      const result = await probePythonInterpreter('system', undefined, { developerToolsMissing: true });
      assert.deepEqual(result, { ok: true, exePath: fake, version: '3.12.4', tooOld: false });
    });
  });
});
