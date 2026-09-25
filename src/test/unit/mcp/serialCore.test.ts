// The pure parts of the serial actions: which port a capture opens, the console
// speed a build's devicetree gives, the argument checks, and how device output
// becomes the job log that wait_for, grep and serial_read work on.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { McpToolError } from '../../../mcp/core/errors';
import {
  assertBaudRate, assertDuration, assertLineEnding, assertPortArgument, assertSendText, DEFAULT_LINE_ENDING, quoteForDialog, SEND_MAX_CHARS,
} from '../../../mcp/core/serialArgs';
import { consoleSpeedFromDevicetree } from '../../../mcp/core/serialConsole';
import { boardKey, choosePort, ListedPort, matchesBoard, normalizePort, portKeys, usbId, wantsDtr, ZEPHYR_USB_VID } from '../../../mcp/core/serialPorts';
import { isStatusLine, scanDeviceLines, SerialLineAssembler, statusLine, utf8Boundary } from '../../../mcp/core/serialStream';
import { readZephyrDeviceTreeReport } from '../../../utils/zephyr/dtsReportParser';

/** The ports of a Mac with an FRDM-MCXA344 plugged in, as pyserial lists them. */
const MAC_PORTS: ListedPort[] = [
  { port: '/dev/cu.debug-console', description: 'n/a', hwid: 'n/a', vid: null, pid: null },
  { port: '/dev/cu.Bluetooth-Incoming-Port', description: 'n/a', hwid: 'n/a', vid: null, pid: null },
  {
    port: '/dev/cu.usbmodemOWCSO3OWYSATB3', description: 'MCU-LINK FRDM-MCXA344 (r2E4) CMSIS-DAP V3.172',
    hwid: 'USB VID:PID=1FC9:0143 SER=OWCSO3OWYSATB LOCATION=1-1.2', vid: 0x1fc9, pid: 0x0143,
    serial_number: 'OWCSO3OWYSATB', manufacturer: 'NXP Semiconductors', product: 'MCU-LINK FRDM-MCXA344 (r2E4) CMSIS-DAP V3.172',
  },
];
const STLINK: ListedPort = {
  port: '/dev/cu.usbmodem14203', description: 'STM32 STLink', vid: 0x0483, pid: 0x374b, manufacturer: 'STMicroelectronics', product: 'STM32 STLink',
};

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as McpToolError).code;
  }
}

describe('mcp/core/serialPorts', () => {
  it('reduces a board identifier to the letters and digits probes use', () => {
    assert.equal(boardKey('frdm_mcxa344'), 'frdmmcxa344');
    assert.equal(boardKey('frdm_mcxa344/mcxa344'), 'frdmmcxa344', 'qualifiers are not part of the name a probe shows');
    assert.equal(boardKey('nrf52840dk/nrf52840'), 'nrf52840dk');
    assert.equal(boardKey('ab'), undefined, 'too short to match reliably');
    assert.equal(boardKey(undefined), undefined);
  });

  it('matches a board against the USB description, product or manufacturer, whatever the punctuation', () => {
    assert.equal(matchesBoard(MAC_PORTS[2], 'frdm_mcxa344'), true);
    assert.equal(matchesBoard(MAC_PORTS[2], 'frdm_mcxn947'), false);
    assert.equal(matchesBoard(STLINK, 'nucleo_f401re'), false);
    assert.equal(matchesBoard(MAC_PORTS[0], 'frdm_mcxa344'), false);
  });

  it('picks the port whose strings name the board', () => {
    const choice = choosePort([...MAC_PORTS, STLINK], { board: 'frdm_mcxa344' });
    assert.ok(choice.ok);
    assert.equal(choice.port.port, '/dev/cu.usbmodemOWCSO3OWYSATB3');
    assert.equal(choice.source, 'board_match');
  });

  it('picks the only USB port, never Bluetooth or the debug console', () => {
    const choice = choosePort(MAC_PORTS, { board: 'nucleo_f401re' });
    assert.ok(choice.ok);
    assert.equal(choice.port.port, '/dev/cu.usbmodemOWCSO3OWYSATB3');
    assert.equal(choice.source, 'only_usb_port');
    const alone = choosePort(MAC_PORTS.slice(0, 2));
    assert.deepEqual(alone.ok ? 'picked' : alone.reason, 'no_usb_port', 'ports without a USB id are only opened when named');
  });

  it('refuses to guess between several USB ports that could be the console', () => {
    const choice = choosePort([...MAC_PORTS, STLINK], { board: 'nucleo_f401re' });
    assert.ok(!choice.ok);
    assert.equal(choice.reason, 'ambiguous');
    assert.deepEqual(choice.candidates.map(port => port.port), ['/dev/cu.usbmodemOWCSO3OWYSATB3', '/dev/cu.usbmodem14203']);
    // One probe with two serial ports, both naming the board.
    const twin = { ...MAC_PORTS[2], port: '/dev/cu.usbmodemOWCSO3OWYSATB5' };
    const both = choosePort([...MAC_PORTS, twin], { board: 'frdm_mcxa344' });
    assert.ok(!both.ok && both.reason === 'ambiguous' && both.candidates.length === 2);
  });

  it('opens an explicit port only when it is listed, never an arbitrary path', () => {
    const listed = choosePort(MAC_PORTS, { requested: '/dev/cu.Bluetooth-Incoming-Port', platform: 'darwin' });
    assert.ok(listed.ok && listed.source === 'argument' && listed.port.port === '/dev/cu.Bluetooth-Incoming-Port');
    for (const requested of ['/dev/disk0', '/etc/passwd', '/dev/cu.usbmodemOWCSO3OWYSATB3; rm -rf ~', 'COM3']) {
      const refused = choosePort(MAC_PORTS, { requested, platform: 'darwin' });
      assert.ok(!refused.ok && refused.reason === 'unknown_port', requested);
    }
  });

  it('opens the call-out twin of a macOS /dev/tty.* name, and follows a symbolic link to a listed port', () => {
    const tty = choosePort(MAC_PORTS, { requested: '/dev/tty.usbmodemOWCSO3OWYSATB3', platform: 'darwin' });
    assert.ok(tty.ok && tty.port.port === '/dev/cu.usbmodemOWCSO3OWYSATB3' && /call-out/.test(tty.note ?? ''));
    const linux: ListedPort[] = [{ port: '/dev/ttyACM0', vid: 0x0d28, pid: 0x0204, description: 'DAPLink CMSIS-DAP' }];
    const byId = choosePort(linux, { requested: '/dev/serial/by-id/usb-ARM_DAPLink-if01', canonical: '/dev/ttyACM0', platform: 'linux' });
    assert.ok(byId.ok && byId.port.port === '/dev/ttyACM0');
    assert.ok(!choosePort(linux, { requested: '/dev/tty.ACM0', platform: 'linux' }).ok, 'the macOS rule stays on macOS');
  });

  it('gives every name a port may be known by, so a capture is found by the name that started it', () => {
    assert.deepEqual(portKeys('/dev/tty.usbmodemOWCSO3OWYSATB3', { platform: 'darwin' }),
      ['/dev/tty.usbmodemOWCSO3OWYSATB3', '/dev/cu.usbmodemOWCSO3OWYSATB3']);
    assert.deepEqual(portKeys('/dev/serial/by-id/usb-ARM_DAPLink-if01', { canonical: '/dev/ttyACM0', platform: 'linux' }),
      ['/dev/serial/by-id/usb-ARM_DAPLink-if01', '/dev/ttyACM0']);
    assert.deepEqual(portKeys('/dev/tty.ACM0', { platform: 'linux' }), ['/dev/tty.ACM0'], 'the macOS rule stays on macOS');
    assert.deepEqual(portKeys('\\\\.\\com7', { platform: 'win32' }), ['COM7']);
    assert.deepEqual(portKeys('/dev/ttyACM0', { canonical: '/dev/ttyACM0', platform: 'linux' }), ['/dev/ttyACM0']);
  });

  it('compares Windows port names without case or device prefix', () => {
    const ports: ListedPort[] = [{ port: 'COM7', vid: 0x1366, pid: 0x1015, description: 'JLink CDC UART Port (COM7)' }];
    assert.equal(normalizePort('\\\\.\\com7', 'win32'), 'COM7');
    assert.ok(choosePort(ports, { requested: 'com7', platform: 'win32' }).ok);
    assert.ok(choosePort(ports, { requested: '\\\\.\\COM7', platform: 'win32' }).ok);
    assert.equal(normalizePort('/dev/ttyACM0', 'linux'), '/dev/ttyACM0');
    assert.ok(!choosePort([{ port: '/dev/ttyACM0', vid: 1 }], { requested: '/dev/TTYACM0', platform: 'linux' }).ok);
  });

  it('raises DTR only for a board\'s own Zephyr USB console, never for a probe', () => {
    assert.equal(wantsDtr({ port: '/dev/ttyACM1', vid: ZEPHYR_USB_VID, pid: 0x0004, description: 'USB-DEV' }), true);
    assert.equal(wantsDtr(MAC_PORTS[2]), false, 'a probe VCOM keeps DTR low');
    assert.equal(wantsDtr({ port: '/dev/ttyACM0', vid: 0x303a, description: 'USB JTAG/serial debug unit' }), false, 'an ESP32 resets on it');
    assert.equal(wantsDtr(MAC_PORTS[0]), false);
  });

  it('writes USB ids the way hwid does', () => {
    assert.equal(usbId(0x1fc9), '1FC9');
    assert.equal(usbId(0x143), '0143');
    assert.equal(usbId(null), undefined);
  });
});

describe('mcp/core/serialConsole', () => {
  let tmp: string;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-serial-dts-'));
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /** Parse a zephyr.dts the way query_devicetree does and read its console speed. */
  function speedOf(dts: string) {
    const file = path.join(tmp, `zephyr-${Math.random().toString(36).slice(2)}.dts`);
    fs.writeFileSync(file, dts);
    const report = readZephyrDeviceTreeReport({ dtsPath: file });
    return consoleSpeedFromDevicetree(report.nodes, report.rawText.split(/\r?\n/));
  }

  // Trimmed from the zephyr.dts of a real frdm_mcxa344 build.
  const FRDM = `/dts-v1/;

/* node '/' defined in deps/zephyr/dts/common/skeleton.dtsi:9 */
/ {
	#address-cells = < 0x1 >;         /* in deps/zephyr/dts/common/skeleton.dtsi:10 */
	model = "NXP FRDM_MCXA344 board"; /* in deps/zephyr/boards/nxp/frdm_mcxa344/frdm_mcxa344.dts:16 */

	/* node '/chosen' defined in deps/zephyr/dts/common/skeleton.dtsi:13 */
	chosen {
		zephyr,sram = &sram0;                     /* in deps/zephyr/boards/nxp/frdm_mcxa344/frdm_mcxa344.dts:31 */
		zephyr,console = &lpuart2;                /* in deps/zephyr/boards/nxp/frdm_mcxa344/frdm_mcxa344.dts:35 */
		zephyr,shell-uart = &lpuart2;             /* in deps/zephyr/boards/nxp/frdm_mcxa344/frdm_mcxa344.dts:36 */
	};

	/* node '/soc' defined in deps/zephyr/dts/arm/nxp/mcx/nxp_mcxa344.dtsi:30 */
	soc {
		/* node '/soc/lpuart@400a0000' defined in deps/zephyr/dts/arm/nxp/mcx/nxp_mcxa344.dtsi:196 */
		lpuart1: lpuart@400a0000 {
			compatible = "nxp,lpuart";       /* in deps/zephyr/dts/arm/nxp/mcx/nxp_mcxa344.dtsi:197 */
			status = "disabled";             /* in deps/zephyr/dts/arm/nxp/mcx/nxp_mcxa344.dtsi:200 */
			current-speed = < 0x2580 >;      /* in test */
		};

		/* node '/soc/lpuart@400a1000' defined in deps/zephyr/dts/arm/nxp/mcx/nxp_mcxa344.dtsi:207 */
		lpuart2: lpuart@400a1000 {
			compatible = "nxp,lpuart";       /* in deps/zephyr/dts/arm/nxp/mcx/nxp_mcxa344.dtsi:208 */
			dma-names = "rx",
			            "tx";                /* in deps/zephyr/dts/arm/nxp/mcx/nxp_mcxa344.dtsi:215 */
			status = "okay";                 /* in deps/zephyr/boards/nxp/frdm_mcxa344/frdm_mcxa344.dts:210 */
			current-speed = < 0x1c200 >;     /* in deps/zephyr/boards/nxp/frdm_mcxa344/frdm_mcxa344.dts:211 */
			pinctrl-names = "default";       /* in deps/zephyr/boards/nxp/frdm_mcxa344/frdm_mcxa344.dts:213 */
		};
	};
};
`;

  it('reads the current-speed of the chosen console from a real board devicetree', () => {
    assert.deepEqual(speedOf(FRDM), { node: '/soc/lpuart@400a1000', baud: 115200 });
  });

  it('reads the console node\'s own property, not one of a child node', () => {
    const dts = `/dts-v1/;
/ {
	chosen {
		zephyr,console = &uart0;
	};
	uart0: serial@1000 {
		compatible = "vnd,uart";
		gnss {
			current-speed = < 0x2580 >;
		};
		current-speed = < 921600 >;
	};
};
`;
    assert.deepEqual(speedOf(dts), { node: '/serial@1000', baud: 921600 });
  });

  it('follows a path reference and an alias, and reports a console without a speed', () => {
    const byPath = `/dts-v1/;
/ {
	chosen {
		zephyr,console = &{/soc/serial@2000};
	};
	soc {
		serial@2000 {
			current-speed = < 0xe100 >;
		};
	};
};
`;
    assert.deepEqual(speedOf(byPath), { node: '/soc/serial@2000', baud: 57600 });
    const byAlias = `/dts-v1/;
/ {
	aliases {
		console-uart = &cdc;
	};
	chosen {
		zephyr,console = "console-uart";
	};
	cdc: cdc-acm {
		compatible = "zephyr,cdc-acm-uart";
	};
};
`;
    assert.deepEqual(speedOf(byAlias), { node: '/cdc-acm' });
  });

  it('gives nothing when the devicetree has no console', () => {
    assert.equal(speedOf('/dts-v1/;\n/ {\n\tchosen {\n\t\tzephyr,sram = &sram0;\n\t};\n};\n'), undefined);
    assert.equal(speedOf('/dts-v1/;\n/ {\n\tmodel = "x";\n};\n'), undefined);
  });
});

describe('mcp/core/serialArgs', () => {
  it('bounds the baud rate and the duration', () => {
    assert.equal(assertBaudRate(115200), 115200);
    for (const bad of [299, 4_000_001, 9600.5, '115200', undefined]) {
      assert.equal(codeOf(() => assertBaudRate(bad)), 'INVALID_ARGUMENT', String(bad));
    }
    assert.equal(assertDuration(3600), 3600);
    assert.equal(codeOf(() => assertDuration(3601)), 'INVALID_ARGUMENT');
    assert.equal(codeOf(() => assertDuration(0)), 'INVALID_ARGUMENT');
  });

  it('sends one printable line, tab allowed, and no control character that could drive the device', () => {
    assert.equal(assertSendText('kernel version', 'crlf'), 'kernel version');
    assert.equal(assertSendText('log\tlevel', 'crlf'), 'log\tlevel');
    assert.equal(assertSendText('', 'crlf'), '', 'an empty line is Enter');
    for (const bad of ['reboot\n', 'a\rb', '\u0003', '\u001b[A', 'x\u0000', 'del\u007f', 'c1\u009b']) {
      assert.equal(codeOf(() => assertSendText(bad, 'crlf')), 'INVALID_ARGUMENT', JSON.stringify(bad));
    }
    assert.equal(codeOf(() => assertSendText('x'.repeat(SEND_MAX_CHARS + 1), 'crlf')), 'INVALID_ARGUMENT');
    assert.equal(codeOf(() => assertSendText('', 'none')), 'INVALID_ARGUMENT', 'nothing to send');
    assert.equal(codeOf(() => assertSendText(42, 'crlf')), 'INVALID_ARGUMENT');
  });

  it('refuses text holding half of a UTF-16 surrogate pair, which cannot be encoded for the device', () => {
    assert.equal(assertSendText('echo \ud83d\ude00', 'crlf'), 'echo \ud83d\ude00', 'a whole pair is one character');
    for (const bad of ['\ud800', 'kernel \udc00version', 'end\ud83d']) {
      assert.equal(codeOf(() => assertSendText(bad, 'crlf')), 'INVALID_ARGUMENT', JSON.stringify(bad));
    }
  });

  it('refuses invisible format characters, which would make the confirmation show another text than the board gets', () => {
    // RLO draws "reboot" backwards and the shell drops the bytes it cannot print: the user would allow "kernel toober".
    for (const bad of ['kernel \u202ereboot\u202c', 'kernel\u200b reboot', 'a\u200db', '\ufeffhelp', 'x\u2066y\u2069', 'line\u2028two', 'p\u2029q', 'soft\u00adhyphen']) {
      assert.equal(codeOf(() => assertSendText(bad, 'crlf')), 'INVALID_ARGUMENT', JSON.stringify(bad));
    }
    assert.equal(assertSendText('caf\u00e9 \u20ac', 'crlf'), 'caf\u00e9 \u20ac', 'visible text beyond ASCII is still sent');
  });

  it('quotes the text for the confirmation dialog with everything beyond printable ASCII escaped', () => {
    assert.equal(quoteForDialog('kernel version'), '"kernel version"');
    assert.equal(quoteForDialog('say "hi"\tnow'), '"say \\"hi\\"\\tnow"');
    assert.equal(quoteForDialog('caf\u00e9 \u202e'), '"caf\\u00e9 \\u202e"');
    assert.equal(quoteForDialog('\ud83d\ude00'), '"\\ud83d\\ude00"');
  });

  it('defaults the line ending to CRLF, which the Zephyr shell takes as one newline', () => {
    assert.equal(assertLineEnding(undefined), DEFAULT_LINE_ENDING);
    assert.equal(DEFAULT_LINE_ENDING, 'crlf');
    assert.equal(assertLineEnding('cr'), 'cr');
    assert.equal(codeOf(() => assertLineEnding('crlf\n')), 'INVALID_ARGUMENT');
  });

  it('takes a port name without control characters or absurd length', () => {
    assert.equal(assertPortArgument(' /dev/ttyACM0 '), '/dev/ttyACM0');
    for (const bad of ['', '   ', '/dev/tty\nACM0', 'x'.repeat(300), 3]) {
      assert.equal(codeOf(() => assertPortArgument(bad)), 'INVALID_ARGUMENT', JSON.stringify(bad));
    }
  });
});

describe('mcp/core/serialStream', () => {
  const feed = (assembler: SerialLineAssembler, ...chunks: string[]) => chunks.map(chunk => assembler.push(chunk)).join('');

  it('turns \\r\\n into \\n, even when a read splits the pair', () => {
    const assembler = new SerialLineAssembler();
    assert.equal(feed(assembler, '*** Booting Zephyr OS ***\r', '\nHello World! frdm_mcxa344\r\n'),
      '*** Booting Zephyr OS ***\nHello World! frdm_mcxa344\n');
  });

  it('removes colour and cursor sequences, even split across reads', () => {
    const assembler = new SerialLineAssembler();
    const log = feed(assembler, '\u001b[1;32muart:~$ \u001b[m', 'kernel version\r\n', '\u001b[', '0m[00:00:01.000,000] \u001b]0;title\u0007<inf> main: ok\r\n');
    assert.equal(log, 'uart:~$ kernel version\n[00:00:01.000,000] <inf> main: ok\n');
  });

  it('keeps only the final state of a line the device redraws before it ends', () => {
    const assembler = new SerialLineAssembler();
    assert.equal(feed(assembler, 'progress 10%\rprogress 50%\r', 'progress 100%\r\n'), 'progress 100%\n');
  });

  it('writes a waiting prompt out on flush, and starts a redrawn line on a new log line', () => {
    const assembler = new SerialLineAssembler();
    assert.equal(feed(assembler, 'uart:~$ '), '', 'a line without its newline waits');
    assert.equal(assembler.hasPending, true);
    assert.equal(assembler.flushPartial(), 'uart:~$ ');
    // The shell clears the prompt to print a log message, then prints it again.
    assert.equal(feed(assembler, '\r\u001b[K[00:00:05.000,000] <inf> main: tick\r\n'), '\n[00:00:05.000,000] <inf> main: tick\n');
    // What the device adds to a flushed prompt continues its line.
    assembler.push('uart:~$ ');
    assembler.flushPartial();
    assert.equal(feed(assembler, 'help\r\n'), 'help\n');
  });

  it('puts a status line on a line of its own, marked so it is never taken for device output', () => {
    const assembler = new SerialLineAssembler();
    assert.equal(feed(assembler, 'half a li'), '');
    assert.equal(assembler.status('the device disconnected'), `half a li\n${statusLine('the device disconnected')}\n`);
    assert.equal(assembler.status('reopened'), `${statusLine('reopened')}\n`);
    assert.ok(isStatusLine(statusLine('x')));
    assert.ok(!isStatusLine('--- not ours ---'));
  });

  it('applies backspace and drops other control characters', () => {
    const assembler = new SerialLineAssembler();
    assert.equal(feed(assembler, 'helo\bp\u0007\u0000\r\n'), 'help\n');
    assert.equal(feed(assembler, 'tab\there\n'), 'tab\there\n');
  });

  it('finds the first device line that matches, with its byte offset, skipping status lines', () => {
    const log = Buffer.from(`${statusLine('/dev/ttyACM0 opened at 115200 baud')}\nsé Booting\nuart:~$ `);
    const matches = (line: string) => /booting|opened|uart/i.test(line);
    const hit = scanDeviceLines(log, 100, matches, true);
    assert.equal(hit.hit?.line, 'sé Booting');
    assert.equal(hit.hit?.offset, 100 + Buffer.byteLength(`${statusLine('/dev/ttyACM0 opened at 115200 baud')}\n`));
    // A prompt without a newline matches only at the end of the log.
    const prompt = (line: string) => line.startsWith('uart:~$');
    const atEnd = scanDeviceLines(log, 0, prompt, true);
    assert.equal(atEnd.hit?.line, 'uart:~$ ');
    const notYet = scanDeviceLines(log, 0, prompt, false);
    assert.equal(notYet.hit, undefined);
    assert.equal(notYet.resumeAt, log.length - Buffer.byteLength('uart:~$ '), 'the next scan starts at the unfinished line');
    // Only status lines match: nothing.
    assert.equal(scanDeviceLines(log, 0, line => /opened/.test(line), true).hit, undefined);
  });

  it('never ends a slice inside a UTF-8 character', () => {
    const text = Buffer.from('ab€');
    assert.equal(utf8Boundary(text), 5);
    assert.equal(utf8Boundary(text.subarray(0, 4)), 2, 'the euro sign is cut: stop before it');
    assert.equal(utf8Boundary(text.subarray(0, 3)), 2);
    assert.equal(utf8Boundary(Buffer.from('plain')), 5);
    assert.equal(utf8Boundary(Buffer.from('😀').subarray(0, 3)), 0);
  });
});
