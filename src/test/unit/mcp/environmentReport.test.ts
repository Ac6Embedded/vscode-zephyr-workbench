import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';
import {
  deriveEnvironmentProblems,
  EnvironmentFacts,
  environmentNextSteps,
  isEnvironmentReady,
  isReadyToBuild,
  isSdkMissing,
  QuickEnvironmentFacts,
  summarizeQuickEnvironment,
} from '../../../mcp/core/environmentReport';

type Overrides = {
  [K in Exclude<keyof EnvironmentFacts, 'runners'>]?: Partial<EnvironmentFacts[K]>;
} & { runners?: EnvironmentFacts['runners'] };

/** A machine that can build, adjusted per test. */
function facts(over: Overrides = {}): EnvironmentFacts {
  return {
    platform: over.platform ?? 'linux',
    hostTools: {
      internalDir: '/home/u/.zinstaller',
      installed: true,
      complete: true,
      envFileExists: true,
      stampExists: true,
      zinstallerVersion: '2.1',
      zinstallerMinimum: '2.0',
      zinstallerUpToDate: true,
      missingParts: [],
      ...over.hostTools,
    },
    settings: {
      envScript: '/home/u/.zinstaller/env.sh',
      envScriptExists: true,
      venvSettingOk: true,
      shellUsed: 'bash',
      ...over.settings,
    },
    venv: { path: '/home/u/.zinstaller/.venv', source: 'env-yml', exists: true, minimum: '3.12', ...over.venv },
    west: { found: true, path: '/home/u/.zinstaller/.venv/bin/west', ...over.west },
    sdks: { count: 1, ...over.sdks },
    ...(over.runners ? { runners: over.runners } : {}),
  };
}

const codes = (f: EnvironmentFacts) => deriveEnvironmentProblems(f).map(p => p.code);

describe('mcp/core/environmentReport', () => {
  it('reports nothing and is ready on a healthy machine', () => {
    assert.deepEqual(deriveEnvironmentProblems(facts()), []);
    assert.equal(isEnvironmentReady(facts()), true);
  });

  it('needs every readiness flag', () => {
    const all = { hostToolsComplete: true, envScriptOk: true, venvSettingOk: true, westFound: true, toolchainOk: true };
    assert.equal(isReadyToBuild(all), true);
    for (const key of Object.keys(all) as (keyof typeof all)[]) {
      assert.equal(isReadyToBuild({ ...all, [key]: false }), false, `${key} false must not be ready`);
    }
  });

  it('tells a missing install from an unfinished one', () => {
    const missing = deriveEnvironmentProblems(facts({ hostTools: { installed: false, complete: false } }));
    assert.equal(missing[0].code, 'HOST_TOOLS_MISSING');
    assert.match(missing[0].fix, /"Install Host Tools"/);
    assert.ok(!missing.some(p => p.code === 'HOST_TOOLS_INCOMPLETE'), 'one problem for one cause');

    const unfinished = deriveEnvironmentProblems(facts({ hostTools: { complete: false, stampExists: false } }));
    const incomplete = unfinished.find(p => p.code === 'HOST_TOOLS_INCOMPLETE');
    assert.equal(incomplete?.severity, 'error');
    assert.match(incomplete?.message ?? '', /completion stamp/);
    assert.equal(isEnvironmentReady(facts({ hostTools: { complete: false, stampExists: false } })), false);
  });

  it('keeps a complete install ready when only a single part is missing', () => {
    const f = facts({ hostTools: { missingParts: ['Ninja'] } });
    const problem = deriveEnvironmentProblems(f).find(p => p.code === 'HOST_TOOLS_INCOMPLETE');
    assert.equal(problem?.severity, 'warning');
    assert.match(problem?.message ?? '', /Ninja/);
    assert.match(problem?.fix ?? '', /"Install Host Tools \(Advanced\)"/);
    assert.equal(isEnvironmentReady(f), true);
  });

  it('puts the missing macOS Command Line Tools first, before the installs that need them', () => {
    const fresh = deriveEnvironmentProblems(facts({ hostTools: { installed: false, complete: false, developerToolsMissing: true, homebrewOk: false } }));
    assert.deepEqual(fresh.map(p => p.code).slice(0, 3), ['XCODE_CLT_MISSING', 'HOST_TOOLS_MISSING', 'HOMEBREW_MISSING']);
    assert.equal(fresh[0].severity, 'error');
    assert.match(fresh[0].fix, /^Install them by running xcode-select --install in a terminal, then run .*"Install Host Tools"/);

    const installed = deriveEnvironmentProblems(facts({ hostTools: { developerToolsMissing: true } }));
    assert.deepEqual(installed.map(p => [p.code, p.severity]), [['XCODE_CLT_MISSING', 'warning']]);
    assert.equal(isEnvironmentReady(facts({ hostTools: { developerToolsMissing: true } })), true, 'a finished install still builds');
  });

  it('warns about an old zinstaller without blocking builds', () => {
    const f = facts({ hostTools: { zinstallerVersion: '1.9', zinstallerUpToDate: false } });
    assert.deepEqual(codes(f), ['HOST_TOOLS_OUTDATED']);
    assert.equal(isEnvironmentReady(f), true);
  });

  it('separates an unset env script from one that points nowhere', () => {
    const unset = facts({ settings: { envScript: undefined, envScriptExists: false } });
    assert.ok(codes(unset).includes('ENV_SCRIPT_NOT_SET'));
    assert.equal(isEnvironmentReady(unset), false);
    const dangling = facts({ settings: { envScriptExists: false } });
    assert.ok(codes(dangling).includes('ENV_SCRIPT_MISSING'));
    assert.ok(!codes(dangling).includes('ENV_SCRIPT_NOT_SET'));
  });

  it('reports a broken venv.path once, not again as a missing venv', () => {
    const f = facts({ settings: { venvSetting: '/gone', venvSettingOk: false }, venv: { exists: false }, west: { found: false } });
    const found = codes(f);
    assert.ok(found.includes('VENV_SETTING_INVALID'));
    assert.ok(!found.includes('VENV_MISSING'));
    assert.ok(!found.includes('WEST_MISSING'));
    assert.equal(isEnvironmentReady(f), false);
  });

  it('points an application venv at the workspace venv command', () => {
    const f = facts({ venv: { path: '/ws/.venv', source: 'application', owner: 'west_workspace', exists: false }, west: { found: false } });
    const problem = deriveEnvironmentProblems(f).find(p => p.code === 'VENV_MISSING');
    assert.match(problem?.fix ?? '', /Manage venv: Create\/Recreate Dedicated venv/);
  });

  describe('venv repair advice', () => {
    // A venv that exists, has no west and runs an old Python: WEST_MISSING and PYTHON_TOO_OLD.
    const fixes = (venv: Overrides['venv']) => {
      const problems = deriveEnvironmentProblems(facts({ venv: { exists: true, version: '3.10.4', tooOld: true, ...venv }, west: { found: false } }));
      const fix = (code: string) => problems.find(p => p.code === code)?.fix ?? '';
      return [fix('WEST_MISSING'), fix('PYTHON_TOO_OLD')];
    };

    it('never sends a venv Reinstall VENV cannot rebuild to Reinstall VENV', () => {
      // Reinstall VENV rebuilds only <internal dir>/.venv, so the next check would report the same problem.
      const cases: Array<[Overrides['venv'], RegExp]> = [
        [{ path: '/ws/.venv', source: 'application', owner: 'west_workspace' }, /"Manage venv: Create\/Recreate Dedicated venv" on the west workspace/],
        [{ path: '/ws/app/.venv', source: 'application', owner: 'application' }, /"Create local Python Virtual Environment" on the application/],
        [{ path: '/ws/.venv', source: 'application' }, /west workspace's venv.*application's own/],
        [{ path: '/opt/venvs/zephyr', source: 'setting' }, /zephyr-workbench\.venv\.path points at \(\/opt\/venvs\/zephyr\)/],
      ];
      for (const [venv, expected] of cases) {
        const [west, python] = fixes(venv);
        for (const fix of [west, python]) {
          assert.ok(!fix.includes('Reinstall VENV'), `${JSON.stringify(venv)}: ${fix}`);
          assert.match(fix, expected);
        }
        assert.match(python, /^Install a newer Python, then /);
      }
    });

    it('keeps Reinstall VENV for the host tools venv, however it was reached', () => {
      for (const venv of [
        { source: 'env-yml' },
        { source: 'managed-default' },
        // A per-application venv.path that names the host tools venv is still that venv.
        { path: '/home/u/.zinstaller/.venv/', source: 'application', owner: 'application' as const },
      ]) {
        const [west, python] = fixes(venv);
        assert.equal(west, 'Run the Zephyr Workbench command "Reinstall VENV".');
        assert.equal(python, 'Install a newer Python, then run the Zephyr Workbench command "Reinstall VENV".');
      }
    });
  });

  it('reports west missing from an existing venv', () => {
    const f = facts({ west: { found: false } });
    assert.deepEqual(codes(f), ['WEST_MISSING']);
    assert.equal(isEnvironmentReady(f), false);
  });

  it('warns about an old Python only when its version is known', () => {
    assert.deepEqual(codes(facts({ venv: { version: '3.10.4', tooOld: true } })), ['PYTHON_TOO_OLD']);
    assert.deepEqual(codes(facts({ venv: { tooOld: true } })), []);
  });

  it('needs an SDK unless the application builds with its own toolchain', () => {
    assert.ok(codes(facts({ sdks: { count: 0 } })).includes('NO_SDK'));
    assert.equal(isEnvironmentReady(facts({ sdks: { count: 0 } })), false);

    const armGnu = facts({ sdks: { count: 0, application: { toolchainVariant: 'gnuarmemb', needsSdk: false, toolchainResolved: true } } });
    assert.deepEqual(codes(armGnu), []);
    assert.equal(isEnvironmentReady(armGnu), true);
  });

  it('reports an application toolchain that is no longer registered', () => {
    const f = facts({ sdks: { count: 0, application: { toolchainVariant: 'gnuarmemb', needsSdk: false, toolchainResolved: false } } });
    const problem = deriveEnvironmentProblems(f).find(p => p.code === 'TOOLCHAIN_MISSING');
    assert.equal(problem?.severity, 'error');
    assert.match(problem?.message ?? '', /gnuarmemb/);
    assert.equal(isEnvironmentReady(f), false);
  });

  it('warns about an SDK that does not match the Zephyr version, with the matrix message', () => {
    const f = facts({ sdks: { application: { toolchainVariant: 'zephyr', needsSdk: true, toolchainResolved: true, compat: { status: 'incompatible', message: 'Zephyr 4.2 needs SDK 0.17.' } } } });
    const problem = deriveEnvironmentProblems(f).find(p => p.code === 'SDK_INCOMPATIBLE');
    assert.equal(problem?.message, 'Zephyr 4.2 needs SDK 0.17.');
    assert.equal(isEnvironmentReady(f), true, 'a mismatch is a warning, the build may still work');
    assert.deepEqual(codes(facts({ sdks: { application: { toolchainVariant: 'zephyr', needsSdk: true, toolchainResolved: true, compat: { status: 'unknown' } } } })), []);
  });

  it('checks the tools the configured runners need, a debug runner only as a warning', () => {
    const f = facts({
      runners: [
        { runner: 'jlink', role: 'default_flash', toolIds: ['jlink'], toolNames: ['SEGGER J-Link'], installed: false, updateAvailable: false },
        { runner: 'openocd', role: 'default_debug', toolIds: ['openocd'], toolNames: ['OpenOCD'], installed: false, updateAvailable: false },
        { runner: 'pyocd', role: 'configured', toolIds: ['pyocd'], toolNames: ['pyOCD'], installed: true, updateAvailable: true },
        { runner: 'nrfutil', role: 'configured', toolIds: ['nrfutil'], toolNames: [], installed: null, updateAvailable: false },
      ],
    });
    const problems = deriveEnvironmentProblems(f);
    const flash = problems.find(p => p.code === 'RUNNER_TOOL_MISSING' && p.message.includes('jlink'));
    const debug = problems.find(p => p.code === 'RUNNER_TOOL_MISSING' && p.message.includes('openocd'));
    assert.equal(flash?.severity, 'error');
    assert.match(flash?.message ?? '', /SEGGER J-Link/);
    assert.match(flash?.fix ?? '', /"Install Runners"/);
    assert.equal(debug?.severity, 'warning');
    assert.ok(problems.some(p => p.code === 'RUNNER_TOOL_OUTDATED' && p.message.includes('pyOCD')));
    assert.ok(!problems.some(p => p.message.includes('nrfutil')), 'an unknown answer is not a problem');
  });

  it('lists errors before warnings and dedupes the next steps', () => {
    const f = facts({
      hostTools: { zinstallerVersion: '1.0', zinstallerUpToDate: false },
      settings: { envScript: undefined, envScriptExists: false },
      sdks: { count: 0 },
    });
    const problems = deriveEnvironmentProblems(f);
    const firstWarning = problems.findIndex(p => p.severity === 'warning');
    assert.ok(firstWarning > 0);
    assert.ok(problems.slice(firstWarning).every(p => p.severity === 'warning'));
    const steps = environmentNextSteps([...problems, ...problems]);
    assert.equal(steps.length, new Set(problems.map(p => p.fix)).size);
  });

  it('names only real Zephyr Workbench commands and never an em-dash', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../package.json'), 'utf8'));
    const titles = new Set<string>((pkg.contributes.commands as { title: string }[]).map(c => c.title));
    // Everything at once, so every message and fix text is checked.
    const everything = facts({
      hostTools: {
        installed: true, complete: false, envFileExists: false, stampExists: false, missingParts: ['CMake'],
        zinstallerVersion: '1.0', zinstallerUpToDate: false, homebrewOk: false, developerToolsMissing: true,
        powershellPolicy: { current: 'Restricted', allowed: false },
      },
      settings: { envScript: '/x/env.sh', envScriptExists: false, venvSetting: '/x/venv', venvSettingOk: false, shellSubstitutedFrom: 'fish' },
      venv: { exists: true, version: '3.9.1', tooOld: true },
      west: { found: false },
      sdks: { count: 0, application: { toolchainVariant: 'iar', needsSdk: true, toolchainResolved: false, compat: { status: 'partial' } } },
      runners: [
        { runner: 'jlink', role: 'configured', toolIds: ['jlink'], toolNames: ['J-Link'], installed: false, updateAvailable: false },
        { runner: 'pyocd', role: 'default_debug', toolIds: ['pyocd'], toolNames: ['pyOCD'], installed: true, updateAvailable: true },
      ],
    });
    const problems = [
      ...deriveEnvironmentProblems(everything),
      ...deriveEnvironmentProblems(facts({ hostTools: { installed: false, complete: false } })),
      ...deriveEnvironmentProblems(facts({ settings: { envScript: undefined, envScriptExists: false } })),
      ...deriveEnvironmentProblems(facts({ venv: { path: undefined, exists: false }, west: { found: false } })),
      ...deriveEnvironmentProblems(facts({ venv: { source: 'application', exists: false }, west: { found: false } })),
      ...(['west_workspace', 'application', undefined] as const).flatMap(owner => deriveEnvironmentProblems(facts({
        venv: { path: '/ws/.venv', source: 'application', owner, exists: true, version: '3.9.1', tooOld: true }, west: { found: false },
      }))),
      ...deriveEnvironmentProblems(facts({ venv: { path: '/opt/v', source: 'setting', exists: true, version: '3.9.1', tooOld: true }, west: { found: false } })),
    ];
    assert.ok(problems.length >= 16);
    for (const problem of problems) {
      assert.ok(!problem.message.includes('—') && !problem.fix.includes('—'), `${problem.code} has an em-dash`);
      for (const [, name] of problem.fix.matchAll(/"([^"]+)"/g)) {
        assert.ok(titles.has(name), `${problem.code} names "${name}", which is not a command title`);
      }
    }
  });

  describe('summarizeQuickEnvironment (get_status)', () => {
    const healthy: QuickEnvironmentFacts = {
      hostToolsInstalled: true,
      hostToolsComplete: true,
      zinstallerUpToDate: true,
      envScriptOk: true,
      venvSettingOk: true,
      venvExists: true,
      westFound: true,
      sdkCount: 1,
    };

    it('is ready on a healthy machine and then asks for nothing', () => {
      const summary = summarizeQuickEnvironment(healthy);
      assert.deepEqual(summary.environment, {
        ready: true,
        host_tools_installed: true,
        host_tools_complete: true,
        env_script_ok: true,
        venv_ok: true,
        zinstaller_up_to_date: true,
      });
      assert.deepEqual(summary.nextSteps, []);
    });

    it('agrees with check_environment on readiness', () => {
      // The same machine through both rules, flag by flag.
      const cases: Array<[Partial<QuickEnvironmentFacts>, Overrides]> = [
        [{ hostToolsComplete: false }, { hostTools: { complete: false } }],
        [{ envScriptOk: false }, { settings: { envScriptExists: false } }],
        [{ venvSettingOk: false }, { settings: { venvSettingOk: false } }],
        [{ westFound: false }, { west: { found: false } }],
        [{ sdkCount: 0 }, { sdks: { count: 0 } }],
      ];
      for (const [quick, detailed] of cases) {
        assert.equal(summarizeQuickEnvironment({ ...healthy, ...quick }).environment.ready, isEnvironmentReady(facts(detailed)),
          `${Object.keys(quick)[0]} gives different answers`);
      }
    });

    it('agrees with check_environment on an application\'s toolchain', () => {
      // An Arm GNU application needs no Zephyr SDK; an unregistered toolchain blocks it whatever SDKs exist.
      const cases: Array<[string, number, { needsSdk: boolean; toolchainResolved: boolean }, boolean]> = [
        ['Arm GNU, no SDK', 0, { needsSdk: false, toolchainResolved: true }, true],
        ['Arm GNU not registered', 1, { needsSdk: false, toolchainResolved: false }, false],
        ['IAR not registered', 1, { needsSdk: true, toolchainResolved: false }, false],
        ['Zephyr SDK variant, no SDK', 0, { needsSdk: true, toolchainResolved: true }, false],
      ];
      for (const [label, count, application, ready] of cases) {
        const quick = summarizeQuickEnvironment({ ...healthy, sdkCount: count, application }).environment.ready;
        const detailed = isEnvironmentReady(facts({ sdks: { count, application: { toolchainVariant: 'x', ...application } } }));
        assert.equal(quick, detailed, `${label}: get_status and check_environment disagree`);
        assert.equal(quick, ready, label);
      }
    });

    it('asks for a Zephyr SDK only when one is needed', () => {
      assert.equal(isSdkMissing(0), true);
      assert.equal(isSdkMissing(0, { needsSdk: false, toolchainResolved: true }), false);
      assert.equal(isSdkMissing(0, { needsSdk: true, toolchainResolved: true }), true);
      assert.equal(isSdkMissing(1), false);
    });

    it('tells an unfinished install from a missing one and sends the agent to check_environment', () => {
      const unfinished = summarizeQuickEnvironment({ ...healthy, hostToolsComplete: false });
      assert.equal(unfinished.environment.ready, false);
      assert.equal(unfinished.environment.host_tools_installed, true);
      assert.equal(unfinished.environment.host_tools_complete, false);
      assert.match(unfinished.nextSteps[0], /did not finish.*"Install Host Tools" again/);
      assert.match(unfinished.nextSteps[1], /check_environment/);

      const missing = summarizeQuickEnvironment({ ...healthy, hostToolsInstalled: false, hostToolsComplete: false });
      assert.match(missing.nextSteps[0], /not installed/);
      assert.ok(!missing.nextSteps.some(step => /did not finish/.test(step)), 'one step for one cause');
    });

    it('needs the venv setting, the venv and west for venv_ok', () => {
      for (const broken of [{ venvSettingOk: false }, { venvExists: false }, { westFound: false }]) {
        assert.equal(summarizeQuickEnvironment({ ...healthy, ...broken }).environment.venv_ok, false, JSON.stringify(broken));
      }
    });

    it('reports an old zinstaller without blocking builds', () => {
      const summary = summarizeQuickEnvironment({ ...healthy, zinstallerUpToDate: false });
      assert.equal(summary.environment.zinstaller_up_to_date, false);
      assert.equal(summary.environment.ready, true);
    });
  });
});
