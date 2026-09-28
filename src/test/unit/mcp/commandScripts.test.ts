// The text run_command hands a shell: the command line of a run and the
// script env writes. Each shell's form is checked as text everywhere, and
// run for real by the shells this machine has (cmd and Windows PowerShell on
// Windows, bash elsewhere), with a Node program standing in for west that
// prints the environment it got and exits with the code it is told.

import { strict as assert } from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  batchSetLine, CMD_COMMAND_VARIABLE, composeRunCommandLine, envScriptFor, kindOfShell, renderEnvScript, runCommandEnv, shellOfKind,
} from '../../../mcp/host/commandScripts';
import { TerminalEnvGroup } from '../../../utils/execUtils';

/** Values every shell quotes differently. */
const TRICKY: Record<string, string> = {
  SPACED: 'C:\\Program Files\\Zephyr SDK',
  QUOTED: 'say "hi" & bye',
  SINGLE: "it's done",
  PERCENT: '100% of %PATH%',
  DOLLAR: '$HOME $(whoami) `id` \\n',
  CARET: 'a^b|c<d>e(f)',
  // PowerShell reads each of these as a single quote.
  TYPOGRAPHIC: 'D\u2019Angelo\u2018; Write-Output INJECTED; \u201a\u201b\'',
};

const groups = (extra: Record<string, string> = {}): TerminalEnvGroup[] => [
  { label: 'Zephyr build system', env: { ZEPHYR_BASE: '/ws/zephyr', ...TRICKY } },
  { label: 'Empty', env: {} },
  { label: 'Helpers', env: { PYTHON_VENV_PATH: '/ws/.venv', ...extra } },
];

describe('mcp/host/commandScripts', () => {
  describe('shells', () => {
    it('names every shell kind with the four an agent is told about', () => {
      assert.deepEqual(['bash', 'zsh', 'dash', 'fish', 'cmd.exe', 'powershell.exe', 'pwsh.exe'].map(shellOfKind),
        ['bash', 'zsh', 'bash', 'bash', 'cmd', 'powershell', 'powershell']);
      assert.deepEqual((['bash', 'zsh', 'powershell', 'cmd'] as const).map(kindOfShell), ['bash', 'zsh', 'powershell.exe', 'cmd.exe']);
    });

    it('sources the environment script of each shell flavour', () => {
      assert.equal(envScriptFor('bash', 'C:\\Users\\me\\.zinstaller\\env.ps1'), 'C:/Users/me/.zinstaller/env.sh');
      assert.equal(envScriptFor('zsh', '/home/me/.zinstaller/env.sh'), '/home/me/.zinstaller/env.sh');
      assert.equal(envScriptFor('powershell.exe', 'C:\\Users\\me\\.zinstaller\\env.bat'), 'C:\\Users\\me\\.zinstaller\\env.ps1');
      assert.equal(envScriptFor('pwsh.exe', 'C:\\Users\\me\\.zinstaller\\env.sh'), 'C:\\Users\\me\\.zinstaller\\env.ps1');
      // The Zephyr terminal would `call env.ps1` here; env.bat is what cmd runs.
      assert.equal(envScriptFor('cmd.exe', 'C:\\Users\\me\\.zinstaller\\env.ps1'), 'C:\\Users\\me\\.zinstaller\\env.bat');
      assert.equal(envScriptFor('cmd.exe', 'C:\\tools\\myenv.cmd'), 'C:\\tools\\myenv.cmd');
    });
  });

  describe('composeRunCommandLine', () => {
    it('sources the script, then runs the command, for bash and zsh', () => {
      assert.equal(composeRunCommandLine('bash', 'C:/Users/me/env.sh', 'west boards | head'), ". 'C:/Users/me/env.sh' && west boards | head");
      assert.equal(composeRunCommandLine('zsh', '/opt/my tools/env.sh', 'west boards'), ". '/opt/my tools/env.sh' && west boards");
    });

    it('quotes a script path with an apostrophe as a literal, which a bare path would leave open', () => {
      assert.equal(composeRunCommandLine('bash', "C:/Users/O'Brien/env.sh", 'west boards'), ". 'C:/Users/O'\\''Brien/env.sh' && west boards");
      assert.ok(composeRunCommandLine('powershell.exe', "C:\\Users\\O'Brien\\env.ps1", 'x').includes(" . 'C:\\Users\\O''Brien\\env.ps1' ; "));
    });

    it('calls the batch script for cmd, and leaves the command to a variable an inner cmd reads after it', () => {
      assert.equal(composeRunCommandLine('cmd.exe', 'C:\\Users\\me\\env.bat', 'echo %VIRTUAL_ENV%'),
        `call "C:\\Users\\me\\env.bat" && cmd /d /v:on /s /c "cmd /d /v:off /s /c "!${CMD_COMMAND_VARIABLE}!""`);
      assert.deepEqual(runCommandEnv('cmd.exe', 'echo %VIRTUAL_ENV%'), { [CMD_COMMAND_VARIABLE]: 'echo %VIRTUAL_ENV%' });
      assert.deepEqual(runCommandEnv('bash', 'west boards'), {});
    });

    it('carries a native exit code out of PowerShell, on a line of its own after the command, with its messages in UTF-8', () => {
      const line = composeRunCommandLine('powershell.exe', 'C:\\Users\\me\\env.ps1', 'west boards # all of them');
      assert.equal(line,
        "try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {} ; . 'C:\\Users\\me\\env.ps1' ; $global:LASTEXITCODE = 0 ; west boards # all of them\n"
        + '$zwOk = $? ; if ($LASTEXITCODE) { exit $LASTEXITCODE } ; if (-not $zwOk) { exit 1 }');
      assert.equal(composeRunCommandLine('pwsh.exe', 'C:\\env.ps1', 'x').split('\n').length, 2);
      assert.match(composeRunCommandLine('pwsh.exe', 'C:\\env.ps1', 'x'), /^try \{ \[Console\]::OutputEncoding = \[Text\.Encoding\]::UTF8 \} catch \{\} ; /);
    });
  });

  describe('batchSetLine', () => {
    it('doubles % and keeps the special characters literal inside quotes', () => {
      assert.equal(batchSetLine('A', 'C:\\Program Files\\x'), 'set "A=C:\\Program Files\\x"');
      assert.equal(batchSetLine('A', '100% of %PATH%'), 'set "A=100%% of %%PATH%%"');
      assert.equal(batchSetLine('A', 'a^b|c<d>e(f)&g'), 'set "A=a^b|c<d>e(f)&g"');
    });

    it('escapes every special character when a quote would end the quoted part early', () => {
      assert.equal(batchSetLine('A', 'say "hi" & bye'), 'set A=say ^"hi^" ^& bye');
      assert.equal(batchSetLine('A', '-DX="a|b" 5%'), 'set A=-DX=^"a^|b^" 5%%');
    });

    it('turns a line break into a space, since a batch line ends there', () => {
      assert.equal(batchSetLine('A', 'one\r\ntwo'), 'set "A=one two"');
    });
  });

  describe('renderEnvScript', () => {
    const input = { subject: 'blinky (primary)', groups: groups(), envScript: '/home/me/.zinstaller/env.sh', usage: 'bash /x/blinky.sh west boards' };

    it('writes a bash script that exports each value quoted, sources the env script and runs its arguments', () => {
      const text = renderEnvScript('bash', { ...input, platform: 'linux' });
      const lines = text.split('\n');
      assert.equal(lines[0], '#!/usr/bin/env bash');
      assert.ok(!text.includes('\r'), 'bash reads a carriage return as part of the line');
      assert.ok(lines.includes('export SPACED="C:\\\\Program Files\\\\Zephyr SDK"'));
      assert.ok(lines.includes('export QUOTED="say \\"hi\\" & bye"'));
      assert.ok(lines.includes('export DOLLAR="\\$HOME \\$(whoami) \\`id\\` \\\\n"'));
      assert.ok(lines.includes('export PYTHON_VENV_PATH="/ws/.venv"'));
      assert.ok(lines.includes('# Zephyr build system') && !lines.includes('# Empty'));
      assert.match(text, /^\. '\/home\/me\/\.zinstaller\/env\.sh' \|\| \{ zw_status=\$\?;.*return "\$zw_status" 2>\/dev\/null \|\| exit "\$zw_status"; \}$/m);
      // Sourced, it would see its caller's arguments: only a script run as a program runs them.
      assert.match(text, /if \[ "\$\{BASH_SOURCE:-\$0\}" = "\$0" \] && \[ "\$#" -gt 0 \]; then\n {2}"\$@"\nfi\n$/);
      assert.match(text, /# {3}bash \/x\/blinky\.sh west boards/);
      const zsh = renderEnvScript('zsh', input);
      assert.equal(zsh.split('\n')[0], '#!/usr/bin/env zsh');
      assert.match(zsh, /if \[\[ \$ZSH_EVAL_CONTEXT != \*:file\* \]\] && \[ "\$#" -gt 0 \]; then\n {2}"\$@"\nfi\n$/);
    });

    it('writes a PowerShell script with single-quoted values, and runs a command with no arguments too', () => {
      const text = renderEnvScript('powershell.exe', { ...input, envScript: 'C:\\Users\\me\\env.ps1' });
      // Windows PowerShell reads a file with no BOM in the ANSI code page.
      assert.ok(text.startsWith('\ufeff'));
      const lines = text.split('\n');
      assert.ok(lines.includes("$env:SINGLE = 'it''s done'"));
      assert.ok(lines.includes("$env:TYPOGRAPHIC = 'D\u2019\u2019Angelo\u2018\u2018; Write-Output INJECTED; \u201a\u201a\u201b\u201b'''"),
        'every quote PowerShell reads as one is doubled');
      assert.ok(lines.some(line => /^# .*-DNAME=value/.test(line)), 'says how to pass a typed CMake option');
      assert.ok(lines.includes("$env:DOLLAR = '$HOME $(whoami) `id` \\n'"));
      assert.ok(lines.includes("$env:PERCENT = '100% of %PATH%'"));
      assert.ok(lines.includes(". 'C:\\Users\\me\\env.ps1'"));
      assert.ok(lines.includes('  $zwArgs = @(if ($args.Count -gt 1) { $args[1..($args.Count - 1)] })'));
      assert.ok(lines.includes('  & $args[0] @zwArgs'));
      assert.ok(lines.includes('  $zwOk = $? ; if ($LASTEXITCODE) { exit $LASTEXITCODE } ; if (-not $zwOk) { exit 1 }'));
    });

    it('writes a batch file with CRLF line ends, doubled %, and the command\'s exit code', () => {
      const text = renderEnvScript('cmd.exe', { ...input, envScript: 'C:\\Users\\me\\env.bat', subject: 'app 100% & more' });
      assert.ok(text.endsWith('\r\n') && !/[^\r]\n/.test(text), 'every line ends with CRLF');
      const lines = text.split('\r\n');
      assert.equal(lines[0], '@echo off');
      assert.match(lines[1], /^rem Generated by Zephyr Workbench for app 100_ _ more\./);
      assert.ok(lines.includes('set "PERCENT=100%% of %%PATH%%"'));
      assert.ok(lines.includes('set QUOTED=say ^"hi^" ^& bye'));
      assert.ok(lines.includes('set "CARET=a^b|c<d>e(f)"'));
      // cmd reads nothing after the line that runs the command, which an env call may rewrite meanwhile.
      assert.deepEqual(lines.slice(-5), [
        'call "C:\\Users\\me\\env.bat"', 'if errorlevel 1 exit /b %errorlevel%', 'if "%~1"=="" exit /b 0', '%* & call exit /b %%errorlevel%%', '',
      ]);
    });

    it('puts the toolchain folders in front of the calling shell\'s PATH instead of copying VS Code\'s', () => {
      const base = '/usr/bin:/bin';
      const withPath = (kind: string, value: string, platform: NodeJS.Platform, basePath: string) =>
        renderEnvScript(kind, { ...input, groups: [{ label: 'Toolchain', env: { PATH: value } }], basePath, platform });
      assert.match(withPath('bash', `/opt/rust/bin:${base}`, 'linux', base), /^export PATH="\/opt\/rust\/bin:\$PATH"$/m);
      const winBase = 'C:\\Windows\\system32;C:\\Windows';
      assert.match(withPath('bash', `C:\\rust\\bin;D:\\mingw64\\bin;${winBase}`, 'win32', winBase),
        /^export PATH="\/c\/rust\/bin:\/d\/mingw64\/bin:\$PATH"$/m);
      assert.match(withPath('powershell.exe', `C:\\rust's\\bin;${winBase}`, 'win32', winBase),
        /^\$env:PATH = 'C:\\rust''s\\bin' \+ \[IO\.Path\]::PathSeparator \+ \$env:PATH$/m);
      assert.match(withPath('powershell.exe', `C:\\D\u2019Angelo\\bin;${winBase}`, 'win32', winBase),
        /^\$env:PATH = 'C:\\D\u2019\u2019Angelo\\bin' \+ /m);
      assert.match(withPath('cmd.exe', `C:\\rust 1%\\bin;${winBase}`, 'win32', winBase), /^set "PATH=C:\\rust 1%%\\bin;%PATH%"\r$/m);
      // A PATH of its own is set whole, as the terminal gets it.
      assert.match(withPath('bash', '/only/this', 'linux', base), /^export PATH="\/only\/this"$/m);
    });
  });

  describe('run by the shells of this machine', function () {
    this.timeout(60000);
    let dir: string;
    let printer: string;
    const node = process.execPath;

    before(() => {
      dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-command-')));
      printer = path.join(dir, 'printer.js');
      fs.writeFileSync(printer, [
        "const names = ['ZEPHYR_BASE', 'SPACED', 'QUOTED', 'SINGLE', 'PERCENT', 'DOLLAR', 'CARET', 'TYPOGRAPHIC', 'PYTHON_VENV_PATH', 'FROM_ENV_SCRIPT', 'PATH'];",
        // ASCII only, so no shell in between can garble it.
        "process.stdout.write(JSON.stringify(Object.fromEntries(names.map(name => [name, process.env[name]]))).replace(/[^\\x20-\\x7e]/g, c => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));",
        'process.exit(Number(process.argv[2] || 0));',
      ].join('\n'));
      fs.writeFileSync(path.join(dir, 'env.bat'), '@echo off\r\nset "FROM_ENV_SCRIPT=yes"\r\n');
      fs.writeFileSync(path.join(dir, 'fail.bat'), '@echo off\r\nexit /b 4\r\n');
      fs.writeFileSync(path.join(dir, 'env.ps1'), "$env:FROM_ENV_SCRIPT = 'yes'\n$global:LASTEXITCODE = 9\n");
      fs.writeFileSync(path.join(dir, 'fail.ps1'), 'exit 4\n');
      fs.writeFileSync(path.join(dir, 'env.sh'), 'export FROM_ENV_SCRIPT=yes\n');
      fs.writeFileSync(path.join(dir, 'fail.sh'), 'return 4\n');
    });

    after(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const extraFolder = () => path.join(dir, 'tool bin');
    const scriptGroups = () => groups({ PATH: `${extraFolder()}${path.delimiter}${process.env.PATH}` });

    function write(kind: string, envScript: string, name: string): string {
      const ext = kind === 'cmd.exe' ? 'bat' : kind === 'powershell.exe' ? 'ps1' : 'sh';
      const file = path.join(dir, `${name}.${ext}`);
      fs.writeFileSync(file, renderEnvScript(kind, {
        subject: 'test', groups: scriptGroups(), envScript, usage: 'x', basePath: process.env.PATH,
      }), { mode: 0o700 });
      return file;
    }

    /** The printer's output alone: a value that broke out of its quotes and ran would print before it. */
    function expectEnvironment(stdout: string, skip: string[] = []): void {
      const seen = JSON.parse(stdout) as Record<string, string>;
      for (const [name, value] of Object.entries(TRICKY).filter(([name]) => !skip.includes(name))) {
        assert.equal(seen[name], value, name);
      }
      assert.equal(seen.FROM_ENV_SCRIPT, 'yes', 'the environment script was sourced');
      assert.equal(seen.PYTHON_VENV_PATH, '/ws/.venv');
      const entries = seen.PATH.split(path.delimiter);
      assert.equal(path.normalize(entries[0]).toLowerCase(), extraFolder().toLowerCase(), 'the toolchain folder comes first');
      assert.ok(entries.length > 1, 'the calling shell keeps its PATH');
    }

    const winOnly = function (this: Mocha.Context) {
      if (process.platform !== 'win32') {
        this.skip();
      }
    };
    const posixOnly = function (this: Mocha.Context) {
      if (process.platform === 'win32') {
        this.skip();
      }
    };

    it('cmd: the batch script sets every value exactly, then runs the command and ends with its code', function () {
      winOnly.call(this);
      const script = write('cmd.exe', path.join(dir, 'env.bat'), 'cmd-env');
      // What an agent in cmd types; `call` keeps cmd from stripping the quotes.
      const run = spawnSync('cmd.exe', ['/d', '/c', `call "${script}" "${node}" "${printer}" 3`], { windowsVerbatimArguments: true, encoding: 'utf8' });
      assert.equal(run.status, 3, run.stderr);
      // cmd reads a batch file in the console code page, so a value beyond ASCII is not kept.
      expectEnvironment(run.stdout, ['TYPOGRAPHIC']);
      const none = spawnSync('cmd.exe', ['/d', '/c', `call "${script}"`], { windowsVerbatimArguments: true, encoding: 'utf8' });
      assert.equal(none.status, 0, none.stderr);
      const failing = write('cmd.exe', path.join(dir, 'fail.bat'), 'cmd-fail');
      const failed = spawnSync('cmd.exe', ['/d', '/c', `call "${failing}" "${node}" "${printer}" 0`], { windowsVerbatimArguments: true, encoding: 'utf8' });
      assert.equal(failed.status, 4, 'a failing environment script stops the command');
      assert.equal(failed.stdout, '');
    });

    it('PowerShell: the script sets every value exactly, then runs the command with or without arguments', function () {
      winOnly.call(this);
      const script = write('powershell.exe', path.join(dir, 'env.ps1'), 'ps-env');
      const file = (...args: string[]) => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { encoding: 'utf8' });
      const run = file(node, printer, '3');
      assert.equal(run.status, 3, run.stderr);
      expectEnvironment(run.stdout);
      const one = file(node, printer);
      assert.equal(one.status, 0, `${one.stderr} (the stale code the env script left must not leak)`);
      // A program alone: $args[1..0] would hand it itself as its argument.
      const bare = file('hostname');
      assert.equal(bare.status, 0, bare.stderr);
      assert.equal(bare.stdout.trim().toLowerCase(), os.hostname().toLowerCase());
      assert.equal(file().status, 0);
      assert.equal(file('Get-Item', path.join(dir, 'missing')).status, 1, 'a failed cmdlet fails the script');
    });

    it('PowerShell and cmd: the run command line ends with the command\'s exit code', function () {
      winOnly.call(this);
      const ps = composeRunCommandLine('powershell.exe', path.join(dir, 'env.ps1'), `& "${node}" "${printer}" 5 # a comment`);
      assert.equal(spawnSync('powershell.exe', ['-Command', ps], { encoding: 'utf8' }).status, 5);
      const psCmdlet = composeRunCommandLine('powershell.exe', path.join(dir, 'env.ps1'), 'Write-Output ok');
      assert.equal(spawnSync('powershell.exe', ['-Command', psCmdlet], { encoding: 'utf8' }).status, 0, 'the code env.ps1 left is cleared');
      const cmd = runCmd(path.join(dir, 'env.bat'), `"${node}" "${printer}" 6`);
      assert.equal(cmd.status, 6);
      assert.equal(JSON.parse(cmd.stdout).FROM_ENV_SCRIPT, 'yes');
    });

    /** A cmd run as the capture spawns it, with the variables the task adds. */
    const runCmd = (envScript: string, command: string) => spawnSync('cmd.exe', ['/d', '/c', composeRunCommandLine('cmd.exe', envScript, command)], {
      windowsVerbatimArguments: true, encoding: 'utf8', env: { ...process.env, ...runCommandEnv('cmd.exe', command) },
    });

    it('cmd: the command sees the variables the environment script sets, and keeps its own special characters', function () {
      winOnly.call(this);
      const run = runCmd(path.join(dir, 'env.bat'), 'echo [%FROM_ENV_SCRIPT%] "a&b" 50% & echo hi!there');
      assert.equal(run.stdout.replace(/\r\n/g, '\n'), '[yes] "a&b" 50% \nhi!there\n', run.stderr);
      assert.equal(runCmd(path.join(dir, 'env.bat'), 'exit /b 7').status, 7);
      assert.equal(runCmd(path.join(dir, 'fail.bat'), 'echo never').status, 4, 'a failing environment script stops the command');
    });

    it('PowerShell and bash: an apostrophe in the environment script path is quoted', function () {
      const quoted = path.join(dir, "O'Brien");
      fs.mkdirSync(quoted, { recursive: true });
      fs.copyFileSync(path.join(dir, 'env.ps1'), path.join(quoted, 'env.ps1'));
      fs.copyFileSync(path.join(dir, 'env.sh'), path.join(quoted, 'env.sh'));
      if (process.platform === 'win32') {
        const ps = composeRunCommandLine('powershell.exe', path.join(quoted, 'env.ps1'), `& "${node}" "${printer}" 5`);
        const run = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
        assert.equal(run.status, 5, run.stderr);
        assert.equal(JSON.parse(run.stdout).FROM_ENV_SCRIPT, 'yes');
      } else {
        const line = composeRunCommandLine('bash', path.join(quoted, 'env.sh'), `"${node}" "${printer}" 5`);
        const run = spawnSync('bash', ['-c', line], { encoding: 'utf8' });
        assert.equal(run.status, 5, run.stderr);
        assert.equal(JSON.parse(run.stdout).FROM_ENV_SCRIPT, 'yes');
      }
    });

    it('cmd: a script rewritten while its command runs does not run the command again', function () {
      winOnly.call(this);
      const script = path.join(dir, 'cmd-race.bat');
      // What an env call does meanwhile: a longer script renamed over this one.
      const longer = renderEnvScript('cmd.exe', {
        subject: 'test after a change', groups: groups({ MORE: 'x'.repeat(300) }), envScript: path.join(dir, 'env.bat'), usage: 'x',
      });
      const child = path.join(dir, 'rewrite.js');
      fs.writeFileSync(child, [
        "const fs = require('fs');",
        `fs.writeFileSync(${JSON.stringify(`${script}.tmp`)}, ${JSON.stringify(longer)});`,
        `fs.renameSync(${JSON.stringify(`${script}.tmp`)}, ${JSON.stringify(script)});`,
        "console.log('ran');",
        'process.exit(3);',
      ].join('\n'));
      for (const form of [`call "${script}" "${node}" "${child}"`, `""${script}" "${node}" "${child}""`]) {
        fs.writeFileSync(script, renderEnvScript('cmd.exe', {
          subject: 'test', groups: groups(), envScript: path.join(dir, 'env.bat'), usage: 'x',
        }));
        const run = spawnSync('cmd.exe', ['/d', '/c', form], { windowsVerbatimArguments: true, encoding: 'utf8' });
        assert.equal(run.stdout.replace(/\r\n/g, '\n'), 'ran\n', form);
        assert.equal(run.stderr, '', form);
        assert.equal(run.status, 3, form);
      }
    });

    it('bash: sourced from a script with arguments, it does not run them', function () {
      posixOnly.call(this);
      const script = write('bash', path.join(dir, 'env.sh'), 'bash-sourced');
      const sourced = spawnSync('bash', ['-c', `. "${script}"; echo "after $FROM_ENV_SCRIPT"`, 'caller', 'zw_should_not_run'], { encoding: 'utf8' });
      assert.equal(sourced.stdout, 'after yes\n');
      assert.equal(sourced.stderr, '');
      const run = spawnSync('bash', [script, 'echo', 'ran'], { encoding: 'utf8' });
      assert.equal(run.stdout, 'ran\n');
      assert.equal(spawnSync('bash', [script, 'false'], { encoding: 'utf8' }).status, 1);
    });

    it('bash: the script sets every value exactly, then runs the command and ends with its code', function () {
      posixOnly.call(this);
      const script = write('bash', path.join(dir, 'env.sh'), 'bash-env');
      const run = spawnSync('bash', [script, node, printer, '3'], { encoding: 'utf8' });
      assert.equal(run.status, 3, run.stderr);
      expectEnvironment(run.stdout);
      assert.equal(spawnSync('bash', [script], { encoding: 'utf8' }).status, 0);
      const sourced = spawnSync('bash', ['-c', `. "${script}" && echo "$FROM_ENV_SCRIPT"`], { encoding: 'utf8' });
      assert.equal(sourced.stdout.trim(), 'yes', 'sourced with no arguments, it sets up the calling shell');
      const failing = write('bash', path.join(dir, 'fail.sh'), 'bash-fail');
      assert.equal(spawnSync('bash', [failing, node, printer, '0'], { encoding: 'utf8' }).status, 4);
      const line = composeRunCommandLine('bash', path.join(dir, 'env.sh'), `"${node}" "${printer}" 6`);
      assert.equal(spawnSync('bash', ['-c', line], { encoding: 'utf8' }).status, 6);
    });
  });
});
