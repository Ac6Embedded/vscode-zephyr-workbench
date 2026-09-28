// Argument checks and west flash flags of the flash action of the hardware
// tool. Pure, so every rule is unit tested without a board: which option each
// runner takes the probe serial number with, which rebuild flag the Zephyr
// version understands, and what a failed flash means for the next call.

import { assertSafeShellFragment } from './argSafety';
import { McpToolError } from './errors';
import { logSafe } from './redact';

/** A Zephyr runner name, as runners.yaml and `west flash --runner` spell it. */
const RUNNER_NAME = /^[a-z][a-z0-9_]*$/;
/**
 * A probe serial number or id: interpolated unquoted, so the shape is strict,
 * and it never starts with -, which west would read as an option of its own.
 */
const DEV_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DEV_ID_MAX = 128;

/**
 * Runners that flash through a serial port (Zephyr runners/*.py), so they
 * cannot open it while a capture holds it. uf2 copies to a drive and dfu uses
 * USB, so neither is here.
 */
export const SERIAL_PORT_RUNNERS: ReadonlySet<string> = new Set([
  'esp32', 'bossac', 'stm32flash', 'gd32isp', 'rfp', 'sftool', 'bflb_mcu_tool', 'mpcli', 'sy1xx',
]);

/**
 * Runners that do not declare the dev_id capability but select a probe with
 * an option of their own: openocd through the board cfg's _ZEPHYR_BOARD_SERIAL,
 * and linkserver, which declares dev_id but only reads --probe.
 */
const PROBE_OPTION: Readonly<Record<string, string>> = {
  openocd: '--serial',
  linkserver: '--probe',
};

/**
 * Other options of a runner that set its dev_id (dest='dev_id' in Zephyr
 * runners/*.py), so they select a probe too. Per runner: uf2's --board-id
 * is something else.
 */
const DEV_ID_ALIASES: Readonly<Record<string, readonly string[]>> = {
  jlink: ['--id'],
  pyocd: ['--board-id'],
  nrfjprog: ['--snr'],
  nrfutil: ['--snr'],
  'dfu-util': ['--pid'],
  rtsflash: ['--pid'],
  canopen: ['--node-id'],
};

export function assertFlashRunner(value: unknown): string {
  if (typeof value !== 'string' || !RUNNER_NAME.test(value) || value.length > 64) {
    throw new McpToolError('INVALID_ARGUMENT',
      `runner must be a Zephyr runner name of lowercase letters, digits and _, such as jlink or openocd, not "${logSafe(value, 80)}".`, {
        hint: 'Call list_runners to see the runners this build supports.',
      });
  }
  return value;
}

export function assertDevId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > DEV_ID_MAX || !DEV_ID.test(value)) {
    throw new McpToolError('INVALID_ARGUMENT',
      `dev_id must be a probe serial number of letters, digits and . _ : -, starting with a letter or digit, not "${logSafe(value, 80)}".`, {
        hint: 'Call hardware with action "list_ports": the serial_number of the probe\'s port is usually its dev_id.',
      });
  }
  return value;
}

/** The option a runner takes the probe serial number with. */
export function devIdOption(runner: string): string {
  return PROBE_OPTION[runner] ?? '--dev-id';
}

/**
 * The west flash arguments that select the probe `devId`. Most openocd board
 * cfgs never read _ZEPHYR_BOARD_SERIAL, so openocd also gets `adapter serial`
 * before init, which every adapter driver honours; setting it twice is harmless.
 */
export function devIdArgs(runner: string, devId: string): string[] {
  const args = [`${devIdOption(runner)} ${devId}`];
  if (runner === 'openocd') {
    args.push(`--cmd-pre-init "adapter serial ${devId}"`);
  }
  return args;
}

export interface ZephyrVersion {
  major: number;
  minor: number;
}

/**
 * The flag that keeps west flash from rebuilding. --no-rebuild exists from
 * Zephyr 4.3 on, where --skip-rebuild is only deprecated; before 4.3 only
 * --skip-rebuild exists, so it is also the answer when the version is unknown.
 */
export function noRebuildFlag(version: ZephyrVersion | undefined): '--no-rebuild' | '--skip-rebuild' {
  if (version && (version.major > 4 || (version.major === 4 && version.minor >= 3))) {
    return '--no-rebuild';
  }
  return '--skip-rebuild';
}

/** Split a command-line fragment into words, honouring quotes, and drop the quotes. */
export function splitWords(value: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: string | undefined;
  let inWord = false;
  for (const ch of value) {
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else {
        word += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) {
        words.push(word);
      }
      word = '';
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (inWord) {
    words.push(word);
  }
  return words;
}

/**
 * Options of `west flash` itself. Its parser accepts any unambiguous prefix,
 * so --run is --runner there, and each is matched by prefix.
 */
const WEST_OPTIONS = [
  '--runner', '--build-dir', '--domain', '--context', '--cmake-cache', '--board-dir',
  '--skip-rebuild', '--rebuild', '--no-rebuild',
];
/** What the call has an argument for, named so the refusal can say which. */
const ARGUMENT_OF: Readonly<Record<string, string>> = {
  '--runner': 'runner', '--build-dir': 'app_path and config_name', '--domain': 'domain',
  '--cmake-cache': 'app_path and config_name', '--board-dir': 'app_path and config_name',
  '--skip-rebuild': 'rebuild', '--rebuild': 'rebuild', '--no-rebuild': 'rebuild',
  '--erase': 'erase', '--dev-id': 'dev_id', '--serial': 'dev_id', '--probe': 'dev_id',
  '--id': 'dev_id', '--board-id': 'dev_id', '--snr': 'dev_id', '--pid': 'dev_id', '--node-id': 'dev_id',
  'adapter serial': 'dev_id',
};
/** Short options of west flash (-r -d -H -c) and of the runners (-i for --dev-id). */
const SHORT_OPTION = /^-([rdHci])/;
const SHORT_NAME: Readonly<Record<string, string>> = { r: '--runner', d: '--build-dir', H: '--context', c: '--cmake-cache', i: '--dev-id' };
/** The openocd command that picks the adapter, as dev_id does. */
const ADAPTER_SERIAL = /(?:^|=)\s*adapter\s+serial\b/;

/** Every option that selects the probe with this runner. */
export function probeOptionsOf(runner: string): string[] {
  return ['--dev-id', devIdOption(runner), ...(DEV_ID_ALIASES[runner] ?? [])];
}

export interface ReservedOption {
  /** The word as written. */
  word: string;
  /** The option it is, such as --runner for -rpyocd. */
  taken: string;
  /** For an option that selects the probe: the id given with it. */
  value?: string;
}

/**
 * The options in runner arguments that the flash action has an argument of
 * its own for. Every word is checked, the one after -O or --tool-opt too:
 * west's own parser does not know -O, so it reads a -rpyocd there as
 * --runner pyocd.
 */
export function reservedRunnerOptions(value: string, runner: string): ReservedOption[] {
  const words = splitWords(value);
  const probeOptions = probeOptionsOf(runner);
  const found: ReservedOption[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const equals = word.indexOf('=');
    const name = equals < 0 ? word : word.slice(0, equals);
    let taken: string | undefined;
    let given: string | undefined;
    if (name.startsWith('--') && name.length > 2) {
      taken = WEST_OPTIONS.find(option => option.startsWith(name))
        ?? ['--erase', ...probeOptions].find(option => option === name);
      given = equals < 0 ? words[i + 1] : word.slice(equals + 1);
    } else if (!name.startsWith('--')) {
      const short = SHORT_OPTION.exec(name)?.[1];
      taken = short === undefined ? undefined : SHORT_NAME[short];
      given = word.length > 2 ? word.slice(2) : words[i + 1];
    }
    if (!taken && runner === 'openocd' && ADAPTER_SERIAL.test(word)) {
      taken = 'adapter serial';
    }
    if (taken) {
      found.push({ word, taken, ...(given !== undefined && probeOptions.includes(taken) ? { value: given } : {}) });
    }
  }
  return found;
}

/** The argument of the call that stands for a reserved option, if any. */
export function argumentOf(taken: string): string | undefined {
  return ARGUMENT_OF[taken];
}

/**
 * Check the runner arguments an agent passes to west flash: no shell operator,
 * and no option the call has an argument of its own for. Such an option would
 * flash with a runner, a probe or an erase the confirmation never named, and
 * outside the lock that keeps one flash per probe.
 */
export function checkRunnerArgs(value: unknown, runner: string): string {
  if (typeof value !== 'string') {
    throw new McpToolError('INVALID_ARGUMENT', 'runner_args must be a string.');
  }
  assertSafeShellFragment(value, 'runner_args');
  const [first] = reservedRunnerOptions(value, runner);
  if (first) {
    throw new McpToolError('INVALID_ARGUMENT', `runner_args may not contain ${logSafe(first.word, 60)} (${first.taken}).`, {
      hint: ARGUMENT_OF[first.taken]
        ? `Pass ${ARGUMENT_OF[first.taken]} instead, and keep runner_args for options of the runner itself.`
        : 'Leave it out: it rebuilds and can prompt for input, which nobody can answer here.',
    });
  }
  return value;
}

/** The failures a flash commonly ends with, and the call that gets past each. */
export function flashFailureHint(output: string, options: { runner: string; erase: boolean; devId?: string }): string | undefined {
  const { runner } = options;
  const missing = /required program (\S+) not found/i.exec(output)
    ?? /FileNotFoundError[^\n]*?['"]([^'"\n]+)['"]/.exec(output)
    ?? /(?:^|\s)([\w.-]+): (?:command )?not found/im.exec(output)
    ?? /'([^'\n]+)' is not recognized as an internal or external command/i.exec(output);
  if (missing || /FileNotFoundError|is not recognized as an internal or external command/i.test(output)) {
    const program = missing?.[1];
    return `The tool the ${runner} runner needs${program ? ` (${program})` : ''} is not installed or not on PATH (RUNNER_TOOL_MISSING). `
      + 'Install it with manage_runners, check it with list_runners and include ["tools"], then flash again.';
  }
  const unsupported = /doesn't support (--[\w-]+) option/i.exec(output);
  if (unsupported) {
    const flag = unsupported[1];
    const arg = flag === '--erase' ? 'erase' : flag === '--dev-id' ? 'dev_id' : undefined;
    return `The ${runner} runner does not support ${flag}. Flash again without ${arg ?? `${flag} in runner_args`}`
      + `${arg === 'dev_id' ? ', with only the board to flash connected' : ''}.`;
  }
  if (/refusing to guess|more than one (?:debug )?probe|multiple (?:debug )?probes|more than a single probe|multiple boards (?:are )?connected|several (?:debug )?probes/i.test(output)) {
    return options.devId
      ? `Several probes are connected and the ${runner} runner did not take dev_id "${options.devId}". Check the serial numbers with hardware action "list_ports", or disconnect the other boards.`
      : 'Several probes are connected, so the runner cannot pick one. Pass dev_id, the serial number of the probe of this board: '
        + 'hardware action "list_ports" lists each port with its serial_number, which is usually the probe\'s.';
  }
  if (/\bno (?:connected |available )?(?:debug )?probes?\b|\bno (?:J-Link|emulators?|devices?|boards?) (?:found|connected)|unable to find a matching|could not find (?:a |any )?(?:debug )?probe/i.test(output)) {
    return 'No probe was found. Ask the user to check that the board is connected through its debug probe and powered, then flash again; '
      + 'hardware action "list_ports" shows whether its USB ports are there.';
  }
  return undefined;
}
