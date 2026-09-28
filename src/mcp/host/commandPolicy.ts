// run_command: the commands it refuses before asking the user.
//
// Best effort by design. A shell can spell a command in ways no word match
// sees (an alias, a variable, a script of its own), so the confirmation
// dialog, which shows the exact command, is the real control. These refusals
// send an agent that means well to the tool that does the job with its locks
// and its own confirmation, and keep it from starting a program that waits
// for a keyboard nobody can type on.

import * as path from 'path';
import { McpToolError } from '../core/errors';
import { RUN_COMMAND_MAX_CHARS } from '../core/tools/runCommand';

const INTERACTIVE_TARGETS = new Set(['menuconfig', 'guiconfig']);

/** Words that only start another command: `call west flash` is `west flash`. */
const PREFIXES = new Set(['call', 'exec', 'command', 'builtin', 'env', 'time', 'nohup', 'sudo']);

/** Shells whose command-line argument is itself a command line: `bash -c "west flash"`. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'cmd', 'powershell', 'pwsh']);
/** -c of the POSIX shells (also as -lc), /c and /k of cmd, and -Command of PowerShell with its abbreviations. */
const SHELL_COMMAND_FLAG = /^(?:-[a-z]*c|-co(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?|\/c|\/k)$/i;

/**
 * The simple commands of a command line, each as its words with the quotes
 * removed. Command separators, pipes, subshells and script blocks of bash,
 * PowerShell and cmd all start a new command; quotes keep them literal.
 */
export function commandWords(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | undefined;
  // Inside ${NAME}, whose braces are part of the word, not a script block.
  let variable = false;
  const endWord = () => {
    if (inWord) {
      words.push(word);
    }
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) {
      commands.push(words);
    }
    words = [];
  };
  for (const ch of line) {
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else {
        word += ch;
      }
    } else if (variable || (ch === '{' && word.endsWith('$'))) {
      word += ch;
      variable = ch !== '}';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/[;&|()`{}\r\n]/.test(ch)) {
      endCommand();
    } else if (/\s/.test(ch)) {
      endWord();
    } else {
      word += ch;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/** A program name as typed, reduced to what it runs: `C:\x\west.exe` is `west`. */
function programOf(word: string): string {
  return path.basename(word.replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat|com|py|ps1)$/, '');
}

const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

/** The words of a command from its program on, past env assignments and prefixes such as `call`. */
function fromProgram(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (isAssignment(word)) {
      i++;
    } else if (PREFIXES.has(word.toLowerCase())) {
      i++;
      // env and sudo take options of their own before the program.
      while (i < words.length && words[i].startsWith('-')) {
        i++;
      }
    } else {
      break;
    }
  }
  return words.slice(i);
}

/** The west subcommand and its arguments, past west's own options. */
function westSubcommand(args: string[]): { name: string; rest: string[] } | undefined {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const option = args[i].toLowerCase();
    i += option === '-z' || option === '--zephyr-base' ? 2 : 1;
  }
  return i < args.length ? { name: args[i].toLowerCase(), rest: args.slice(i + 1) } : undefined;
}

/** The build targets named in `west build -t X`, `--target X` or `--target=X`, and in cmake's own forms. */
function targetsOf(args: string[]): string[] {
  const targets: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i].toLowerCase();
    if ((arg === '-t' || arg === '--target') && i + 1 < args.length) {
      targets.push(args[i + 1].toLowerCase());
    } else if (arg.startsWith('--target=')) {
      targets.push(arg.slice('--target='.length));
    } else if (arg.startsWith('-t') && arg.length > 2 && !arg.startsWith('--')) {
      targets.push(arg.slice(2));
    }
  }
  return targets;
}

function interactive(what: string): McpToolError {
  return new McpToolError('INTERACTIVE_UNSUPPORTED', `${what} waits for keyboard input, which a command run by an agent never gets.`, {
    hint: 'Call open_in_workbench with target "menuconfig" to open it for the user, or read and change Kconfig values with query_kconfig and set_kconfig, then rebuild.',
  });
}

/**
 * Refuse a runner command, which Zephyr also defines as a build target of
 * the same name: `west build -t flash` and `ninja flash` flash as west flash
 * does. `spelled` is the command as the error names it.
 */
function refuseRunner(name: string, spelled: string): void {
  switch (name) {
    case 'menuconfig':
    case 'guiconfig':
      throw interactive(spelled);
    case 'debug':
    case 'attach':
    case 'rtt':
      throw new McpToolError('INTERACTIVE_UNSUPPORTED', `${spelled} opens an interactive debugger or terminal, which a command run by an agent cannot drive.`, {
        hint: 'Call debug_app with action "start" to debug in the VS Code debugger, which you can then drive with its other actions.',
      });
    case 'debugserver':
      throw new McpToolError('INVALID_ARGUMENT', `${spelled} is not run through run_command: it holds the probe until it is stopped.`, {
        hint: 'Call debug_app with action "start", which starts the debug server and the debugger together.',
      });
    case 'flash':
      throw new McpToolError('INVALID_ARGUMENT', `${spelled} is not run through run_command: flashing has a tool of its own that locks the board and asks the user.`, {
        hint: 'Call hardware with action "flash".',
      });
    default:
      return;
  }
}

/** Only prints help: -H is the runner help of flash, debug and the other runner commands. */
const HELP_FLAGS = new Set(['-h', '--help', '-H', '--context']);

function checkWest(args: string[]): void {
  const sub = westSubcommand(args);
  if (!sub) {
    return;
  }
  if (sub.name !== 'build' && sub.rest.some(arg => HELP_FLAGS.has(arg))) {
    return;
  }
  switch (sub.name) {
    case 'build':
      for (const target of targetsOf(sub.rest)) {
        refuseRunner(target, `west build -t ${target}`);
      }
      return;
    case 'debug':
    case 'attach':
    case 'rtt':
    case 'debugserver':
    case 'flash':
      refuseRunner(sub.name, `west ${sub.name}`);
      return;
    case 'update':
      throw new McpToolError('INVALID_ARGUMENT', 'west update is not run through run_command: it rewrites the west workspace while builds may read it.', {
        hint: 'Call manage_west_workspace with action "update".',
      });
    case 'blobs': {
      const verb = sub.rest.find(word => !word.startsWith('-'))?.toLowerCase();
      if (verb === 'fetch') {
        throw new McpToolError('INVALID_ARGUMENT', 'west blobs fetch is not run through run_command: it downloads binary blobs whose licenses the user must accept.', {
          hint: 'Call manage_west_workspace with action "fetch_blobs".',
        });
      }
      return;
    }
    default:
      return;
  }
}

const PYTHONS = new Set(['python', 'python3', 'py']);
/** A Python interpreter, versioned ones such as python3.12 included. */
const isPython = (program: string) => PYTHONS.has(program) || /^python3?(?:\.\d+)?$/.test(program);
/** Python options that take the next word as their value. */
const PYTHON_VALUE_OPTIONS = new Set(['-X', '-W']);

/** The arguments after `-m <module>` of a Python command line, past the interpreter's own options, or undefined. */
function moduleArgs(args: string[], module: string): string[] | undefined {
  let i = 0;
  while (i < args.length && args[i].startsWith('-') && args[i] !== '-') {
    const arg = args[i];
    if (arg === '-m') {
      return args[i + 1]?.toLowerCase() === module ? args.slice(i + 2) : undefined;
    }
    if (arg.startsWith('-m')) {
      return arg.slice(2).toLowerCase() === module ? args.slice(i + 1) : undefined;
    }
    if (arg === '-c') {
      // The rest is a program text, not a module.
      return undefined;
    }
    // Flags such as -u, and the version py picks, such as -3.12.
    i += PYTHON_VALUE_OPTIONS.has(arg) ? 2 : 1;
  }
  return undefined;
}

/** ninja and make options that take the next word as their value, so a folder named flash is not a target. */
const BUILD_TOOL_VALUE_OPTIONS = new Set(['-C', '-f', '-d', '-t', '-w', '-I', '-o', '-W']);
/** Their options whose value is a number, which make also accepts alone. */
const BUILD_TOOL_COUNT_OPTIONS = new Set(['-j', '-k', '-l']);

/** The targets a ninja or make command line names. */
function buildToolTargets(args: string[]): string[] {
  const targets: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (BUILD_TOOL_VALUE_OPTIONS.has(arg)) {
      i++;
    } else if (BUILD_TOOL_COUNT_OPTIONS.has(arg)) {
      if (/^\d+$/.test(args[i + 1] ?? '')) {
        i++;
      }
    } else if (!arg.startsWith('-') && !isAssignment(arg)) {
      targets.push(arg.toLowerCase());
    }
  }
  return targets;
}

/** What a simple command runs, when it is west or a build tool: the program and its arguments. */
function toolOf(words: string[]): { program: string; args: string[] } | undefined {
  const [first, ...args] = fromProgram(words);
  if (first === undefined) {
    return undefined;
  }
  const program = programOf(first);
  if (isPython(program)) {
    const west = moduleArgs(args, 'west');
    return west ? { program: 'west', args: west } : { program, args };
  }
  return { program, args };
}

/** The command lines a shell command line hands another shell, such as the argument of `bash -c`. */
function innerCommands(program: string, args: string[]): string[][] | undefined {
  if (!SHELLS.has(program)) {
    return undefined;
  }
  const flag = args.findIndex(arg => SHELL_COMMAND_FLAG.test(arg));
  // cmd /c and powershell -Command take the rest of the line; bash -c one word.
  return flag === -1 ? [] : commandWords(args.slice(flag + 1).join(' '));
}

/** Refuse one simple command, or pass it. Shell command-line arguments are checked as command lines of their own. */
function checkSimple(words: string[], depth: number): void {
  const tool = toolOf(words);
  if (!tool) {
    return;
  }
  const { program, args } = tool;
  const inner = innerCommands(program, args);
  if (inner) {
    if (depth < 3) {
      for (const command of inner) {
        checkSimple(command, depth + 1);
      }
    }
    return;
  }
  if (INTERACTIVE_TARGETS.has(program)) {
    throw interactive(program);
  }
  if (program === 'west') {
    checkWest(args);
    return;
  }
  if (program === 'ninja' || program === 'make') {
    for (const target of buildToolTargets(args)) {
      refuseRunner(target, `${program} ${target}`);
    }
  } else if (program === 'cmake') {
    // cmake takes targets only with -t or --target: `cmake -B flash` names a folder.
    for (const target of targetsOf(args)) {
      refuseRunner(target, `cmake --build -t ${target}`);
    }
  }
}

function buildsIn(words: string[], depth: number): boolean {
  const tool = toolOf(words);
  if (!tool) {
    return false;
  }
  const { program, args } = tool;
  const inner = innerCommands(program, args);
  if (inner) {
    return depth < 3 && inner.some(command => buildsIn(command, depth + 1));
  }
  if (program === 'west') {
    return westSubcommand(args)?.name === 'build';
  }
  if (program === 'cmake') {
    return args.some(arg => arg === '--build');
  }
  return program === 'ninja' || program === 'make';
}

/**
 * True when a command line builds, with west build, ninja, make or
 * cmake --build: it writes a build folder, so it may not run beside a build
 * of the same configuration.
 */
export function buildsInFolder(line: string): boolean {
  return commandWords(line).some(words => buildsIn(words, 0));
}

/** pip, pip3 and pip3.12 as typed. */
const PIP = /^pip(?:3(?:\.\d+)?)?$/;
/** The pip commands that change the packages of the environment. */
const PIP_WRITES = new Set(['install', 'uninstall', 'sync']);

function installsIn(words: string[], depth: number): boolean {
  const tool = toolOf(words);
  if (!tool) {
    return false;
  }
  const { program, args } = tool;
  const inner = innerCommands(program, args);
  if (inner) {
    return depth < 3 && inner.some(command => installsIn(command, depth + 1));
  }
  if (program === 'west') {
    // Zephyr's west packages pip --install runs pip install in the Python west runs in.
    const sub = westSubcommand(args);
    return sub?.name === 'packages' && sub.rest.some(arg => arg.toLowerCase() === 'pip') && sub.rest.includes('--install');
  }
  const pipArgs = PIP.test(program) ? args
    : isPython(program) ? moduleArgs(args, 'pip')
      // uv pip install and uv pip sync write the active environment as pip does.
      : program === 'uv' && args.some(arg => arg.toLowerCase() === 'pip') ? args.slice(args.findIndex(arg => arg.toLowerCase() === 'pip') + 1)
        : undefined;
  // Any install or uninstall word counts, even an option's value: claiming too much only waits longer.
  return !!pipArgs?.some(arg => PIP_WRITES.has(arg.toLowerCase()));
}

/**
 * True when a command line installs or removes Python packages with pip or
 * python -m pip: it writes the Python environment, so it may not run beside
 * a build or an install that uses the same one.
 */
export function installsInVenv(line: string): boolean {
  return commandWords(line).some(words => installsIn(words, 0));
}

/**
 * The command to run, trimmed, or an error naming the tool to use instead.
 * `shellKind` is the shell it will run in, as classifyShell names it.
 */
export function checkCommand(command: unknown, shellKind: string): string {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new McpToolError('INVALID_ARGUMENT', 'action "run" needs command, the command line to run.', {
      hint: 'Pass command, such as "west boards".',
    });
  }
  const trimmed = command.trim();
  if (trimmed.length > RUN_COMMAND_MAX_CHARS) {
    throw new McpToolError('INVALID_ARGUMENT', `command is ${trimmed.length} characters long, more than the ${RUN_COMMAND_MAX_CHARS} allowed.`, {
      hint: 'Put a long command in a script file inside the application and run the script.',
    });
  }
  if (trimmed.includes('\u0000')) {
    throw new McpToolError('INVALID_ARGUMENT', 'command contains a NUL character.');
  }
  if (shellKind === 'cmd.exe' && /[\r\n]/.test(trimmed)) {
    // cmd /c runs the first line and silently drops the rest.
    throw new McpToolError('INVALID_ARGUMENT', 'The terminal shell is cmd, which runs only the first line of a command.', {
      hint: 'Join the commands on one line with &&, or call run_command once for each.',
    });
  }
  for (const words of commandWords(trimmed)) {
    checkSimple(words, 0);
  }
  return trimmed;
}
