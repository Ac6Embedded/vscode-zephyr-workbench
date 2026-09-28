// Which gdb commands an agent may run in a debug session. gdb runs on the
// host, and several of its commands reach the host rather than the board
// (shell, pipe, python, source, dump, set logging), so the policy is an
// allowlist of commands that read the target or talk to the gdb server, and
// everything else is refused. The gdb servers have host commands of their
// own (pyOCD's "!" and "$", OpenOCD's dump_image and script), so monitor
// takes an allowlist too. The expressions other actions send to gdb (inspect,
// memory addresses, breakpoint conditions) go through checkGdbExpression,
// since gdb's $_shell runs a host command from inside any expression. Pure,
// so it is unit tested on its own.

/** The commands allowed, by their first word, with the aliases gdb gives them. */
const ALLOWED: Readonly<Record<string, string>> = {
  info: 'info', i: 'info',
  print: 'print', p: 'print', inspect: 'print',
  output: 'output',
  x: 'x',
  backtrace: 'backtrace', bt: 'backtrace', where: 'backtrace',
  frame: 'frame', f: 'frame',
  up: 'up',
  down: 'down',
  list: 'list', l: 'list',
  ptype: 'ptype',
  whatis: 'whatis',
  disassemble: 'disassemble', disas: 'disassemble',
  monitor: 'monitor', mon: 'monitor',
  // Only as "set var" or "set variable", checked below.
  set: 'set',
};

/** How the allowed commands are named in a refusal. */
export const ALLOWED_GDB_COMMANDS = [
  'info', 'print (p, p/x)', 'output', 'x/<n><f><u>', 'backtrace (bt)', 'frame (f)', 'up', 'down', 'list',
  'ptype', 'whatis', 'disassemble', 'set var',
  'monitor (mon) with reset, halt, resume, go, reg, mdw/mdh/mdb/mdd, mww/mwh/mwb/mwd, read8 to read64, write8 to write64, memU8 to memU32, targets, flash info, status, where, show, help or version',
] as const;

/** Refused by name, so the refusal can say why rather than only "not allowed". */
const HOST_COMMANDS = new Set([
  'shell', '!', 'pipe', '|', 'python', 'py', 'pi', 'python-interactive', 'source', 'dump', 'append', 'restore',
  'define', 'document', 'file', 'exec-file', 'symbol-file', 'add-symbol-file', 'load', 'core', 'core-file',
  'cd', 'make', 'run', 'r', 'start', 'starti', 'kill', 'attach', 'detach', 'target', 'quit', 'q', 'eval', 'guile', 'gu',
]);

/**
 * The monitor commands allowed, by their first word, for the gdb servers of
 * the runners (OpenOCD, pyOCD, J-Link): reset, run control, and the memory
 * and registers of the target. Exact words only, since pyOCD also takes any
 * unambiguous prefix of its commands.
 */
const ALLOWED_MONITOR = new Set([
  'reset', 'halt', 'resume', 'go', 'reg',
  // OpenOCD
  'mdw', 'mdh', 'mdb', 'mdd', 'mww', 'mwh', 'mwb', 'mwd', 'targets', 'flash', 'version',
  // pyOCD
  'read8', 'read16', 'read32', 'read64', 'write8', 'write16', 'write32', 'write64', 'status', 'where', 'show', 'help',
  // J-Link, compared in lower case
  'memu8', 'memu16', 'memu32',
]);

/** The flash subcommands that only read: the others write the board from host files, or host files from the board. */
const MONITOR_FLASH_READ_ONLY = new Set(['info', 'banks', 'list', 'probe']);

/** Monitor commands refused by name, so the refusal can say why. */
const HOST_MONITOR_COMMANDS = new Set([
  'dump_image', 'load_image', 'fast_load_image', 'verify_image', 'script', 'source', 'log_output', 'savemem', 'loadmem',
  'load', 'shutdown', 'exit', 'quit', 'exec', 'tcl_port', 'telnet_port', 'gdb_port', 'bindto', 'capture', 'debug_level',
  'add_script_search_dir', 'gdbserver', 'probeserver', 'semihosting', 'arm',
]);

export type GdbPolicyResult =
  | { ok: true; command: string; kind: string }
  | { ok: false; reason: string };

export type GdbExpressionResult =
  | { ok: true; expression: string }
  | { ok: false; reason: string };

const refuse = (reason: string): GdbPolicyResult => ({ ok: false, reason });

/** What any text handed to gdb must not hold, else undefined. */
function screenText(text: string): string | undefined {
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) {
    return 'The text holds a control character.';
  }
  if (text.includes('\\')) {
    return 'The text holds a backslash, which could end the quoted text early.';
  }
  if (/\$_shell\b/.test(text)) {
    return '$_shell runs a command on the host.';
  }
  return undefined;
}

/**
 * Check one expression gdb evaluates: an inspect expression, a memory
 * address, a breakpoint condition. The adapters pass it to gdb in a quoted
 * MI string (cortex-debug's var-create escapes only '"'), so a newline or a
 * backslash is refused, as are $_shell, which runs a host command from any
 * expression, and a leading "-" or "`", which cppdbg can take as a gdb
 * command rather than an expression.
 */
export function checkGdbExpression(text: string): GdbExpressionResult {
  const expression = text.trim();
  if (expression.length === 0) {
    return { ok: false, reason: 'The expression is empty.' };
  }
  if (/[\r\n]/.test(expression)) {
    return { ok: false, reason: 'The expression holds more than one line.' };
  }
  const screened = screenText(expression);
  if (screened) {
    return { ok: false, reason: screened };
  }
  if (/^-[A-Za-z_]/.test(expression) || expression.startsWith('`')) {
    return { ok: false, reason: 'An expression starting with "-" and a name, or with "`", can be taken as a gdb command: pass a C expression, in parentheses if it starts with a minus.' };
  }
  return { ok: true, expression };
}

/** Why the text after "monitor" is refused, else undefined. The gdb server runs it as it is. */
function monitorRefusal(text: string): string | undefined {
  if (text.length === 0) {
    return 'monitor needs a command for the gdb server, such as monitor reset halt.';
  }
  if (text.startsWith('!') || text.startsWith('$')) {
    return `monitor "${text[0]}" runs a shell or Python command on the host through pyOCD.`;
  }
  if (text.includes('[')) {
    return 'monitor text with "[" is refused: OpenOCD runs the command inside the brackets, which this check cannot see.';
  }
  const words = text.toLowerCase().split(/\s+/);
  const word = words[0];
  if (HOST_MONITOR_COMMANDS.has(word)) {
    return `monitor ${word} is not allowed: monitor commands that touch host files, run host commands or change the gdb server are refused.`;
  }
  if (!ALLOWED_MONITOR.has(word)) {
    return `monitor ${word.slice(0, 40)} is not one of the allowed monitor commands.`;
  }
  if (word === 'flash' && !MONITOR_FLASH_READ_ONLY.has(words[1] ?? '')) {
    return 'monitor flash is allowed only as flash info, banks, list or probe: the others read or write host files.';
  }
  return undefined;
}

/**
 * Check one gdb command. The text is trimmed; a newline, a carriage return,
 * a command separator, a backslash or a control character is refused, since
 * each could smuggle a second command past the check (cortex-debug wraps the
 * text in a quoted MI string, where a backslash can end the quote early).
 */
export function checkGdbCommand(text: string): GdbPolicyResult {
  const command = text.trim();
  if (command.length === 0) {
    return refuse('The command is empty.');
  }
  if (/[\r\n]/.test(command)) {
    return refuse('The text holds more than one line: pass exactly one gdb command.');
  }
  if (command.includes(';')) {
    return refuse('The text holds ";", which could separate a second command.');
  }
  const screened = screenText(command);
  if (screened) {
    return refuse(screened);
  }
  if (command.startsWith('-')) {
    return refuse('Machine interface (MI) commands are not accepted: pass a gdb console command.');
  }
  const first = /^([!|]|[A-Za-z][A-Za-z0-9_-]*)/.exec(command)?.[1] ?? '';
  const rest = command.slice(first.length);
  const word = first.toLowerCase();
  // "!ls" and "|cmd" need no space after the command.
  if (word === '!' || word === '|') {
    return refuse(`"${first}" is not allowed: it runs a command on the host.`);
  }
  // The word ends at a space, at "/" (p/x, x/8xw) or at the end.
  if (!first || (rest.length > 0 && !/^[\s/]/.test(rest))) {
    return refuse(`"${command.slice(0, 40)}" does not start with a gdb command name.`);
  }
  if (HOST_COMMANDS.has(word)) {
    return refuse(`"${first}" is not allowed: it acts on the host or on the gdb process rather than on the board.`);
  }
  const kind = ALLOWED[word];
  if (!kind) {
    return refuse(`"${first}" is not one of the allowed gdb commands.`);
  }
  if (kind === 'set') {
    const target = /^set\s+(var|variable)\s+\S/i.exec(command);
    if (!target) {
      return refuse('set is allowed only as "set var <variable> = <value>": other set commands change gdb itself, such as set logging.');
    }
    return { ok: true, command, kind: 'set var' };
  }
  if (kind === 'frame' && /^\s+apply\b/i.test(rest)) {
    // frame apply runs any command once per frame, which would bypass this check.
    return refuse('frame apply is not allowed: it runs another command, which this check cannot see.');
  }
  if (kind === 'monitor') {
    const reason = monitorRefusal(rest.trim());
    if (reason) {
      return refuse(reason);
    }
  }
  return { ok: true, command, kind };
}

/** Words a "(" may follow without a call: sizeof and the type words of a cast. */
const NOT_CALLED = new Set([
  'sizeof', '_Alignof', 'alignof', 'char', 'short', 'int', 'long', 'unsigned', 'signed', 'float', 'double', 'void',
  '_Bool', 'bool', 'const', 'volatile', 'struct', 'union', 'enum',
]);

/** Whether the text between parentheses reads as a cast type, such as uint32_t or struct k_thread *. */
function isCastType(group: string): boolean {
  if (!/^\s*[A-Za-z_$][\w$]*(\s+[A-Za-z_$][\w$]*)*(\s*\*)*\s*$/.test(group)) {
    return false;
  }
  const words = group.match(/[A-Za-z_$][\w$]*/g) ?? [];
  return group.includes('*') || words.some(word => NOT_CALLED.has(word)) || words[words.length - 1].endsWith('_t');
}

/**
 * Why gdb evaluating this C expression would change the target, or
 * undefined when it only reads. An adapter's watch evaluate and a memory
 * address go through gdb in full: an assignment and ++ or -- write target
 * memory, and a call runs a function of the program on the board. Lexical
 * and cautious: a cast of a parenthesized expression to a type named
 * without _t, such as (my_type)(a + b), reads as a call.
 */
export function sideEffectReason(expression: string): string | undefined {
  // String and char literals hold text, not operators.
  const code = expression.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  if (/<<=|>>=|[+\-*/%&|^]=|(?:^|[^=!<>])=(?!=)/.test(code)) {
    return 'an assignment writes target memory';
  }
  if (/\+\+|--/.test(code)) {
    return '++ and -- write target memory';
  }
  for (const match of code.matchAll(/([A-Za-z_$][\w$]*|[)\]])\s*\(/g)) {
    const before = match[1];
    if (before === ')') {
      // A cast such as (uint8_t)(a + b) also puts "(" after ")".
      let depth = 0;
      let open = match.index;
      for (; open >= 0; open--) {
        depth += code[open] === ')' ? 1 : code[open] === '(' ? -1 : 0;
        if (depth === 0) {
          break;
        }
      }
      if (open >= 0 && isCastType(code.slice(open + 1, match.index))) {
        continue;
      }
    } else if (NOT_CALLED.has(before)) {
      continue;
    }
    return 'a function call runs code on the target';
  }
  return undefined;
}
