import { strict as assert } from 'assert';

// The module's vscode import resolves to the stub under src/test/unit/stubs
// (NODE_PATH). The stub's settings are all empty, which is exactly the
// "env script not configured" case the hang fix is about.
import { captureCommand } from '../../utils/execUtils';

type UriStub = { file: unknown; joinPath: unknown };
// The raw stub module, whose exports can be swapped for this file's tests.
const stub = require('vscode') as { Uri: UriStub };

/** A node one-liner as a shell command, so the test runs the same on every OS. */
function node(script: string): string {
  return `"${process.execPath}" -e "${script.replace(/"/g, '\\"')}"`;
}

describe('captureCommand', () => {
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

  it('captures both streams and the exit code without sourcing the env script', async () => {
    const result = await captureCommand(node("process.stdout.write('out');process.stderr.write('err');process.exit(3)"), {
      timeoutMs: 20000,
      sourceEnv: false,
    });
    assert.equal(result.ran, true);
    assert.equal(result.exitCode, 3);
    assert.equal(result.stdout, 'out');
    assert.equal(result.stderr, 'err');
    assert.ok(!result.timedOut);
  });

  it('settles at once, without running anything, when the env script is not configured', async () => {
    // A bare execCommandWithEnv callback never fired here, so probes hung.
    const started = Date.now();
    const result = await captureCommand(node("require('fs').writeFileSync('should-not-exist','x')"), { timeoutMs: 20000 });
    assert.equal(result.ran, false);
    assert.match(result.error ?? '', /Missing Zephyr environment script/);
    assert.ok(Date.now() - started < 2000);
  });

  it('closes stdin, so a command waiting for input reads end of input', async () => {
    const result = await captureCommand(
      node("let n=0;process.stdin.on('data',d=>n+=d.length);process.stdin.on('end',()=>{process.stdout.write('eof '+n)})"),
      { timeoutMs: 20000, sourceEnv: false },
    );
    assert.equal(result.stdout, 'eof 0');
    assert.equal(result.exitCode, 0);
  });

  it('kills a command that runs past its timeout and keeps what it printed', async function () {
    this.timeout(15000);
    const started = Date.now();
    const result = await captureCommand(node("process.stdout.write('started');setInterval(()=>{},1000)"), {
      timeoutMs: 1500,
      sourceEnv: false,
    });
    assert.equal(result.ran, true);
    assert.equal(result.timedOut, true);
    assert.equal(result.stdout, 'started');
    assert.ok(Date.now() - started < 8000, 'the timeout must end the wait');
  });

  it('stops when the caller aborts', async function () {
    this.timeout(15000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await captureCommand(node('setInterval(()=>{},1000)'), {
      timeoutMs: 20000,
      sourceEnv: false,
      signal: controller.signal,
    });
    assert.equal(result.aborted, true);
    assert.ok(!result.timedOut);
  });

  it('adds the caller\'s variables to the command\'s environment', async () => {
    const result = await captureCommand(node("process.stdout.write((process.env.ZW_TEST_FLAG||'unset')+' '+(process.env.PATH?'path':'nopath'))"), {
      timeoutMs: 20000,
      sourceEnv: false,
      env: { ZW_TEST_FLAG: 'set' },
    });
    assert.equal(result.stdout, 'set path', 'added on top of the inherited environment');
    assert.equal(process.env.ZW_TEST_FLAG, undefined, 'the extension host environment is untouched');
  });

  it('forwards the output as it arrives', async () => {
    const seen: string[] = [];
    const result = await captureCommand(node("console.log('one');console.error('two')"), {
      timeoutMs: 20000,
      sourceEnv: false,
      onOutput: text => seen.push(text),
    });
    const all = seen.join('');
    assert.match(all, /one/);
    assert.match(all, /two/);
    assert.equal(result.exitCode, 0);
  });
});
