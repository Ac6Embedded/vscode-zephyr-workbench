import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { posixLauncherScript } from '../../../mcp/agents/launcher';
import { getMcpPaths } from '../../../mcp/core/paths';
import { installBridge } from '../../../mcp/host/bridgeInstaller';
import { checkInstall, launcherRuntime } from '../../../mcp/host/doctor';

function extensionOut(): string {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-doc-ext-'));
  fs.writeFileSync(path.join(out, 'bridge.cjs'), '// bridge');
  return out;
}

const byName = (checks: ReturnType<typeof checkInstall>, name: string) => checks.find(c => c.name === name);

describe('mcp/host/doctor', () => {
  it('reads the runtime back out of a generated launcher, including a quote in the path', () => {
    const paths = getMcpPaths('/tmp/zw');
    for (const runtime of ['/opt/code/code', "/Applications/Roy's Code.app/Contents/MacOS/Code Helper (Plugin)"]) {
      assert.equal(launcherRuntime(posixLauncherScript(paths, runtime, '1')), runtime);
    }
  });

  it('reports a healthy install', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-doc-'));
    const paths = getMcpPaths(home);
    installBridge(paths, extensionOut(), '4.3.0', process.execPath);
    const checks = checkInstall({ paths, extensionVersion: '4.3.0', platform: process.platform, nodeMajor: 24 });
    assert.ok(checks.every(c => c.ok), JSON.stringify(checks, null, 2));
  });

  it('flags an extension host that is too old to run the server', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-doc-'));
    const checks = checkInstall({ paths: getMcpPaths(home), extensionVersion: '4.3.0', platform: 'linux', nodeMajor: 18 });
    const runtime = byName(checks, 'Editor runtime');
    assert.equal(runtime?.ok, false);
    assert.match(runtime?.fix ?? '', /1\.90/);
  });

  it('flags a missing bridge with a fix the user can act on', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-doc-'));
    const checks = checkInstall({ paths: getMcpPaths(home), extensionVersion: '4.3.0', platform: 'linux', nodeMajor: 24 });
    assert.equal(byName(checks, 'Bridge')?.ok, false);
    assert.match(byName(checks, 'Bridge')?.fix ?? '', /Reload/);
  });

  it('flags a bridge older than the extension', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-doc-'));
    const paths = getMcpPaths(home);
    installBridge(paths, extensionOut(), '4.2.0', process.execPath);
    const checks = checkInstall({ paths, extensionVersion: '4.3.0', platform: process.platform, nodeMajor: 24 });
    assert.equal(byName(checks, 'Bridge')?.ok, false);
  });

  it('tolerates a moved editor runtime, because the launcher falls back to node', function () {
    if (process.platform === 'win32') {
      this.skip();
      return;
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-doc-'));
    const paths = getMcpPaths(home);
    installBridge(paths, extensionOut(), '4.3.0', '/nonexistent/editor/runtime');
    const launcher = byName(checkInstall({ paths, extensionVersion: '4.3.0', platform: process.platform, nodeMajor: 24 }), 'Launcher');
    assert.equal(launcher?.ok, true);
    assert.match(launcher?.detail ?? '', /node from PATH/);
  });

  it('flags a launcher that lost its execute bit', function () {
    if (process.platform === 'win32') {
      this.skip();
      return;
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-doc-'));
    const paths = getMcpPaths(home);
    installBridge(paths, extensionOut(), '4.3.0', process.execPath);
    fs.chmodSync(paths.launcher, 0o644);
    const launcher = byName(checkInstall({ paths, extensionVersion: '4.3.0', platform: process.platform, nodeMajor: 24 }), 'Launcher');
    assert.equal(launcher?.ok, false);
    assert.match(launcher?.fix ?? '', /chmod \+x/);
  });
});
