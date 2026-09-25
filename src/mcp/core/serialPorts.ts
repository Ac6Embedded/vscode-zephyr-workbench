// Which serial port a capture opens. Pure, so the choice is unit tested on
// every platform, and vendor-agnostic: it knows USB ids and board names, never
// probe brands.
//
// An explicit port must be one the helper listed. The agent's text is never
// opened as it is, which keeps a capture from opening /dev/disk0 or a path
// crafted to look like a port.

/** One port as the helper lists it (pyserial's ListPortInfo, flattened). */
export interface ListedPort {
  port: string;
  description?: string | null;
  hwid?: string | null;
  vid?: number | null;
  pid?: number | null;
  serial_number?: string | null;
  manufacturer?: string | null;
  product?: string | null;
  location?: string | null;
  interface?: string | null;
}

export type PortSource = 'argument' | 'board_match' | 'only_usb_port';

export type PortChoice =
  | { ok: true; port: ListedPort; source: PortSource; note?: string }
  | {
    ok: false;
    /** unknown_port: the argument is not a listed port; no_usb_port: nothing to pick; ambiguous: several to pick from. */
    reason: 'unknown_port' | 'no_usb_port' | 'ambiguous';
    candidates: ListedPort[];
  };

/**
 * The form two port names are compared in, and the capture's lock key.
 * Windows names ignore case and may carry the \\.\ device prefix; POSIX
 * device paths are compared exactly.
 */
export function normalizePort(port: string, platform: NodeJS.Platform = process.platform): string {
  const trimmed = port.trim();
  return platform === 'win32' ? trimmed.replace(/^\\\\[.?]\\/, '').toUpperCase() : trimmed;
}

/** A port that belongs to a USB device, which every board probe and USB console is. */
export function isUsbPort(port: ListedPort): boolean {
  return typeof port.vid === 'number';
}

/**
 * A board identifier reduced to letters and digits, the way probes spell the
 * board in their USB strings: frdm_mcxa344/mcxa344 gives frdmmcxa344, which
 * "MCU-LINK FRDM-MCXA344 (r2E4)" contains. Undefined for a name too short to
 * match anything reliably.
 */
export function boardKey(board: string | undefined): string | undefined {
  const name = (board ?? '').split('/')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  return name.length >= 4 ? name : undefined;
}

/** True when the port's USB description, product or manufacturer names the board. */
export function matchesBoard(port: ListedPort, board: string | undefined): boolean {
  const key = boardKey(board);
  if (!key) {
    return false;
  }
  return [port.description, port.product, port.manufacturer]
    .some(text => typeof text === 'string' && text.toLowerCase().replace(/[^a-z0-9]/g, '').includes(key));
}

interface PortNameOptions {
  platform?: NodeJS.Platform;
  /** The requested path with symbolic links resolved, when it has any. */
  canonical?: string;
}

/** The names a requested port may stand for, most direct first. */
function portAliases(requested: string, options: PortNameOptions): Array<{ name: string; how: 'exact' | 'link' | 'call_out' }> {
  const aliases: Array<{ name: string; how: 'exact' | 'link' | 'call_out' }> = [{ name: requested, how: 'exact' }];
  // A symbolic link such as /dev/serial/by-id/... names the port it points at.
  if (options.canonical && options.canonical !== requested) {
    aliases.push({ name: options.canonical, how: 'link' });
  }
  // macOS lists only the call-out device. Its /dev/tty.* twin waits for a
  // carrier signal a board never raises, so the /dev/cu.* one is opened.
  if ((options.platform ?? process.platform) === 'darwin' && requested.startsWith('/dev/tty.')) {
    aliases.push({ name: `/dev/cu.${requested.slice('/dev/tty.'.length)}`, how: 'call_out' });
  }
  return aliases;
}

/**
 * Every normalized name a requested port may be known by: itself, the port a
 * symbolic link points at, and on macOS the call-out twin of a /dev/tty.*
 * name. A capture is keyed on the listed name serial_start opened, and is
 * found again by any of these.
 */
export function portKeys(requested: string, options: PortNameOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  return [...new Set(portAliases(requested, options).map(alias => normalizePort(alias.name, platform)))];
}

/** The listed port an argument names, or undefined. */
export function findListedPort(
  ports: readonly ListedPort[], requested: string, options: PortNameOptions = {},
): { port: ListedPort; note?: string } | undefined {
  const platform = options.platform ?? process.platform;
  for (const alias of portAliases(requested, options)) {
    const port = ports.find(entry => normalizePort(entry.port, platform) === normalizePort(alias.name, platform));
    if (!port) {
      continue;
    }
    switch (alias.how) {
      case 'exact':
        return { port };
      case 'link':
        return { port, note: `${requested} points at ${port.port}, which was opened.` };
      case 'call_out':
        return { port, note: `${requested} was opened as ${port.port}, its call-out device, which does not wait for a carrier signal.` };
    }
  }
  return undefined;
}

/**
 * Pick the port to capture: the argument when given (it must be listed),
 * else the USB port whose strings name the board, else the only USB port.
 * Ports without a USB id (Bluetooth, the macOS debug console, legacy COM1)
 * are never picked on their own.
 */
export function choosePort(ports: readonly ListedPort[], options: PortNameOptions & {
  requested?: string;
  board?: string;
} = {}): PortChoice {
  if (options.requested !== undefined) {
    const found = findListedPort(ports, options.requested, options);
    return found
      ? { ok: true, port: found.port, source: 'argument', ...(found.note ? { note: found.note } : {}) }
      : { ok: false, reason: 'unknown_port', candidates: [...ports] };
  }
  const usb = ports.filter(isUsbPort);
  const matched = usb.filter(port => matchesBoard(port, options.board));
  if (matched.length === 1) {
    return { ok: true, port: matched[0], source: 'board_match' };
  }
  if (matched.length > 1) {
    // Two boards of the same kind, or one probe with several serial ports.
    return { ok: false, reason: 'ambiguous', candidates: matched };
  }
  if (usb.length === 1) {
    return { ok: true, port: usb[0], source: 'only_usb_port' };
  }
  return usb.length === 0
    ? { ok: false, reason: 'no_usb_port', candidates: [...ports] }
    : { ok: false, reason: 'ambiguous', candidates: usb };
}

/** The USB vendor id of Zephyr's own USB device stack (CONFIG_USB_DEVICE_VID). */
export const ZEPHYR_USB_VID = 0x2fe3;

/**
 * Whether a capture raises DTR once the port is open. Captures keep DTR and
 * RTS low, so a board whose reset is wired to them is not reset. A port
 * served by Zephyr's own USB stack is the board itself, with no reset circuit
 * on those lines, and Zephyr's USB console waits for DTR before it prints
 * (samples/subsys/usb/console), so there DTR is raised.
 */
export function wantsDtr(port: ListedPort): boolean {
  return port.vid === ZEPHYR_USB_VID;
}

/** Four hex digits, as USB ids are usually written: 8137 gives "1FC9". */
export function usbId(value: number | null | undefined): string | undefined {
  return typeof value === 'number' ? value.toString(16).toUpperCase().padStart(4, '0') : undefined;
}
