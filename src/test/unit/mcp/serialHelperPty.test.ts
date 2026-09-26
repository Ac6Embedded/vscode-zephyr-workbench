// scripts/serial/serial_capture.py against a pseudo-terminal: a tiny Python
// "device" holds the master side of a pty pair and the helper captures the
// slave side exactly as it would a board's port. Needs a Python 3 with
// pyserial (ZW_TEST_PYTHON, the managed Zephyr venv, or python3 on PATH) and
// POSIX ptys; skipped otherwise. No real serial port is ever opened.

import { strict as assert } from 'assert';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '../../../../scripts/serial/serial_capture.py');

/** Holds the master side, prints the slave's name, then obeys one command per stdin line. */
const DEVICE = `
import json, os, select, sys, time
master, slave = os.openpty()
print(os.ttyname(slave), flush=True)
for line in sys.stdin:
    command = line.strip()
    if command.startswith('write '):
        os.write(master, json.loads(command[6:]).encode())
    elif command == 'read':
        data = b''
        end = time.time() + 3
        while time.time() < end and not data.endswith(b'\\n'):
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                data += os.read(master, 1024)
        print(json.dumps(data.decode('utf-8', 'replace')), flush=True)
    elif command == 'vanish':
        os.close(master)
        os.close(slave)
        print('gone', flush=True)
    elif command == 'exit':
        break
`;

function pythonWith(module: string | undefined): string | undefined {
  const candidates = [process.env.ZW_TEST_PYTHON, path.join(os.homedir(), '.zinstaller', '.venv', 'bin', 'python'), 'python3'];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const probe = spawnSync(candidate, ['-c', module ? `import ${module}` : 'import sys'], { encoding: 'utf8', timeout: 10000 });
    if (probe.status === 0) {
      return candidate;
    }
  }
  return undefined;
}

/** Lines of a child's stream, awaited one pattern at a time. */
class Lines {
  readonly all: string[] = [];
  private rest = '';
  private waiters: Array<() => void> = [];
  constructor(stream: NodeJS.ReadableStream) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      const parts = (this.rest + chunk).split('\n');
      this.rest = parts.pop() ?? '';
      this.all.push(...parts);
      for (const wake of this.waiters.splice(0)) {
        wake();
      }
    });
  }
  async next(test: (line: string) => boolean, ms = 4000): Promise<string> {
    const deadline = Date.now() + ms;
    for (let seen = 0; ; ) {
      for (; seen < this.all.length; seen++) {
        if (test(this.all[seen])) {
          return this.all[seen];
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out; lines so far: ${JSON.stringify(this.all)}`);
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 100);
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }
}

const eventOf = (name: string) => (line: string) => {
  try {
    return (JSON.parse(line) as { event?: string }).event === name;
  } catch {
    return false;
  }
};

describe('scripts/serial/serial_capture.py', function () {
  this.timeout(20000);
  let python: string | undefined;
  const children: ChildProcess[] = [];

  before(function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    python = pythonWith('serial');
    if (!python) {
      this.skip();
    }
  });

  afterEach(() => {
    for (const child of children.splice(0)) {
      child.kill('SIGKILL');
    }
  });

  it('lists the ports as JSON without opening any', () => {
    const run = spawnSync(python as string, [SCRIPT, '--list'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(run.status, 0, run.stderr);
    const ports = JSON.parse(run.stdout) as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(ports));
    for (const port of ports) {
      assert.deepEqual(Object.keys(port).sort(),
        ['description', 'hwid', 'interface', 'location', 'manufacturer', 'pid', 'port', 'product', 'serial_number', 'vid']);
    }
  });

  it('captures a device: output to stdout, a send to the device, a disconnect, and stdin EOF closes it', async () => {
    const device = spawn(python as string, ['-c', DEVICE], { stdio: ['pipe', 'pipe', 'inherit'] });
    children.push(device);
    const deviceOut = new Lines(device.stdout!);
    const slave = await deviceOut.next(line => line.startsWith('/dev/'));

    // --dtr as for a board's own USB console: a pty has no modem lines, which must not fail the open.
    const helper = spawn(python as string, [SCRIPT, '--port', slave, '--baud', '115200', '--duration', '15', '--dtr'], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(helper);
    const events = new Lines(helper.stderr!);
    let captured = '';
    helper.stdout!.setEncoding('utf8');
    helper.stdout!.on('data', (chunk: string) => { captured += chunk; });
    const exited = new Promise<number | null>(resolve => helper.on('close', code => resolve(code)));

    await events.next(eventOf('opened'));
    device.stdin!.write(`write ${JSON.stringify('*** Booting Zephyr OS ***\r\nuart:~$ ')}\n`);
    const deadline = Date.now() + 4000;
    while (!captured.includes('uart:~$ ') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(captured, '*** Booting Zephyr OS ***\r\nuart:~$ ', 'device bytes reach stdout unchanged');

    helper.stdin!.write(`${JSON.stringify({ id: 7, send: 'kernel version', line_ending: 'crlf' })}\n`);
    const sent = JSON.parse(await events.next(eventOf('sent'))) as { id: number; bytes: number };
    assert.deepEqual([sent.id, sent.bytes], [7, 16]);
    device.stdin!.write('read\n');
    assert.equal(JSON.parse(await deviceOut.next(line => line.startsWith('"'))), 'kernel version\r\n');

    device.stdin!.write('vanish\n');
    await deviceOut.next(line => line === 'gone');
    await events.next(eventOf('disconnected'));

    helper.stdin!.end();
    const closed = JSON.parse(await events.next(eventOf('closed'))) as { reason: string };
    assert.equal(closed.reason, 'stdin');
    assert.equal(await exited, 0);
    device.stdin!.write('exit\n');
  });

  it('refuses a command it cannot encode and keeps capturing', async () => {
    const device = spawn(python as string, ['-c', DEVICE], { stdio: ['pipe', 'pipe', 'inherit'] });
    children.push(device);
    const deviceOut = new Lines(device.stdout!);
    const slave = await deviceOut.next(line => line.startsWith('/dev/'));
    const helper = spawn(python as string, [SCRIPT, '--port', slave, '--baud', '115200', '--duration', '15'], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(helper);
    const events = new Lines(helper.stderr!);
    helper.stdout!.resume();
    const exited = new Promise<number | null>(resolve => helper.on('close', code => resolve(code)));
    await events.next(eventOf('opened'));

    // What JSON.stringify writes for a lone surrogate, and a line ending that is not a name.
    helper.stdin!.write(`${JSON.stringify({ id: 1, send: '\ud800', line_ending: 'crlf' })}\n`);
    helper.stdin!.write(`${JSON.stringify({ id: 2, send: 'x', line_ending: ['crlf'] })}\n`);
    const refused = await events.next(line => eventOf('send_failed')(line) && (JSON.parse(line) as { id: number }).id === 2);
    assert.ok(refused);
    assert.ok(events.all.some(line => eventOf('send_failed')(line) && (JSON.parse(line) as { id: number }).id === 1), events.all.join('\n'));
    helper.stdin!.write(`${JSON.stringify({ id: 3, send: 'kernel version', line_ending: 'crlf' })}\n`);
    await events.next(line => eventOf('sent')(line) && (JSON.parse(line) as { id: number }).id === 3);
    device.stdin!.write('read\n');
    assert.equal(JSON.parse(await deviceOut.next(line => line.startsWith('"'))), 'kernel version\r\n');

    helper.stdin!.end();
    assert.equal(await exited, 0);
    assert.deepEqual(events.all.filter(line => /Traceback|Fatal Python error/.test(line)), []);
    device.stdin!.write('exit\n');
  });

  /**
   * Run the helper with its stdin held open, as the extension host does for
   * the whole capture, until it exits by itself (or `poke` makes it).
   */
  async function runWithStdinOpen(args: string[], poke?: (child: ChildProcess, events: Lines) => Promise<void>):
    Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string[] }> {
    const helper = spawn(python as string, [SCRIPT, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(helper);
    const events = new Lines(helper.stderr!);
    helper.stdout!.resume();
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
      helper.on('close', (code, signal) => resolve({ code, signal })));
    await poke?.(helper, events);
    const { code, signal } = await exited;
    return { code, signal, stderr: events.all };
  }

  const fatal = (lines: string[]) => lines.filter(line => /Fatal Python error|Traceback/.test(line));

  it('reports a port that does not exist as an error event and exits 2, with its stdin still open', async () => {
    const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-serial-')), 'ttyNOPE');
    const run = await runWithStdinOpen(['--port', missing, '--baud', '115200', '--duration', '5']);
    assert.deepEqual([run.code, run.signal], [2, null], run.stderr.join('\n'));
    assert.deepEqual(fatal(run.stderr), []);
    const error = run.stderr.filter(eventOf('error')).map(line => JSON.parse(line) as { code: string })[0];
    assert.equal(error?.code, 'not_found');
  });

  it('exits 0 when --duration elapses or on SIGTERM, with its stdin still open', async () => {
    const device = spawn(python as string, ['-c', DEVICE], { stdio: ['pipe', 'pipe', 'inherit'] });
    children.push(device);
    const slave = await new Lines(device.stdout!).next(line => line.startsWith('/dev/'));

    const timedOut = await runWithStdinOpen(['--port', slave, '--baud', '115200', '--duration', '1']);
    assert.deepEqual([timedOut.code, timedOut.signal], [0, null], timedOut.stderr.join('\n'));
    assert.deepEqual(fatal(timedOut.stderr), []);
    assert.equal((JSON.parse(timedOut.stderr.filter(eventOf('closed'))[0]) as { reason: string }).reason, 'duration');

    const terminated = await runWithStdinOpen(['--port', slave, '--baud', '115200', '--duration', '15'], async (child, events) => {
      await events.next(eventOf('opened'));
      child.kill('SIGTERM');
    });
    assert.deepEqual([terminated.code, terminated.signal], [0, null], terminated.stderr.join('\n'));
    assert.deepEqual(fatal(terminated.stderr), []);
    assert.equal((JSON.parse(terminated.stderr.filter(eventOf('closed'))[0]) as { reason: string }).reason, 'signal');
    device.stdin!.write('exit\n');
  });

  it('treats a termios error during the open as an open error, and reads its errno', function () {
    // pyserial does not wrap every termios call in open(); a device dropping
    // mid-open raises termios.error, which must not kill the helper.
    const check = [
      'import errno, importlib.util, sys, termios',
      `spec = importlib.util.spec_from_file_location("serial_capture", ${JSON.stringify(SCRIPT)})`,
      'module = importlib.util.module_from_spec(spec)',
      'sys.argv = ["serial_capture"]',
      'spec.loader.exec_module(module)',
      'assert termios.error in module.OPEN_ERRORS',
      'print(module.classify(termios.error(errno.EBUSY, "busy")), module.classify(termios.error(errno.EIO, "io")))',
    ].join('\n');
    const run = spawnSync(python as string, ['-c', check], { encoding: 'utf8', timeout: 15000 });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'busy open_failed');
  });

  it('reports a Python without pyserial as pyserial_missing and exits 3', function () {
    // An interpreter without pyserial, when this machine has one.
    const bare = ['/usr/bin/python3', 'python3'].find(candidate =>
      spawnSync(candidate, ['-c', 'import sys'], { timeout: 10000 }).status === 0
      && spawnSync(candidate, ['-c', 'import serial'], { timeout: 10000 }).status !== 0);
    if (!bare) {
      this.skip();
    }
    const run = spawnSync(bare as string, [SCRIPT, '--list'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(run.status, 3);
    assert.ok(run.stderr.split('\n').some(line => line.includes('"pyserial_missing"')), run.stderr);
  });
});
