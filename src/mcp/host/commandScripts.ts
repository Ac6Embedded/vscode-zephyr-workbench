// run_command: the command line a run starts and the script env writes, for
// each shell. Only text is built here, so every shell's form is unit tested
// on any machine.

import {
  concatCommands, getShellSetEnvCommand, normalizePathForShell, TerminalEnvGroup,
} from '../../utils/execUtils';
import { isPosixShellKind, quoteLiteralForShell } from '../../utils/shellQuoting';
import { logSafe } from '../core/redact';
import { RunCommandShell } from '../core/tools/runCommand';

const isPowerShell = (kind: string) => kind === 'powershell.exe' || kind === 'pwsh.exe';

/** The shell an agent is told about: PowerShell and pwsh read the same scripts, and dash and fish get the bash forms. */
export function shellOfKind(kind: string): RunCommandShell {
  if (isPowerShell(kind)) {
    return 'powershell';
  }
  if (kind === 'cmd.exe') {
    return 'cmd';
  }
  return kind === 'zsh' ? 'zsh' : 'bash';
}

/** The shell kind, as classifyShell names it, of a shell an agent asked for. */
export function kindOfShell(shell: RunCommandShell): 'bash' | 'zsh' | 'powershell.exe' | 'cmd.exe' {
  return shell === 'powershell' ? 'powershell.exe' : shell === 'cmd' ? 'cmd.exe' : shell;
}

/**
 * The environment script a shell kind sources: the configured one in that
 * shell's flavour, since the installers write env.sh, env.ps1 and env.bat
 * side by side. POSIX shells get the .sh one in C:/ form, as the Zephyr
 * terminal does; cmd gets the .bat one, as the Debug Manager's west wrapper
 * does, where the terminal would call a .ps1 it cannot run.
 */
export function envScriptFor(kind: string, configured: string): string {
  if (kind === 'cmd.exe') {
    return configured.replace(/\.(ps1|sh)$/i, '.bat');
  }
  return normalizePathForShell(kind, configured);
}

/**
 * Carries a native program's exit code out of PowerShell: -Command reports 1
 * for any failure, and 0 when a cmdlet ran last, whatever the program
 * returned. A failed cmdlet still ends with 1.
 */
const POWERSHELL_EXIT = '$zwOk = $? ; if ($LASTEXITCODE) { exit $LASTEXITCODE } ; if (-not $zwOk) { exit 1 }';

/**
 * Windows PowerShell writes its own messages in the OEM code page, which the
 * job log reads as UTF-8. It can fail with no console, which must not stop
 * the command.
 */
const POWERSHELL_UTF8 = 'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}';

/** The variable a cmd run reads the agent's command from, set in the task's environment. */
export const CMD_COMMAND_VARIABLE = 'ZW_RUN_COMMAND';

/**
 * The command line a run starts: the environment script sourced, then the
 * agent's command. bash, zsh and cmd /c end with the status of the last
 * command they ran, which is the agent's once the script succeeded (checked
 * on cmd with programs, batch files and builtins). PowerShell needs the exit
 * code carried out by hand, after clearing the one the script may have left;
 * the trailer starts a line of its own, so a comment ending the command
 * cannot swallow it.
 *
 * cmd expands %NAME% in the whole line before `call` runs the script, so the
 * command is not on the line: an inner cmd reads it from CMD_COMMAND_VARIABLE
 * once the script has run. The middle cmd expands !NAME! only after it split
 * its own line, so & | " in the command stay the inner cmd's to parse, and
 * the inner cmd, with delayed expansion off, parses it as the terminal would.
 */
export function composeRunCommandLine(kind: string, envScript: string, command: string): string {
  if (kind === 'cmd.exe') {
    // `call` first, so cmd /c never strips the quotes of the line.
    return `call "${envScript}" && cmd /d /v:on /s /c "cmd /d /v:off /s /c "!${CMD_COMMAND_VARIABLE}!""`;
  }
  const source = sourceLine(kind, envScript);
  if (isPowerShell(kind)) {
    return `${POWERSHELL_UTF8} ; ${source} ; $global:LASTEXITCODE = 0 ; ${command}\n${POWERSHELL_EXIT}`;
  }
  return concatCommands(kind, source, command);
}

/** The variables a run adds to the task's environment for composeRunCommandLine. */
export function runCommandEnv(kind: string, command: string): Record<string, string> {
  return kind === 'cmd.exe' ? { [CMD_COMMAND_VARIABLE]: command } : {};
}

/** A PowerShell literal string, which also reads the typographic single quotes as quotes. */
function powerShellLiteral(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;
}

/**
 * `set` in a batch file. A batch file expands %...% even inside quotes, so %
 * is doubled. `set "NAME=value"` keeps & | < > ^ ( ) literal only while no
 * quote in the value ends the quoted part early, so a value with a quote is
 * written unquoted, each special character escaped with ^. A batch line ends
 * at a line break, so one in a value becomes a space.
 */
export function batchSetLine(name: string, value: string): string {
  const flat = value.replace(/[\r\n]+/g, ' ').replace(/%/g, '%%');
  return value.includes('"')
    ? `set ${name}=${flat.replace(/[\^&|<>()"]/g, '^$&')}`
    : `set "${name}=${flat}"`;
}

/** C:\x\y as MSYS and Git Bash spell it in PATH, /c/x/y, where the colon of C: would split it. */
function msysPath(entry: string): string {
  const posix = entry.replace(/\\/g, '/');
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(posix);
  return drive ? `/${drive[1].toLowerCase()}${drive[2] ?? ''}` : posix;
}

/**
 * PATH as a script sets it. The terminal gets the whole PATH of VS Code with
 * the toolchain folders in front; a script run from another shell keeps that
 * shell's PATH and only puts the same folders in front of it.
 */
function pathLine(kind: string, value: string, basePath: string | undefined, platform: NodeJS.Platform): string {
  const delimiter = platform === 'win32' ? ';' : ':';
  const suffix = basePath ? `${delimiter}${basePath}` : undefined;
  if (!suffix || !value.endsWith(suffix)) {
    return setLine(kind, 'PATH', value);
  }
  const entries = value.slice(0, -suffix.length).split(delimiter).filter(Boolean);
  if (isPosixShellKind(kind)) {
    const joined = entries.map(entry => (platform === 'win32' ? msysPath(entry) : entry)).join(':');
    return `export PATH="${joined.replace(/(["\\$`])/g, '\\$1')}:$PATH"`;
  }
  if (isPowerShell(kind)) {
    return `$env:PATH = ${powerShellLiteral(entries.join(delimiter))} + [IO.Path]::PathSeparator + $env:PATH`;
  }
  const line = batchSetLine('PATH', entries.join(delimiter));
  return line.startsWith('set "') ? `${line.slice(0, -1)};%PATH%"` : `${line};%PATH%`;
}

function setLine(kind: string, name: string, value: string): string {
  if (kind === 'cmd.exe') {
    return batchSetLine(name, value);
  }
  return isPowerShell(kind) ? `$env:${name} = ${powerShellLiteral(value)}` : getShellSetEnvCommand(kind, name, value);
}

/**
 * The line of a script that sources the environment script. The path is
 * quoted as a literal, even one with $, spaces or characters beyond ASCII,
 * which quoteLiteralForShell leaves to its caller.
 */
function sourceLine(kind: string, script: string): string {
  const literal = quoteLiteralForShell(kind, script);
  if (kind === 'cmd.exe') {
    return `call ${literal ?? `"${script.replace(/%/g, '%%')}"`}`;
  }
  if (isPowerShell(kind)) {
    return `. ${powerShellLiteral(script)}`;
  }
  return `. ${literal ?? `"${script.replace(/(["\\$`])/g, '\\$1')}"`}`;
}

export interface EnvScriptInput {
  /** What the environment belongs to, for the header, such as `blinky (primary)`. */
  subject: string;
  /** The variables, as the Zephyr terminal groups them, already in the shell's path form. */
  groups: TerminalEnvGroup[];
  /** The environment script to source, in the shell's form. */
  envScript: string;
  /** How to run the script, for the header. */
  usage: string;
  /** The PATH the extension host runs with, to tell folders put in front of it from a PATH of its own. */
  basePath?: string;
  platform?: NodeJS.Platform;
}

/** A comment line of the script: one line, and nothing a batch file would still expand or run. */
function comment(kind: string, text: string, indent = ''): string {
  if (kind === 'cmd.exe') {
    return `rem ${indent}${logSafe(text, 400).replace(/[%&|<>^]/g, '_')}`.trimEnd();
  }
  return `# ${indent}${logSafe(text, 400)}`.trimEnd();
}

/**
 * A script that sets up the environment of the Zephyr terminal and then runs
 * its arguments as a command, ending with that command's exit code. With no
 * arguments it only sets up the environment, so sourcing it (bash, zsh),
 * dot-sourcing it (PowerShell) or calling it (cmd) prepares the caller's own
 * session. Each value is quoted for the shell: the Debug Manager's west
 * wrapper, which this generalizes, leaves them bare.
 */
export function renderEnvScript(kind: string, input: EnvScriptInput): string {
  const platform = input.platform ?? process.platform;
  const lines: string[] = [];
  if (kind === 'cmd.exe') {
    lines.push('@echo off');
  } else if (isPosixShellKind(kind)) {
    lines.push(`#!/usr/bin/env ${kind === 'zsh' ? 'zsh' : 'bash'}`);
  }
  lines.push(
    comment(kind, `Generated by Zephyr Workbench for ${input.subject}. Rewritten each time an agent asks for it, so do not edit it.`),
    comment(kind, 'Sets up the environment of the Zephyr terminal, then runs its arguments as a command:'),
    comment(kind, input.usage, '  '),
    comment(kind, kind === 'cmd.exe'
      ? 'Called with no arguments, it sets up the calling cmd session instead.'
      : isPowerShell(kind)
        ? 'Dot-sourced with no arguments, it sets up the calling session instead.'
        : 'Sourced, it only sets up the calling shell, whatever arguments that shell has.'),
  );
  if (isPowerShell(kind)) {
    // Its argument binding splits -NAME:VALUE, which the script cannot undo.
    lines.push(comment(kind, 'PowerShell passes -NAME:VALUE as two arguments, so write CMake options as -DNAME=value, not -DNAME:TYPE=value.'));
  }
  for (const group of input.groups) {
    const entries = Object.entries(group.env);
    if (entries.length === 0) {
      continue;
    }
    lines.push('', comment(kind, group.label));
    for (const [name, value] of entries) {
      lines.push(name.toUpperCase() === 'PATH'
        ? pathLine(kind, String(value), input.basePath, platform)
        : setLine(kind, name, String(value)));
    }
  }
  lines.push('');
  if (kind === 'cmd.exe') {
    lines.push(
      sourceLine(kind, input.envScript),
      'if errorlevel 1 exit /b %errorlevel%',
      'if "%~1"=="" exit /b 0',
      // One line: cmd rereads a running batch file at its old byte offset
      // after each command, and an env call can rewrite this one meanwhile.
      // `call` reads the errorlevel only once the command has run.
      '%* & call exit /b %%errorlevel%%',
    );
    // cmd reads a batch file with LF line ends mostly, but not its labels and blocks.
    return `${lines.join('\r\n')}\r\n`;
  }
  if (isPowerShell(kind)) {
    lines.push(
      sourceLine(kind, input.envScript),
      'if ($args.Count -gt 0) {',
      '  $global:LASTEXITCODE = 0',
      // $args[1..0] would count down, so a command with no arguments gets none.
      '  $zwArgs = @(if ($args.Count -gt 1) { $args[1..($args.Count - 1)] })',
      '  & $args[0] @zwArgs',
      `  ${POWERSHELL_EXIT}`,
      '}',
    );
    // Without a BOM, Windows PowerShell reads the file in the ANSI code page
    // and garbles every value beyond ASCII.
    return `\ufeff${lines.join('\n')}\n`;
  }
  // Sourced by `.`, the script sees the caller's own arguments, which are not
  // a command for it to run.
  const executed = kind === 'zsh'
    ? '[[ $ZSH_EVAL_CONTEXT != *:file* ]]'
    : '[ "${BASH_SOURCE:-$0}" = "$0" ]';
  lines.push(
    // `return` ends a sourced script without closing the caller's shell; run
    // as a program, it fails and `exit` ends the script instead.
    `${sourceLine(kind, input.envScript)} || { zw_status=$?; echo "Zephyr Workbench: the environment script failed with status $zw_status." >&2; return "$zw_status" 2>/dev/null || exit "$zw_status"; }`,
    `if ${executed} && [ "$#" -gt 0 ]; then`,
    '  "$@"',
    'fi',
  );
  return `${lines.join('\n')}\n`;
}
