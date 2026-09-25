import { strict as assert } from 'assert';
import * as vscode from 'vscode';

// The module's vscode import resolves to the stub under src/test/unit/stubs
// (NODE_PATH), like the other unit tests. Only pure exports are exercised.
import {
  buildStartupSetupShellArgs,
  buildTerminalEnvCommands,
  classifyShell,
  createSetupTerminal,
  getResolvedShell,
  getShellSourceCommand,
  getSubstitutedShellName,
  isCshFamily,
  isCygwin,
  isUnsupportedCshShell,
  isUnsupportedPosixShell,
  makeConfiguredVariableResolver,
  normalizeEnvRecordForShell,
  normalizeEnvValueForShell,
  normalizeEnvVarsForShell,
  normalizePathForShell,
} from '../../utils/execUtils';

describe('normalizePathForShell', () => {
  it('converts backslashes for POSIX kinds without quoting', () => {
    assert.equal(normalizePathForShell('bash', 'C:\\a b\\c'), 'C:/a b/c');
  });

  it('leaves cmd.exe paths untouched', () => {
    assert.equal(normalizePathForShell('cmd.exe', 'C:\\a b\\c'), 'C:\\a b\\c');
  });

  it('still rewrites env-script extensions per shell', () => {
    assert.equal(normalizePathForShell('bash', 'C:\\env.bat'), 'C:/env.sh');
    assert.equal(normalizePathForShell('powershell.exe', 'C:\\env.bat'), 'C:\\env.ps1');
  });
});

describe('getShellSourceCommand', () => {
  it('quotes spaced script paths itself', () => {
    assert.equal(getShellSourceCommand('bash', 'C:/a b/env.sh'), '. "C:/a b/env.sh"');
    assert.equal(getShellSourceCommand('cmd.exe', 'C:\\a b\\env.bat'), 'call "C:\\a b\\env.bat"');
  });

  it('leaves space-free paths unquoted and is idempotent on quoted input', () => {
    assert.equal(getShellSourceCommand('bash', 'C:/env.sh'), '. C:/env.sh');
    assert.equal(getShellSourceCommand('bash', '"C:/a b/env.sh"'), '. "C:/a b/env.sh"');
  });
});

describe('buildStartupSetupShellArgs', () => {
  it('bakes the setup into cmd.exe /k', () => {
    assert.deepEqual(
      buildStartupSetupShellArgs('cmd.exe', ['set X=1']),
      ['/k', '@echo off && set X=1'],
    );
    assert.deepEqual(
      buildStartupSetupShellArgs('cmd.exe', []),
      ['/k', '@echo off'],
    );
  });

  it('bakes the setup into PowerShell -NoExit -Command', () => {
    assert.deepEqual(
      buildStartupSetupShellArgs('powershell.exe', ['a', 'b']),
      ['-NoExit', '-Command', 'a; b'],
    );
  });

  it('returns undefined for POSIX shells', () => {
    for (const kind of ['bash', 'zsh', 'dash', 'fish']) {
      assert.equal(buildStartupSetupShellArgs(kind, ['echo ok']), undefined, kind);
    }
  });
});

describe('createSetupTerminal', () => {
  const originalCreateTerminal = (vscode.window as any).createTerminal;
  let created: { options: any; sent: string[] }[];

  beforeEach(() => {
    created = [];
    (vscode.window as any).createTerminal = (options: any) => {
      const record = { options, sent: [] as string[] };
      created.push(record);
      return { sendText: (text: string) => record.sent.push(text) };
    };
  });
  afterEach(() => { (vscode.window as any).createTerminal = originalCreateTerminal; });

  const groups = [{ label: 'Helpers', env: { PYTHON_VENV_PATH: '/ws/.venv' } }];
  const banner = [
    '======= Zephyr Workbench Environment =======',
    '----- Helpers -----',
    'PYTHON_VENV_PATH=/ws/.venv',
    '============================================',
  ].join('\n');

  it('starts POSIX shells with the user args and types a short setup after startup', () => {
    createSetupTerminal(
      { name: 't', shellPath: '/bin/bash', shellArgs: ['--login', '-i'], env: { A: '1' } },
      'bash',
      '/home/u/env.sh',
      groups,
    );
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].options.shellArgs, ['--login', '-i']);
    // The banner rides in the env, so the typed line stays short whatever the groups hold.
    assert.deepEqual(created[0].options.env, { A: '1', ZEPHYR_WORKBENCH_BANNER: banner });
    assert.deepEqual(created[0].sent, [
      ` clear && . /home/u/env.sh && printf '%s\\n' "$ZEPHYR_WORKBENCH_BANNER"; unset ZEPHYR_WORKBENCH_BANNER`,
    ]);
  });

  it('keeps the silent launch-args startup for cmd and PowerShell', () => {
    createSetupTerminal({ name: 't', shellPath: 'cmd.exe', shellArgs: ['/d'] }, 'cmd.exe', 'C:\\env.bat', []);
    createSetupTerminal({ name: 't', shellPath: 'pwsh.exe' }, 'pwsh.exe', 'C:\\env.bat', groups);
    assert.deepEqual(created[0].options.shellArgs, [
      '/k',
      '@echo off && call C:\\env.bat && echo "======= Zephyr Workbench Environment =======" '
      + '&& echo "============================================"',
    ]);
    assert.deepEqual(created[1].options.shellArgs, [
      '-NoExit',
      '-Command',
      '. C:\\env.ps1; Write-Output "======= Zephyr Workbench Environment ======="; '
      + 'Write-Output "----- Helpers -----"; Write-Output PYTHON_VENV_PATH="/ws/.venv"; '
      + 'Write-Output "============================================"',
    ]);
    assert.equal('ZEPHYR_WORKBENCH_BANNER' in (created[1].options.env ?? {}), false);
    assert.deepEqual(created.map(c => c.sent), [[], []]);
  });
});

describe('normalizeEnvVarsForShell', () => {
  it('slash-converts POSIX values without embedding quotes', () => {
    const out = normalizeEnvVarsForShell(
      { EXTRA_CONF_FILE: 'C:\\Users\\Roy Jamil\\app\\extra.conf' },
      'bash',
    );
    assert.equal(out.EXTRA_CONF_FILE, 'C:/Users/Roy Jamil/app/extra.conf');
  });

  it("joins arrays with ';' after per-entry conversion and drops empties", () => {
    const out = normalizeEnvVarsForShell(
      { EXTRA_CONF_FILE: ['a b\\c.conf', '', 'd.conf'], EMPTY: '', NONE: [] },
      'bash',
    );
    assert.equal(out.EXTRA_CONF_FILE, 'a b/c.conf;d.conf');
    assert.equal('EMPTY' in out, false);
    assert.equal('NONE' in out, false);
  });

  it('returns cmd.exe / PowerShell values unchanged', () => {
    const raw = { P: 'C:\\a b\\c' };
    assert.equal(normalizeEnvVarsForShell(raw, 'cmd.exe').P, 'C:\\a b\\c');
    assert.equal(normalizeEnvVarsForShell(raw, 'powershell.exe').P, 'C:\\a b\\c');
  });

  it('no longer rewrites %VAR% references or script extensions in values', () => {
    const out = normalizeEnvVarsForShell(
      { A: '%USERPROFILE%\\x', B: 'C:\\run.bat' },
      'bash',
    );
    assert.equal(out.A, '%USERPROFILE%/x');
    assert.equal(out.B, 'C:/run.bat');
  });
});

describe('normalizeEnvValueForShell / normalizeEnvRecordForShell', () => {
  it('slash-converts only for POSIX kinds', () => {
    assert.equal(normalizeEnvValueForShell('bash', 'C:\\ws\\zephyr'), 'C:/ws/zephyr');
    assert.equal(normalizeEnvValueForShell('cmd.exe', 'C:\\ws\\zephyr'), 'C:\\ws\\zephyr');
    assert.equal(normalizeEnvValueForShell('pwsh.exe', 'C:\\ws\\zephyr'), 'C:\\ws\\zephyr');
  });

  it('skips PATH-like keys case-insensitively', () => {
    const out = normalizeEnvRecordForShell('bash', {
      Path: 'C:\\bin;C:\\tools',
      ZEPHYR_BASE: 'C:\\ws\\zephyr',
    });
    assert.equal(out.Path, 'C:\\bin;C:\\tools');
    assert.equal(out.ZEPHYR_BASE, 'C:/ws/zephyr');
  });
});

describe('isCygwin', () => {
  it('matches Cygwin shells in either slash direction and any case', () => {
    for (const p of [
      'C:\\cygwin64\\bin\\bash.exe',
      'C:/cygwin64/bin/bash.exe',
      'D:\\Cygwin\\bin\\bash.exe',
      'C:\\cygwin-portable\\bin\\zsh.exe',
      'C:\\cygwin64\\bin\\bash',
    ]) {
      assert.equal(isCygwin(p), true, p);
    }
  });

  it('does not match Git Bash, MSYS2 or non-bash shells', () => {
    for (const p of [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\msys64\\usr\\bin\\bash.exe',
      '/usr/bin/bash',
      'C:\\Windows\\System32\\cmd.exe',
    ]) {
      assert.equal(isCygwin(p), false, p);
    }
  });
});

describe('isCshFamily', () => {
  it('matches csh and tcsh in any directory, case, with optional .exe', () => {
    for (const p of [
      '/bin/tcsh',
      '/bin/csh',
      '/usr/bin/csh',
      '/usr/local/bin/tcsh',
      'C:\\cygwin64\\bin\\tcsh.exe',
      '/opt/TCSH',
    ]) {
      assert.equal(isCshFamily(p), true, p);
    }
  });

  it('does not match Bourne-family or other supported shells', () => {
    for (const p of [
      '/bin/bash',
      '/bin/zsh',
      '/usr/bin/dash',
      '/usr/bin/fish',
      '/bin/sh',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\System32\\cmd.exe',
    ]) {
      assert.equal(isCshFamily(p), false, p);
    }
  });
});

describe('getResolvedShell csh fallback', () => {
  const originalShell = vscode.env.shell;
  afterEach(() => { (vscode.env as any).shell = originalShell; });

  it('substitutes a Bourne shell when the resolved shell is csh/tcsh', () => {
    (vscode.env as any).shell = '/bin/tcsh';
    const resolved = getResolvedShell();
    assert.equal(isCshFamily(resolved.path), false, resolved.path);
    assert.ok(['/bin/bash', '/bin/zsh'].includes(resolved.path), resolved.path);
    // csh-meant args must not leak onto the Bourne fallback.
    assert.equal(resolved.args, undefined);
  });

  it('leaves a Bourne shell untouched', () => {
    (vscode.env as any).shell = '/bin/bash';
    assert.deepEqual(getResolvedShell(), { path: '/bin/bash' });
  });

  it('isUnsupportedCshShell reflects the pre-substitution shell', () => {
    (vscode.env as any).shell = '/bin/tcsh';
    assert.equal(isUnsupportedCshShell(), true);
    (vscode.env as any).shell = '/bin/zsh';
    assert.equal(isUnsupportedCshShell(), false);
  });

  it('classifyShell still maps tcsh to bash (union intentionally unchanged)', () => {
    assert.equal(classifyShell('/bin/tcsh'), 'bash');
  });
});

describe('isUnsupportedPosixShell', () => {
  it('flags every non-bash/zsh shell on POSIX platforms', () => {
    for (const platform of ['linux', 'darwin'] as NodeJS.Platform[]) {
      for (const p of [
        '/usr/bin/fish',
        '/bin/dash',
        '/bin/sh',
        '/bin/csh',
        '/bin/tcsh',
        '/usr/bin/ksh',
        '/usr/bin/nu',
      ]) {
        assert.equal(isUnsupportedPosixShell(p, platform), true, `${platform} ${p}`);
      }
    }
  });

  it('allows bash and zsh, including versioned names', () => {
    for (const p of ['/bin/bash', '/usr/bin/zsh', '/usr/local/bin/bash-5.2']) {
      assert.equal(isUnsupportedPosixShell(p, 'linux'), false, p);
      assert.equal(isUnsupportedPosixShell(p, 'darwin'), false, p);
    }
  });

  it('is never true on win32 (shells resolve via terminal profiles there)', () => {
    for (const p of [
      'C:\\msys64\\usr\\bin\\fish.exe',
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      '/usr/bin/fish',
    ]) {
      assert.equal(isUnsupportedPosixShell(p, 'win32'), false, p);
    }
  });
});

// getResolvedShell/getSubstitutedShellName consult the real process.platform
// for the non-csh substitution, so assert per platform: substitution on POSIX
// (CI runs Linux), pass-through on win32 by design.
describe('getResolvedShell unsupported POSIX shell fallback', () => {
  const itPosix = process.platform === 'win32' ? it.skip : it;
  const itWin = process.platform === 'win32' ? it : it.skip;
  const originalShell = vscode.env.shell;
  afterEach(() => { (vscode.env as any).shell = originalShell; });

  itPosix('substitutes a Bourne shell for fish and dash', () => {
    for (const shell of ['/usr/bin/fish', '/bin/dash']) {
      (vscode.env as any).shell = shell;
      const resolved = getResolvedShell();
      assert.ok(['/bin/bash', '/bin/zsh'].includes(resolved.path), `${shell} -> ${resolved.path}`);
      assert.equal(resolved.args, undefined);
    }
  });

  itPosix('getSubstitutedShellName names the replaced shell, undefined for bash/zsh', () => {
    (vscode.env as any).shell = '/usr/bin/fish';
    assert.equal(getSubstitutedShellName(), 'fish');
    (vscode.env as any).shell = '/bin/bash';
    assert.equal(getSubstitutedShellName(), undefined);
    (vscode.env as any).shell = '/usr/bin/zsh';
    assert.equal(getSubstitutedShellName(), undefined);
  });

  itWin('leaves non-csh shells untouched on win32', () => {
    (vscode.env as any).shell = '/usr/bin/fish';
    assert.deepEqual(getResolvedShell(), { path: '/usr/bin/fish' });
    assert.equal(getSubstitutedShellName(), undefined);
  });

  it('still substitutes and reports csh on every platform', () => {
    (vscode.env as any).shell = '/bin/tcsh';
    assert.ok(['/bin/bash', '/bin/zsh'].includes(getResolvedShell().path));
    assert.equal(getSubstitutedShellName(), 'tcsh');
  });
});

describe('buildTerminalEnvCommands', () => {
  it('echoes the exact injected value for POSIX shells (no /cygdrive rewrite)', () => {
    const { setCommands, echoCommands } = buildTerminalEnvCommands('bash', [
      { label: 'Zephyr build system', env: { ZEPHYR_BASE: 'C:/ws/zephyr' } },
    ]);
    assert.equal(setCommands[0], 'export ZEPHYR_BASE="C:/ws/zephyr"');
    assert.ok(echoCommands.some(c => c.includes('ZEPHYR_BASE="C:/ws/zephyr"')));
    assert.ok(echoCommands.every(c => !c.includes('/cygdrive/')));
  });

  it('uses Write-Output and $env: for PowerShell', () => {
    const { setCommands, echoCommands } = buildTerminalEnvCommands('powershell.exe', [
      { label: 'Helpers', env: { PYTHON_VENV_PATH: 'C:\\ws\\.venv' } },
    ]);
    assert.equal(setCommands[0], `$env:PYTHON_VENV_PATH = 'C:\\ws\\.venv'`);
    assert.ok(echoCommands.some(c => c.startsWith('Write-Output PYTHON_VENV_PATH=')));
  });

  it('returns the banner as plain text, one line per echo command', () => {
    const { echoCommands, bannerLines } = buildTerminalEnvCommands('bash', [
      { label: 'Zephyr build system', env: { ZEPHYR_BASE: '/ws/zephyr' } },
      { label: 'Empty', env: {} },
    ]);
    assert.deepEqual(bannerLines, [
      '======= Zephyr Workbench Environment =======',
      '----- Zephyr build system -----',
      'ZEPHYR_BASE=/ws/zephyr',
      '============================================',
    ]);
    assert.equal(bannerLines.length, echoCommands.length);
  });
});

describe('makeConfiguredVariableResolver', () => {
  it('returns undefined for unknown variable names', () => {
    const resolve = makeConfiguredVariableResolver(undefined);
    assert.equal(resolve('input:west.runner'), undefined);
    assert.equal(resolve('BUILD_DIR'), undefined);
  });

  it('resolves env:... names to their raw values (no path.normalize)', () => {
    process.env.ZW_TEST_RESOLVER_VAR = 'https://example.com/pack';
    try {
      const resolve = makeConfiguredVariableResolver(undefined);
      assert.equal(resolve('env:ZW_TEST_RESOLVER_VAR'), 'https://example.com/pack');
    } finally {
      delete process.env.ZW_TEST_RESOLVER_VAR;
    }
  });

  it('resolves an unset env:... name to the empty string', () => {
    const resolve = makeConfiguredVariableResolver(undefined);
    assert.equal(resolve('env:ZW_TEST_RESOLVER_UNSET'), '');
  });
});
