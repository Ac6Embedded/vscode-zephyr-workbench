import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TOOL_CATALOG } from '../../../mcp/core/catalog';
import { probeBridge } from '../../../mcp/host/bridgeProbe';

const BRIDGE = path.resolve(__dirname, '../../../../out/bridge.cjs');

describe('mcp/host/bridgeProbe', function () {
  this.timeout(20000);

  before(function () {
    if (!fs.existsSync(BRIDGE)) {
      this.skip();
    }
  });

  it('lists the tools with no window running, as an agent would see them', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-probe-'));
    const result = await probeBridge({ command: process.execPath, args: [BRIDGE], env: { ZW_MCP_HOME: home } });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.serverName, 'zephyr-workbench');
    assert.deepEqual(result.tools?.sort(), TOOL_CATALOG.map(t => t.name).sort());
  });

  it('reports a call that finds no window as a failed call, not a crash', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-probe-'));
    const result = await probeBridge({
      command: process.execPath, args: [BRIDGE], env: { ZW_MCP_HOME: home },
      call: { name: 'get_status', arguments: {} },
    });
    assert.equal(result.ok, false);
    assert.equal(result.callFailed, true);
    assert.equal((result.callResult as { error: { code: string } }).error.code, 'WORKBENCH_NOT_RUNNING');
  });

  it('explains a command that does not exist', async () => {
    const result = await probeBridge({ command: '/nonexistent/zw-mcp', args: [], env: {} });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /Could not start|exited/);
  });

  it('flags anything on stdout that is not JSON-RPC', async () => {
    const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-probe-')), 'noisy.js');
    fs.writeFileSync(script, 'console.log("hello from a noisy wrapper"); setTimeout(() => {}, 5000);');
    const result = await probeBridge({ command: process.execPath, args: [script], env: {}, timeoutMs: 4000 });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /not JSON-RPC/);
  });
});
