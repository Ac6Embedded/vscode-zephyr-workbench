// The serial actions of the hardware tool on the host side: the real job
// manager, confirmation gate, capture registry and log reading, with a small
// Node script standing in for the Python helper and the board behind it. The
// terminal is stood in for too, so a test can close it like the user would.

import { strict as assert } from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { findTool, TOOL_CATALOG } from '../../../mcp/core/catalog';
import { McpToolError } from '../../../mcp/core/errors';
import { ListedPort } from '../../../mcp/core/serialPorts';
import { STATUS_PREFIX } from '../../../mcp/core/serialStream';
import { ConfirmCategory, ToolContext } from '../../../mcp/core/toolSpec';
import { AskAnswer, Confirmations } from '../../../mcp/host/confirmations';
import { HostDeps } from '../../../mcp/host/handlers/deps';
import { hardware } from '../../../mcp/host/handlers/hardware';
import { captureFields, serialCaptures } from '../../../mcp/host/serial/captures';
import { PortHolder, serialHelper } from '../../../mcp/host/serial/helper';
import { grepSlice } from '../../../mcp/host/serial/serialLog';
import { HostServices } from '../../../mcp/host/services';
import { JobManager, JobState } from '../../../mcp/jobs/jobManager';
import { useUiGuard } from './uiGuard';

/** The helper and the board: lists the ports it is given, then plays a script and answers sends like a Zephyr shell. */
const FAKE_HELPER = `
const fs = require('fs');
const cfg = JSON.parse(process.env.FAKE_SERIAL || '{}');
const args = process.argv.slice(2);
const out = text => fs.writeSync(1, text);
const emit = event => fs.writeSync(2, JSON.stringify(event) + '\\n');
const note = entry => { if (cfg.logFile) { fs.appendFileSync(cfg.logFile, JSON.stringify(entry) + '\\n'); } };
if (args.includes('--list')) {
  note({ list: true });
  if (cfg.pyserialMissing) {
    emit({ event: 'error', code: 'pyserial_missing', message: "No module named 'serial'" });
    process.exit(3);
  }
  out(JSON.stringify(cfg.ports || []) + '\\n');
  process.exit(0);
}
const arg = name => args[args.indexOf(name) + 1];
const port = arg('--port');
const baud = Number(arg('--baud'));
const duration = Number(arg('--duration'));
note({ capture: port, baud, duration, dtr: args.includes('--dtr') });
emit({ event: 'ready' });
if (cfg.openError) {
  emit({ event: 'error', code: cfg.openError, message: cfg.openMessage || 'Resource busy', port });
  process.exit(2);
}
emit({ event: 'opened', port, baud });
for (const step of cfg.script || []) {
  setTimeout(() => {
    if (step.out !== undefined) { out(step.out); }
    if (step.event) { emit(step.event); }
  }, step.at);
}
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  pending += chunk;
  for (let nl = pending.indexOf('\\n'); nl !== -1; nl = pending.indexOf('\\n')) {
    const command = JSON.parse(pending.slice(0, nl));
    pending = pending.slice(nl + 1);
    note({ command });
    const ending = { crlf: '\\r\\n', lf: '\\n', cr: '\\r', none: '' }[command.line_ending];
    emit({ event: 'sent', id: command.id, bytes: Buffer.byteLength(command.send + ending) });
    setTimeout(() => out(command.send + '\\r\\nreply to ' + command.send + '\\r\\n\\u001b[1;32muart:~$ \\u001b[m'), 50);
  }
});
const close = reason => { emit({ event: 'closed', reason }); process.exit(0); };
process.stdin.on('end', () => close('stdin'));
process.on('SIGTERM', () => close('signal'));
setTimeout(() => close('duration'), duration * 1000);
`;

const BOARD_PORT = '/dev/cu.usbmodemOWCSO3OWYSATB3';
const MAC_PORTS: ListedPort[] = [
  { port: '/dev/cu.debug-console', description: 'n/a', hwid: 'n/a', vid: null, pid: null },
  { port: '/dev/cu.Bluetooth-Incoming-Port', description: 'n/a', hwid: 'n/a', vid: null, pid: null },
  {
    port: BOARD_PORT, description: 'MCU-LINK FRDM-MCXA344 (r2E4) CMSIS-DAP V3.172', hwid: 'USB VID:PID=1FC9:0143 SER=OWCSO3OWYSATB LOCATION=1-1.2',
    vid: 0x1fc9, pid: 0x0143, serial_number: 'OWCSO3OWYSATB', manufacturer: 'NXP Semiconductors', product: 'MCU-LINK FRDM-MCXA344 (r2E4) CMSIS-DAP V3.172',
  },
];
const STLINK: ListedPort = { port: '/dev/cu.usbmodem14203', description: 'STM32 STLink', vid: 0x0483, pid: 0x374b };

interface FakeConfig {
  ports?: ListedPort[];
  pyserialMissing?: boolean;
  openError?: string;
  script?: Array<{ at: number; out?: string; event?: Record<string, unknown> }>;
}

interface Harness {
  root: string;
  jobs: JobManager;
  deps: HostDeps;
  asked: string[];
  answers: AskAnswer[];
  confirmActions: ConfirmCategory[];
  /** What the fake helper was asked to do: listings, captures and commands. */
  notes(): Array<{ list?: boolean; capture?: string; baud?: number; duration?: number; dtr?: boolean; command?: Record<string, unknown> }>;
  terminal: string[];
  steps: AbortController[];
  holders: PortHolder[];
  config: FakeConfig & { logFile: string };
}

let current: Harness;

function harness(config: FakeConfig, apps: unknown[] = []): Harness {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-hardware-')));
  const logFile = path.join(root, 'fake.log');
  const services = new HostServices(vscode.Uri.file(os.tmpdir()));
  services.listApplications = async () => apps as never;
  services.knownRoots = async () => [root];
  const jobs = new JobManager({ logPathFor: id => path.join(root, `${id}.log`), recordPathFor: id => path.join(root, `${id}.json`) });
  const h = {
    root, jobs, asked: [], answers: [], confirmActions: ['hardware'], terminal: [], steps: [], holders: [],
    config: { ...config, logFile },
    notes: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []),
  } as unknown as Harness;
  const confirmations = new Confirmations({
    categories: () => h.confirmActions,
    waitMs: () => 2000,
    log: { recordConfirmation: () => undefined },
    ask: async message => {
      h.asked.push(message);
      return h.answers.shift();
    },
  });
  h.deps = {
    services, jobs, confirmations,
    defaultWaitSeconds: 5,
    revealTerminal: 'never',
    get confirmActions() { return h.confirmActions; },
    kconfig: {} as HostDeps['kconfig'],
    extensionContext: {} as HostDeps['extensionContext'],
    folders: {} as HostDeps['folders'],
    refreshViews: async () => undefined,
    servedTools: () => new Set(TOOL_CATALOG.map(tool => tool.name)),
  };
  current = h;
  return h;
}

function ctx(h: Harness): ToolContext<HostDeps> {
  return {
    signal: new AbortController().signal,
    progress: () => undefined,
    client: { name: 'test-agent', version: '1', instance: 'agent-1' },
    deps: h.deps,
    tool: findTool('hardware')!,
    startedAt: Date.now(),
    audit: {},
  };
}

const call = (h: Harness, args: Record<string, unknown>) => hardware(args, ctx(h)) as Promise<any>;

async function errorOf(promise: Promise<unknown>): Promise<McpToolError> {
  try {
    await promise;
  } catch (error) {
    return error as McpToolError;
  }
  throw new Error('expected the call to fail');
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for a condition');
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function logOf(h: Harness, jobId: string): string {
  return fs.readFileSync((h.jobs.get(jobId) as JobState).log.filePath, 'utf8');
}

/** A freestanding application whose last build left the given devicetree. */
function appWithDevicetree(root: string, board: string, dts: string) {
  const appRoot = path.join(root, 'app');
  const dtsPath = path.join(appRoot, 'build', 'primary', 'zephyr', 'zephyr.dts');
  fs.mkdirSync(path.dirname(dtsPath), { recursive: true });
  fs.writeFileSync(dtsPath, dts);
  return {
    appRootPath: appRoot, appName: 'app', appWorkspaceFolder: { uri: { fsPath: appRoot }, name: 'app', index: 0 },
    buildConfigs: [{ name: 'primary', active: true, boardIdentifier: board, getBuildDir: () => path.join(appRoot, 'build', 'primary') }],
    dtsPath,
  };
}

describe('mcp/host/handlers/hardware (serial)', function () {
  this.timeout(20000);
  useUiGuard();

  let fakeHelper: string;
  const saved = { ...serialHelper };

  before(function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    fakeHelper = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-fake-helper-')), 'helper.js');
    fs.writeFileSync(fakeHelper, FAKE_HELPER);
    serialHelper.resolve = () => ({ command: process.execPath, args: [fakeHelper] });
    serialHelper.spawn = (command, args, options) => spawn(command, args, {
      ...options, env: { ...process.env, FAKE_SERIAL: JSON.stringify(current.config) },
    });
    // The terminal is VS Code's; here the step runs, and closing it is aborting its signal.
    serialHelper.runStep = (async (_name: string, sink: { onData(text: string): void }, signal: AbortSignal,
      work: (log: (text: string) => void, signal: AbortSignal, channels: { terminal(text: string): void; record(text: string): void }) => Promise<unknown>) => {
      const step = new AbortController();
      current.steps.push(step);
      const forward = () => step.abort();
      signal.addEventListener('abort', forward, { once: true });
      try {
        return await work(text => sink.onData(text), step.signal, {
          terminal: text => current.terminal.push(text),
          record: text => sink.onData(text),
        });
      } finally {
        signal.removeEventListener('abort', forward);
      }
    }) as never;
    serialHelper.findHolder = async () => current.holders;
  });

  after(() => {
    Object.assign(serialHelper, saved);
    if (fakeHelper) {
      fs.rmSync(path.dirname(fakeHelper), { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    await Promise.all(serialCaptures.list().map(capture => capture.stop('agent')));
    if (current) {
      fs.rmSync(current.root, { recursive: true, force: true });
    }
  });

  it('lists the ports without opening any, marking the USB ones and the one that names the board', async () => {
    const h = harness({ ports: [...MAC_PORTS, STLINK] });
    const app = appWithDevicetree(h.root, 'frdm_mcxa344', '/dts-v1/;\n/ {\n};\n');
    h.deps.services.listApplications = async () => [app] as never;
    const result = await call(h, { action: 'list_ports' });
    const board = result.ports.find((port: { port: string }) => port.port === BOARD_PORT);
    assert.deepEqual({ usb: board.usb, vid: board.vid, pid: board.pid, matches_board: board.matches_board }, { usb: true, vid: '1FC9', pid: '0143', matches_board: true });
    const bluetooth = result.ports.find((port: { port: string }) => port.port === '/dev/cu.Bluetooth-Incoming-Port');
    assert.equal(bluetooth.usb, false);
    assert.equal(bluetooth.description, undefined, 'pyserial\'s "n/a" is no description');
    assert.equal(result.default_port, BOARD_PORT);
    assert.equal(result.default_port_source, 'board_match');
    assert.equal(result.board, 'frdm_mcxa344');
    assert.ok(h.notes().every(note => note.list), 'listing never starts a capture');
  });

  it('starts a capture as a running job on the only USB port, and a repeated start attaches to it', async () => {
    const h = harness({ ports: MAC_PORTS });
    const first = await call(h, { action: 'serial_start' });
    assert.equal(first.kind, 'serial');
    assert.equal(first.status, 'running');
    assert.deepEqual([first.port, first.port_source, first.baud_rate, first.baud_source], [BOARD_PORT, 'only_usb_port', 115200, 'default']);
    assert.match(first.next, /serial_read/);
    assert.equal(first.app_path, undefined, 'no application: the defaults come from the ports alone');
    assert.deepEqual(captureFields(first.job_id), { port: BOARD_PORT, baud_rate: 115200 });
    assert.match(logOf(h, first.job_id), new RegExp(`^${STATUS_PREFIX.replace(/[-]/g, '\\-')}${BOARD_PORT} opened at 115200 baud`));

    const again = await call(h, { action: 'serial_start' });
    assert.equal(again.job_id, first.job_id);
    assert.equal(again.attached, true);
    const same = await call(h, { action: 'serial_start', port: BOARD_PORT, baud_rate: 115200 });
    assert.equal(same.attached, true, 'the same port at the same speed is the same request');
    const other = await errorOf(call(h, { action: 'serial_start', baud_rate: 9600 }));
    assert.equal(other.code, 'BUSY');
    assert.match(other.message, new RegExp(first.job_id.replace(/[.]/g, '\\.')));
    assert.equal(h.notes().filter(note => note.capture).length, 1, 'one helper for the port');
    assert.equal(h.notes().find(note => note.capture)?.dtr, false, 'a probe port opens with DTR low');
  });

  it('raises DTR for a board\'s own Zephyr USB console, which waits for it', async () => {
    const h = harness({ ports: [...MAC_PORTS.slice(0, 2), { port: '/dev/cu.usbmodem1101', vid: 0x2fe3, pid: 0x0004, description: 'USB-DEV' }] });
    const result = await call(h, { action: 'serial_start' });
    assert.equal(result.dtr_raised, true);
    assert.equal(h.notes().find(note => note.capture)?.dtr, true);
    assert.match(logOf(h, result.job_id), /with DTR raised/);
  });

  it('takes the console speed from the build\'s devicetree and the port from the board name', async () => {
    const h = harness({ ports: [...MAC_PORTS, STLINK] });
    const app = appWithDevicetree(h.root, 'frdm_mcxa344', [
      '/dts-v1/;', '/ {', '\tchosen {', '\t\tzephyr,console = &lpuart2;', '\t};',
      '\tlpuart2: lpuart@400a1000 {', '\t\tcurrent-speed = < 0xe100 >;', '\t};', '};', '',
    ].join('\n'));
    h.deps.services.listApplications = async () => [app] as never;
    h.deps.services.artifactPaths = (() => ({ buildDir: path.dirname(app.dtsPath), dtsPath: app.dtsPath, appRootPath: app.appRootPath })) as never;
    const result = await call(h, { action: 'serial_start', app_path: app.appRootPath });
    assert.deepEqual([result.port, result.port_source], [BOARD_PORT, 'board_match']);
    assert.deepEqual([result.baud_rate, result.baud_source, result.console_node], [57600, 'devicetree', '/lpuart@400a1000']);
    assert.equal(result.config_name, 'primary');
    assert.equal(h.notes().find(note => note.capture)?.baud, 57600);
    const joined = await call(h, { action: 'serial_start', app_path: app.appRootPath });
    assert.deepEqual([joined.attached, joined.baud_rate, joined.console_node], [true, 57600, '/lpuart@400a1000']);
    const explicit = await errorOf(call(h, { action: 'serial_start', app_path: app.appRootPath, baud_rate: 115200 }));
    assert.equal(explicit.code, 'BUSY', 'the argument wins over the devicetree, and the port is taken at another speed');
  });

  it('waits for a line of device output, and never matches a status line', async () => {
    const h = harness({
      ports: MAC_PORTS,
      script: [{ at: 300, out: '\u001b[0m*** Booting Zephyr OS build v4.2.0 ***\r\nHello World! frdm_mcxa344\r\n' }],
    });
    const result = await call(h, { action: 'serial_start', wait_for: 'booting zephyr*', wait_sec: 5 });
    assert.equal(result.wait_for.matched, true);
    assert.equal(result.wait_for.line, '*** Booting Zephyr OS build v4.2.0 ***');
    const log = logOf(h, result.job_id);
    assert.equal(Buffer.from(log).subarray(result.wait_for.offset).toString().split('\n')[0], result.wait_for.line);
    assert.equal(Buffer.from(log).subarray(result.next_offset).toString(), 'Hello World! frdm_mcxa344\n');
    assert.ok(h.terminal.join('').includes('\u001b[0m*** Booting'), 'the terminal shows the raw output, colours and all');

    const started = Date.now();
    const status = await call(h, { action: 'serial_read', job_id: result.job_id, wait_for: 'opened', wait_sec: 1 });
    assert.equal(status.wait_for.matched, false, '"opened" is only in a status line');
    assert.ok(Date.now() - started >= 900, 'it waited for the device instead');
  });

  it('says what to do next from how the wait ended, and after a miss reads from where it began', async () => {
    const hit = harness({ ports: MAC_PORTS, script: [{ at: 200, out: '*** Booting Zephyr OS build v4.2.0 ***\r\n' }] });
    const matched = await call(hit, { action: 'serial_start', wait_for: 'booting zephyr*', wait_sec: 5 });
    assert.match(matched.next, /printed the line you waited for/);
    assert.doesNotMatch(matched.next, /reset or flash the board now/, 'the board already booted');
    await serialCaptures.list()[0]?.stop('agent');
    fs.rmSync(hit.root, { recursive: true, force: true });

    const miss = harness({ ports: MAC_PORTS, script: [{ at: 100, out: 'tick 1\r\ntick 2\r\n' }] });
    const missed = await call(miss, { action: 'serial_start', wait_for: 'booting zephyr*', wait_sec: 1 });
    assert.equal(missed.wait_for.matched, false);
    assert.equal(missed.next_offset, 0, 'the output that explains the miss is not skipped');
    assert.match(missed.next, /Nothing matched yet/);
    const read = await call(miss, { action: 'serial_read', job_id: missed.job_id, offset: missed.next_offset });
    assert.match(read.text, /tick 1\ntick 2/);
  });

  it('suggests a start that names the application and port list_ports chose', async () => {
    const h = harness({ ports: [...MAC_PORTS, STLINK] });
    const app = appWithDevicetree(h.root, 'frdm_mcxa344', '/dts-v1/;\n/ {\n};\n');
    h.deps.services.listApplications = async () => [app] as never;
    const result = await call(h, { action: 'list_ports', app_path: app.appRootPath });
    const suggested = JSON.parse(/hardware (\{.*?\}) before/.exec(result.next)![1]);
    assert.deepEqual(suggested, { action: 'serial_start', app_path: app.appRootPath, config_name: 'primary', port: BOARD_PORT });
  });

  it('finds the capture of an application by app_path, which also routes the call to its window', async () => {
    const h = harness({ ports: [...MAC_PORTS, STLINK] });
    const app = appWithDevicetree(h.root, 'frdm_mcxa344', '/dts-v1/;\n/ {\n};\n');
    h.deps.services.listApplications = async () => [app] as never;
    h.deps.services.artifactPaths = (() => ({ buildDir: path.dirname(app.dtsPath), dtsPath: app.dtsPath, appRootPath: app.appRootPath })) as never;
    const started = await call(h, { action: 'serial_start', app_path: app.appRootPath });
    // A second application, so a start that names none belongs to neither.
    const second = { ...app, appRootPath: path.join(h.root, 'other'), appName: 'other' };
    h.deps.services.listApplications = async () => [app, second] as never;
    const other = await call(h, { action: 'serial_start', port: STLINK.port });
    assert.equal(other.app_path, undefined);
    const read = await call(h, { action: 'serial_read', app_path: app.appRootPath });
    assert.equal(read.job_id, started.job_id, 'the capture serial_start made for that application');
    const ambiguous = await errorOf(call(h, { action: 'serial_read' }));
    assert.match(ambiguous.message, /2 captures are running/);
    assert.match(ambiguous.hint ?? '', /job ids/);
    const stopped = await call(h, { action: 'serial_stop', app_path: app.appRootPath });
    assert.equal(stopped.job_id, started.job_id);
    const none = await errorOf(call(h, { action: 'serial_send', app_path: app.appRootPath, text: 'help' }));
    assert.equal(none.code, 'INVALID_ARGUMENT');
    assert.match(none.hint ?? '', /job_id that serial_start returned/);
    await call(h, { action: 'serial_stop', job_id: other.job_id });
  });

  it('reads the output in pages from next_offset, and greps device lines only', async () => {
    const h = harness({ ports: MAC_PORTS, script: [{ at: 100, out: 'line one\r\nline two\r\nline three\r\n' }] });
    const { job_id } = await call(h, { action: 'serial_start', wait_for: 'line three', wait_sec: 5 });
    const whole = logOf(h, job_id);
    let offset = 0;
    let text = '';
    for (let page = 0; page < 20; page++) {
      const slice = await call(h, { action: 'serial_read', job_id, offset, max_chars: 20 });
      assert.ok(slice.text.length <= 20);
      text += slice.text;
      offset = slice.next_offset;
      if (!slice.more) {
        assert.match(slice.next, /everything so far/);
        break;
      }
      assert.match(slice.next, /More output/);
    }
    assert.equal(text, whole, 'pages join up exactly');
    assert.ok(whole.startsWith(STATUS_PREFIX), 'status lines are in the text, marked');

    const grep = await call(h, { action: 'serial_read', job_id, grep: 'TWO' });
    assert.deepEqual([grep.text, grep.matched_lines], ['line two', 1]);
    const statusOnly = await call(h, { action: 'serial_read', job_id, grep: 'opened' });
    assert.equal(statusOnly.matched_lines, 0);
    const byPort = await call(h, { action: 'serial_read', port: BOARD_PORT, offset: whole.indexOf('line three') });
    assert.equal(byPort.text, 'line three\n');
    const alone = await call(h, { action: 'serial_read', offset: whole.length });
    assert.deepEqual([alone.job_id, alone.text, alone.more], [job_id, '', false], 'the only running capture needs no job_id');
  });

  it('greps a log that ends with a prompt without claiming more output is waiting', async () => {
    const h = harness({ ports: MAC_PORTS });
    const file = path.join(h.root, 'prompt.log');
    fs.writeFileSync(file, `Booting Zephyr\n${STATUS_PREFIX}x ---\nhello\nuart:~$ `);
    const first = grepSlice(file, 0, () => true, 8000);
    assert.equal(first.text, 'Booting Zephyr\nhello');
    assert.equal(first.next_offset, fs.statSync(file).size - 'uart:~$ '.length, 'the prompt is looked at again once its line ends');
    assert.equal(first.more, false, 'a line still being received is not more output');
    const again = grepSlice(file, first.next_offset, () => true, 8000);
    assert.deepEqual([again.text, again.next_offset, again.more], ['', first.next_offset, false]);
    const full = grepSlice(file, 0, () => true, 16);
    assert.deepEqual([full.text, full.more], ['Booting Zephyr', true], 'a result cut short does have more');
    assert.equal(grepSlice(file, full.next_offset, () => true, 16).text, 'hello');

    const { job_id } = await call(h, { action: 'serial_start' });
    fs.appendFileSync((h.jobs.get(job_id) as JobState).log.filePath, 'hello\nuart:~$ ');
    const read = await call(h, { action: 'serial_read', job_id, grep: 'hello' });
    assert.equal(read.more, false);
    assert.match(read.next, /everything so far/);
  });

  it('finds a capture by the name that started it, such as a symbolic link to the port', async () => {
    const h = harness({});
    const device = path.join(h.root, 'ttyFAKE0');
    fs.writeFileSync(device, '');
    const link = path.join(h.root, 'usb-FRDM-if00');
    fs.symlinkSync(device, link);
    h.config.ports = [{ port: device, vid: 0x1fc9, pid: 0x0143, description: 'MCU-LINK FRDM-MCXA344' }];
    const started = await call(h, { action: 'serial_start', port: link });
    assert.equal(started.port, device);
    assert.match(started.port_note, /points at/);
    const read = await call(h, { action: 'serial_read', port: link });
    assert.equal(read.job_id, started.job_id);
    const stopped = await call(h, { action: 'serial_stop', port: link });
    assert.deepEqual([stopped.job_id, stopped.stopped], [started.job_id, true]);
    const after = await call(h, { action: 'serial_read', port: link });
    assert.equal(after.job_id, started.job_id, 'an ended capture this window still holds is found the same way');
  });

  it('asks before sending, writes the line to the helper, and waits for the answer after it', async () => {
    const h = harness({ ports: MAC_PORTS });
    const { job_id } = await call(h, { action: 'serial_start' });
    h.answers.push('allow');
    const sent = await call(h, { action: 'serial_send', job_id, text: 'kernel version', wait_for: 'reply to*' });
    assert.equal(h.asked.length, 1);
    assert.match(h.asked[0], new RegExp(`send "kernel version" to the board on ${BOARD_PORT}`));
    assert.deepEqual(sent.sent, { text: 'kernel version', line_ending: 'crlf', bytes: 16 });
    assert.deepEqual(sent.confirmation, { category: 'hardware', outcome: 'allowed' });
    assert.equal(sent.wait_for.matched, true);
    assert.equal(sent.wait_for.line, 'reply to kernel version');
    assert.ok(sent.text.startsWith('kernel version\nreply to kernel version\n'), sent.text);
    assert.deepEqual(h.notes().find(note => note.command)?.command, { id: 1, send: 'kernel version', line_ending: 'crlf' });
    assert.ok(logOf(h, job_id).includes(`${STATUS_PREFIX}sent "kernel version" + crlf ---\n`));

    // The prompt that ended the first answer is not the one a second send waits for.
    await until(() => logOf(h, job_id).endsWith('uart:~$ '));
    h.answers.push('allow');
    const second = await call(h, { action: 'serial_send', job_id, text: 'help', line_ending: 'cr', wait_for: 'uart:~$' });
    assert.equal(second.wait_for.matched, true);
    assert.ok(second.wait_for.offset > sent.wait_for.offset && second.wait_for.offset >= second.offset);
    assert.equal(second.wait_for.line, 'uart:~$ ', 'the colour codes of the prompt are not in the log');
    assert.equal(h.asked.length, 2, 'a different text is a different question');
  });

  it('refuses to send without a running capture, and sends nothing when the user declines', async () => {
    const h = harness({ ports: MAC_PORTS });
    const none = await errorOf(call(h, { action: 'serial_send', text: 'help' }));
    assert.equal(none.code, 'INVALID_ARGUMENT');
    assert.match(none.hint ?? '', /serial_start/);
    const { job_id } = await call(h, { action: 'serial_start' });
    const control = await errorOf(call(h, { action: 'serial_send', job_id, text: 'reboot\u0003' }));
    assert.equal(control.code, 'INVALID_ARGUMENT');
    const reversed = await errorOf(call(h, { action: 'serial_send', job_id, text: 'kernel \u202ereboot\u202c' }));
    assert.equal(reversed.code, 'INVALID_ARGUMENT');
    assert.equal(h.asked.length, 0, 'refused before the user is asked');
    h.answers.push(undefined);
    const declined = await errorOf(call(h, { action: 'serial_send', job_id, text: 'kernel reboot cold' }));
    assert.equal(declined.code, 'USER_DENIED');
    assert.equal(h.asked.length, 1);
    h.answers.push(undefined);
    await errorOf(call(h, { action: 'serial_send', job_id, text: 'echo caf\u00e9' }));
    assert.ok(h.asked[1].includes('send "echo caf\\u00e9" to the board'), `the dialog escapes what the shell may not print: ${h.asked[1]}`);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok(!h.notes().some(note => note.command), 'nothing reached the board');
  });

  it('sends without asking when the user turned the hardware confirmation off', async () => {
    const h = harness({ ports: MAC_PORTS });
    h.confirmActions = [];
    const { job_id } = await call(h, { action: 'serial_start' });
    const sent = await call(h, { action: 'serial_send', job_id, text: 'kernel uptime', wait_for: 'reply to*' });
    assert.equal(h.asked.length, 0);
    assert.equal(sent.confirmation, undefined);
    assert.equal(sent.wait_for.matched, true);
  });

  it('stops a capture: the job ends, the registry forgets it, and its output stays readable', async () => {
    const h = harness({ ports: MAC_PORTS, script: [{ at: 50, out: 'booted\r\n' }] });
    const { job_id } = await call(h, { action: 'serial_start', wait_for: 'booted', wait_sec: 5 });
    const stopped = await call(h, { action: 'serial_stop', job_id });
    assert.equal(stopped.status, 'succeeded');
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.result.stopped_by, 'agent');
    assert.equal(serialCaptures.byJob(job_id), undefined);
    assert.deepEqual(captureFields(job_id), {});
    assert.ok(logOf(h, job_id).endsWith(`${STATUS_PREFIX}closed, stopped by the agent ---\n`));

    const read = await call(h, { action: 'serial_read', job_id });
    assert.equal(read.status, 'succeeded');
    assert.ok(read.text.includes('booted\n'));
    assert.match(read.next, /has ended/);
    const late = await errorOf(call(h, { action: 'serial_send', job_id, text: 'help' }));
    assert.equal(late.code, 'INVALID_ARGUMENT');
    assert.match(late.message, /has ended/);
    const again = await call(h, { action: 'serial_stop', job_id });
    assert.equal(again.stopped, false, 'stopping an ended capture changes nothing');

    // The extension host restarts: only the record and the log are left.
    h.deps.jobs = new JobManager({ logPathFor: id => path.join(h.root, `${id}.log`), recordPathFor: id => path.join(h.root, `${id}.json`) });
    const byPort = await call(h, { action: 'serial_read', port: BOARD_PORT });
    assert.equal(byPort.job_id, job_id, 'a port finds the capture known only from its record');
    assert.ok(byPort.text.includes('booted\n'));
  });

  it('reports a busy port as BUSY_EXTERNAL naming the program that holds it', async () => {
    const h = harness({ ports: MAC_PORTS, openError: 'busy' });
    h.holders = [{ pid: 4242, name: 'screen' }];
    const busy = await errorOf(call(h, { action: 'serial_start' }));
    assert.equal(busy.code, 'BUSY_EXTERNAL');
    assert.match(busy.message, /"screen" \(pid 4242\)/);
    assert.deepEqual(busy.details?.holders, [{ pid: 4242, name: 'screen' }]);
    const failed = h.jobs.list()[0];
    await h.jobs.wait(failed, 3000);
    assert.equal(failed.status, 'failed');
    assert.equal(serialCaptures.list().length, 0);

    h.holders = [{ pid: process.pid, name: 'Code Helper (Plugin)', thisWindow: true }];
    const mine = await errorOf(call(h, { action: 'serial_start' }));
    assert.match(mine.hint ?? '', /Serial Monitor/);

    // Another window's capture helper is a bare "Python" to ps -o comm.
    h.holders = [{ pid: 5151, name: 'Python', workbenchCapture: true }];
    const ours = await errorOf(call(h, { action: 'serial_start' }));
    assert.equal(ours.code, 'BUSY_EXTERNAL');
    assert.match(ours.message, /captured by Zephyr Workbench in another VS Code window/);
    assert.match(ours.hint ?? '', /get_status with all_windows true.*serial_stop/);
  });

  it('reports a missing pyserial as DEPENDENCY_MISSING, naming check_environment', async () => {
    const h = harness({ pyserialMissing: true });
    for (const action of ['list_ports', 'serial_start']) {
      const missing = await errorOf(call(h, { action }));
      assert.equal(missing.code, 'DEPENDENCY_MISSING', action);
      assert.match(missing.hint ?? '', /check_environment/);
    }
  });

  it('stops by itself once duration_sec has passed', async () => {
    const h = harness({ ports: MAC_PORTS });
    const { job_id } = await call(h, { action: 'serial_start', duration_sec: 1 });
    assert.equal(h.notes().find(note => note.capture)?.duration, 1);
    const job = h.jobs.get(job_id) as JobState;
    await h.jobs.wait(job, 5000);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.result?.stopped_by, 'duration');
    assert.equal(serialCaptures.byJob(job_id), undefined);
  });

  it('stops the helper when the job is cancelled, or when the user closes the terminal', async () => {
    const h = harness({ ports: [...MAC_PORTS, STLINK] });
    const first = await call(h, { action: 'serial_start', port: BOARD_PORT });
    h.jobs.cancel(first.job_id);
    const cancelled = h.jobs.get(first.job_id) as JobState;
    // A cancelled job reads as ended at once; its helper still has to exit.
    await until(() => cancelled.endedAt !== undefined, 5000);
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(logOf(h, first.job_id).endsWith(`${STATUS_PREFIX}closed, cancelled ---\n`));

    const second = await call(h, { action: 'serial_start', port: STLINK.port });
    h.steps[h.steps.length - 1].abort();
    const closed = h.jobs.get(second.job_id) as JobState;
    await h.jobs.wait(closed, 5000);
    assert.equal(closed.status, 'succeeded');
    assert.equal(closed.result?.stopped_by, 'terminal');
    assert.equal(serialCaptures.list().length, 0);
  });

  it('shows a disconnect and a reopen as status lines, and refuses a send while the board is away', async () => {
    const h = harness({
      ports: MAC_PORTS,
      script: [
        { at: 100, event: { event: 'disconnected', message: 'device reports readiness to read but returned no data' } },
        { at: 1200, event: { event: 'reopened' } },
        { at: 1300, out: 'back\r\n' },
      ],
    });
    const { job_id } = await call(h, { action: 'serial_start' });
    await until(() => serialCaptures.byJob(job_id)?.state === 'disconnected');
    const away = await errorOf(call(h, { action: 'serial_send', job_id, text: 'help' }));
    assert.equal(away.code, 'BUSY');
    assert.equal(h.asked.length, 0);
    const back = await call(h, { action: 'serial_read', job_id, wait_for: 'back', wait_sec: 5 });
    assert.equal(back.wait_for.matched, true);
    assert.ok(back.text.includes(`${STATUS_PREFIX}the device disconnected; the capture reopens it when it comes back ---\n`));
    assert.ok(back.text.includes(`${STATUS_PREFIX}${BOARD_PORT} reopened ---\nback\n`));
  });

  it('refuses a port that is not listed and arguments an action does not take', async () => {
    const h = harness({ ports: MAC_PORTS });
    const unknown = await errorOf(call(h, { action: 'serial_start', port: '/dev/disk0' }));
    assert.equal(unknown.code, 'INVALID_ARGUMENT');
    assert.match(unknown.hint ?? '', /list_ports/);
    assert.ok(!h.notes().some(note => note.capture), 'nothing was opened');
    for (const [args, pattern] of [
      [{ action: 'serial_read', text: 'x' }, /does not take text/],
      [{ action: 'list_ports', port: BOARD_PORT }, /does not take port/],
      [{ action: 'serial_stop', wait_for: 'x' }, /does not take wait_for/],
      [{ action: 'flash' }, /action must be one of/],
      [{ action: 'serial_start', baud_rate: 100 }, /baud_rate/],
    ] as const) {
      const error = await errorOf(call(h, args));
      assert.equal(error.code, 'INVALID_ARGUMENT', JSON.stringify(args));
      assert.match(error.message, pattern);
    }
    const none = await errorOf(call(h, { action: 'serial_read' }));
    assert.match(none.message, /none is running/);
  });
});
