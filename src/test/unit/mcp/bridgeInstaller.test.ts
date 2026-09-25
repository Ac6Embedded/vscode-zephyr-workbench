import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launcherSpec, posixLauncherScript } from '../../../mcp/agents/launcher';
import { defaultMcpHome } from '../../../mcp/core/paths';
import { getMcpPaths } from '../../../mcp/core/paths';
import { compareVersions, installBridge } from '../../../mcp/host/bridgeInstaller';

function fakeExtension(bridgeBody = 'process.stdout.write("bridge-ran:" + process.argv.slice(2).join(","));'): string {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-ext-out-'));
  fs.writeFileSync(path.join(out, 'bridge.cjs'), bridgeBody);
  return out;
}

describe('mcp/host/bridgeInstaller', () => {
  describe('compareVersions', () => {
    it('orders dotted versions numerically, not lexically', () => {
      assert.ok(compareVersions('4.10.0', '4.9.0') > 0, '4.10 must be newer than 4.9');
      assert.ok(compareVersions('4.2.1', '4.2.1') === 0);
      assert.ok(compareVersions('4.2.0', '4.2.1') < 0);
      assert.ok(compareVersions('5', '4.99.99') > 0);
    });
  });

  it('installs the bridge, its version file and the launcher', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-home-'));
    const paths = getMcpPaths(home);
    const result = installBridge(paths, fakeExtension(), '4.3.0', process.execPath);
    assert.equal(result.ok, true);
    assert.equal(result.copied, true);
    assert.ok(fs.existsSync(paths.bridge));
    assert.equal(JSON.parse(fs.readFileSync(paths.bridgeVersion, 'utf8')).version, '4.3.0');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(paths.launcher).mode & 0o111, 0o111, 'the launcher must be executable');
    }
  });

  it('never lets an older editor downgrade a newer bridge', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-home-'));
    const paths = getMcpPaths(home);
    installBridge(paths, fakeExtension('// new'), '4.5.0', process.execPath);
    const older = installBridge(paths, fakeExtension('// old'), '4.3.0', process.execPath);
    assert.equal(older.copied, false, 'VS Code, Insiders and Cursor can share this directory');
    assert.equal(fs.readFileSync(paths.bridge, 'utf8'), '// new');
  });

  it('replaces the bridge for the same or a newer version', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-home-'));
    const paths = getMcpPaths(home);
    installBridge(paths, fakeExtension('// one'), '4.3.0', process.execPath);
    installBridge(paths, fakeExtension('// two'), '4.3.0', process.execPath);
    assert.equal(fs.readFileSync(paths.bridge, 'utf8'), '// two');
  });

  it('reports a missing bridge instead of throwing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-home-'));
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-empty-'));
    const result = installBridge(getMcpPaths(home), empty, '4.3.0', process.execPath);
    assert.equal(result.ok, false);
    assert.match(result.problem ?? '', /not found/);
  });
});

describe('mcp/agents/launcher', () => {
  it('points agent configs at a stable path that never contains a port or a token', () => {
    const paths = getMcpPaths('/home/u/.zephyr-workbench/mcp');
    const spec = launcherSpec(paths, '/opt/code/code', 'auto');
    const joined = [spec.command, ...spec.args].join(' ');
    assert.ok(!/\d{4,5}\/mcp|Bearer|token/i.test(joined));
  });

  it('runs on the editor runtime through a path with spaces and parentheses, as on macOS', function () {
    if (process.platform === 'win32') {
      this.skip();
      return;
    }
    // Recreate the real shape: ".../Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)".
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-launch-'));
    const helperDir = path.join(root, "Code Helper (Plugin).app", 'Contents', 'MacOS');
    fs.mkdirSync(helperDir, { recursive: true });
    const runtime = path.join(helperDir, 'Code Helper (Plugin)');
    fs.symlinkSync(process.execPath, runtime);

    const home = path.join(root, 'home dir');
    const paths = getMcpPaths(home);
    installBridge(paths, fakeExtension(), '4.3.0', runtime);
    const output = execFileSync(paths.launcher, ['--window', 'abc'], { encoding: 'utf8' });
    assert.equal(output, 'bridge-ran:--window,abc', 'arguments must reach the bridge intact');
  });

  it('escapes a single quote in the runtime path', () => {
    const paths = getMcpPaths('/tmp/zw');
    const script = posixLauncherScript(paths, "/Applications/Roy's Code.app/code", '4.3.0');
    assert.match(script, /ZW_NODE='\/Applications\/Roy'\\''s Code\.app\/code'/);
  });

  it('falls back to node when the editor runtime is gone', function () {
    if (process.platform === 'win32') {
      this.skip();
      return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-launch-'));
    const paths = getMcpPaths(path.join(root, 'home'));
    installBridge(paths, fakeExtension(), '4.3.0', path.join(root, 'moved-away', 'code'));
    const output = execFileSync(paths.launcher, [], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` },
    });
    assert.equal(output, 'bridge-ran:');
  });

  it('tells the bridge where a custom home folder is, whatever ZW_MCP_HOME the agent has', function () {
    if (process.platform === 'win32') {
      this.skip();
      return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-launch-'));
    const paths = getMcpPaths(path.join(root, 'custom home'));
    installBridge(paths, fakeExtension('process.stdout.write(process.env.ZW_MCP_HOME || "unset");'), '4.3.0', process.execPath);
    const output = execFileSync(paths.launcher, [], { encoding: 'utf8', env: { ...process.env, ZW_MCP_HOME: '/elsewhere' } });
    assert.equal(output, paths.home);
  });

  it('puts a custom home in the config when the bridge is not started by the launcher', () => {
    const custom = getMcpPaths('/srv/zw');
    assert.equal(launcherSpec(custom, 'C:\\Code\\Code.exe', 'auto', 'node', 'win32').env.ZW_MCP_HOME, custom.home);
    assert.equal(launcherSpec(custom, '/opt/code', 'node', 'node', 'linux').env.ZW_MCP_HOME, custom.home);
    assert.deepEqual(launcherSpec(custom, '/opt/code', 'auto', 'node', 'linux').env, {}, 'the launcher sets it itself');
    const standard = getMcpPaths(defaultMcpHome());
    assert.equal(launcherSpec(standard, 'C:\\Code\\Code.exe', 'auto', 'node', 'win32').env.ZW_MCP_HOME, undefined);
  });
});
