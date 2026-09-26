// The ECLAIR analysis preparation the ECLAIR Manager and the analyze tool
// share: the west build command line for each kind of SCA configuration, the
// files it writes and where, the analysis environment, and the read-only
// probe that finds ECLAIR. ECLAIR itself is licensed and never runs here.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildEclairAnalysisEnv, eclairAnalysisCommand, EclairPresetSources, eclairReportServerCommand, findEclairDatabaseIn,
  prepareEclairRun, probeEclair, writeEclairRunFiles,
} from '../../utils/eclair/analysis';
import type { EclairScaConfig } from '../../utils/eclair/config';
import type { EclairTemplate } from '../../utils/eclair/template';

const posixOnly = process.platform === 'win32' ? it.skip : it;

const noPresets: EclairPresetSources = {
  repos: {},
  resolveRepoRevs: async () => { throw new Error('no preset is used'); },
  loadPreset: async () => { throw new Error('no preset is used'); },
};

describe('ECLAIR analysis preparation', () => {
  let root: string;
  let tmp: string;
  const target = () => ({ appDir: path.join(root, 'app'), buildDir: path.join(root, 'app', 'build', 'primary'), board: 'nrf52840dk/nrf52840' });
  const saved: Record<string, string | undefined> = {};
  const setEnv = (key: string, value: string | undefined) => {
    if (!(key in saved)) {
      saved[key] = process.env[key];
    }
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zwb-eclair-')));
    tmp = path.join(root, 'run');
    fs.mkdirSync(tmp);
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
      delete saved[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  posixOnly('builds the command of a Zephyr ruleset, with the options file in the run folder', async () => {
    const config: EclairScaConfig = {
      name: 'STU', main_config: { type: 'zephyr-ruleset', ruleset: 'ECLAIR_RULESET_STU' }, reports: ['ECLAIR_REPORTS_SARIF', 'ECLAIR_SUMMARY_TXT'],
    };
    const t = target();
    const command = await eclairAnalysisCommand(config, t, noPresets, tmp);
    assert.equal(command, [
      'west build --pristine', `-s "${t.appDir}"`, `-d "${t.buildDir}"`, '--board=nrf52840dk/nrf52840', '--',
      '-DZEPHYR_SCA_VARIANT=eclair', '-UCMAKE_C_COMPILER_LAUNCHER', '-UCMAKE_CXX_COMPILER_LAUNCHER',
      '-DECLAIR_RULESET_STU=ON', '-DECLAIR_RULESET_FIRST_ANALYSIS=OFF',
      `-DECLAIR_OPTIONS_FILE=${path.join(tmp, 'eclair_wrapper.cmake')}`,
      '-DECLAIR_REPORTS_SARIF=ON', '-DECLAIR_SUMMARY_TXT=ON',
    ].join(' '));
    assert.equal(fs.readFileSync(path.join(tmp, 'eclair_wrapper.cmake'), 'utf8'), '');
  });

  posixOnly('writes to the system temporary folder, as the panel always did, when no run folder is given', async () => {
    setEnv('TMPDIR', tmp);
    const config: EclairScaConfig = { name: 'first', main_config: { type: 'zephyr-ruleset', ruleset: 'ECLAIR_RULESET_FIRST_ANALYSIS' } };
    const command = await eclairAnalysisCommand(config, target(), noPresets);
    assert.match(command, /-DECLAIR_RULESET_FIRST_ANALYSIS=ON -DECLAIR_OPTIONS_FILE=/);
    assert.ok(!command.includes('-DECLAIR_RULESET_FIRST_ANALYSIS=OFF'));
    assert.ok(command.endsWith(`-DECLAIR_OPTIONS_FILE=${path.join(os.tmpdir(), 'eclair_wrapper.cmake')}`));
    assert.ok(fs.existsSync(path.join(tmp, 'eclair_wrapper.cmake')));
  });

  posixOnly('passes a custom ECL file as the panel always has', async () => {
    const ecl = path.join(root, 'custom.ecl');
    fs.writeFileSync(ecl, '-doc="custom"\n');
    const config: EclairScaConfig = { name: 'mine', main_config: { type: 'custom-ecl', ecl_path: ecl }, extra_config: ecl };
    const command = await eclairAnalysisCommand(config, target(), noPresets, tmp);
    const rulesetDir = path.join(tmp, 'dummy_user_ruleset');
    // Today's command line, kept as it is: the ECL path is passed where a
    // ruleset option name goes, so no ECLAIR_RULESET_* ends up selected.
    assert.ok(command.includes(`-D${ecl}=ON -DECLAIR_RULESET_FIRST_ANALYSIS=OFF`));
    assert.equal(fs.readFileSync(path.join(rulesetDir, 'analysis_dummy.ecl'), 'utf8'),
      '-project_name=getenv("ZEPHYR_WORKBENCH_ECLAIR_PROJECT_NAME")\n-project_root=getenv("ZEPHYR_WORKBENCH_PROJECT_ROOT_DIR")');
    assert.equal(fs.readFileSync(path.join(tmp, 'eclair_wrapper.cmake'), 'utf8'),
      `list(APPEND ECLAIR_ENV_ADDITIONAL_OPTIONS "-eval_file=${ecl}")\nlist(APPEND ECLAIR_ENV_ADDITIONAL_OPTIONS "-eval_file=${ecl}")\n`);
  });

  posixOnly('loads presets at the revisions it is given, with their edited flags', async () => {
    const template: EclairTemplate = {
      title: 'MISRA', kind: 'ruleset', description: '', authors: [], provides: {}, requires: {}, deps: [],
      options: [{ id: 'strict-mode', variant: { kind: 'flag', default: false } }],
    };
    const asked: unknown[] = [];
    const config: EclairScaConfig = {
      name: 'misra',
      main_config: {
        type: 'preset',
        rulesets: [{ source: { type: 'repo-path', repo: 'BUGSENG presets', path: 'rulesets/misra.ecl' }, edited_flags: { 'strict-mode': true } }],
        variants: [], tailorings: [],
      },
    };
    const command = await eclairAnalysisCommand(config, target(), {
      repos: { 'BUGSENG presets': { origin: 'https://example.com/presets', ref: 'main' } },
      resolveRepoRevs: async repos => { asked.push(repos); return { 'BUGSENG presets': 'abc1234' }; },
      loadPreset: async (source, revs) => { asked.push([source, revs]); return { ok: [template, '/cache/abc1234/rulesets/misra.ecl'] }; },
    }, tmp);
    assert.equal(asked.length, 2);
    assert.deepEqual((asked[1] as unknown[])[1], { 'BUGSENG presets': 'abc1234' });
    assert.match(command, /-DECLAIR_RULESET_USER=ON/);
    const ruleset = fs.readFileSync(path.join(tmp, 'dummy_user_ruleset', 'analysis_dummy.ecl'), 'utf8').split('\n');
    assert.deepEqual(ruleset.slice(2), ['setq(strict_mode,1)', '-eval_file="/cache/abc1234/rulesets/misra.ecl"']);
  });

  it('fails when a preset cannot be loaded, naming it', async () => {
    const config: EclairScaConfig = {
      name: 'misra',
      main_config: { type: 'preset', rulesets: [{ source: { type: 'system-path', path: '/x.ecl' } }], variants: [], tailorings: [] },
    };
    await assert.rejects(eclairAnalysisCommand(config, target(), {
      repos: {}, resolveRepoRevs: async () => ({}), loadPreset: async () => ({ err: 'no such file' }),
    }, tmp), /Failed to load preset: Failed to load preset: no such file/);
  });

  it('builds the analysis environment: ECLAIR and the SDK on PATH, ccache off, the project named', async () => {
    const eclairDir = path.join(root, 'eclair', 'bin');
    const sdk = path.join(root, 'zephyr-sdk');
    fs.mkdirSync(eclairDir, { recursive: true });
    setEnv('ZEPHYR_SDK_INSTALL_DIR', undefined);
    const env = buildEclairAnalysisEnv({ projectRootDir: path.join(root, 'app'), scaConfigName: 'STU', buildDir: target().buildDir, eclairDir, sdkDir: sdk });
    assert.equal(env.CCACHE_DISABLE, '1');
    assert.equal(env.ZEPHYR_SDK_INSTALL_DIR, sdk);
    assert.equal(env.ZEPHYR_TOOLCHAIN_VARIANT, 'zephyr');
    const entries = env.PATH.split(path.delimiter);
    assert.deepEqual(entries.slice(0, 3), [path.join(sdk, 'arm-zephyr-eabi', 'bin'), path.join(sdk, 'cmake', 'bin'), eclairDir]);
    assert.equal(env.ZEPHYR_WORKBENCH_ECLAIR_PROJECT_NAME, 'app (STU)');
    assert.equal(env.ZEPHYR_WORKBENCH_PROJECT_ROOT_DIR, path.join(root, 'app'));
  });

  it('prepares a run in the west workspace', async () => {
    const plan = await prepareEclairRun({
      config: { name: 'WP', main_config: { type: 'zephyr-ruleset', ruleset: 'ECLAIR_RULESET_WP' } },
      target: { ...target(), westTopDir: path.join(root, 'ws') },
      projectRootDir: path.join(root, 'app'),
      presets: noPresets,
      tmpDir: tmp,
    });
    assert.equal(plan.cwd, path.join(root, 'ws'));
    assert.match(plan.command, /-DECLAIR_RULESET_WP=ON/);
    assert.equal(plan.env.ZEPHYR_WORKBENCH_ECLAIR_PROJECT_NAME, 'app (WP)');
  });

  it('prepares a run without writing its files, which are written only when asked', async () => {
    const ecl = path.join(root, 'custom.ecl');
    fs.writeFileSync(ecl, '');
    // Left by an earlier analysis of the build, whose CMake cache still names them.
    const rulesetDir = path.join(tmp, 'dummy_user_ruleset');
    fs.mkdirSync(rulesetDir);
    fs.writeFileSync(path.join(tmp, 'eclair_wrapper.cmake'), 'earlier\n');
    fs.writeFileSync(path.join(rulesetDir, 'analysis_dummy.ecl'), 'earlier\n');
    const plan = await prepareEclairRun({
      config: { name: 'mine', main_config: { type: 'custom-ecl', ecl_path: ecl }, extra_config: ecl },
      target: { ...target(), westTopDir: path.join(root, 'ws') },
      projectRootDir: path.join(root, 'app'),
      presets: noPresets,
      tmpDir: tmp,
    });
    assert.deepEqual(plan.files.map(file => file.path), [path.join(rulesetDir, 'analysis_dummy.ecl'), path.join(tmp, 'eclair_wrapper.cmake')]);
    assert.equal(fs.readFileSync(path.join(tmp, 'eclair_wrapper.cmake'), 'utf8'), 'earlier\n');
    assert.equal(fs.readFileSync(path.join(rulesetDir, 'analysis_dummy.ecl'), 'utf8'), 'earlier\n');

    writeEclairRunFiles(plan.files);
    assert.equal(fs.readFileSync(path.join(tmp, 'eclair_wrapper.cmake'), 'utf8'), plan.files[1].content);
    assert.match(fs.readFileSync(path.join(rulesetDir, 'analysis_dummy.ecl'), 'utf8'), /^-project_name=/);
  });

  it('finds the database and builds the report server command', () => {
    const buildDir = target().buildDir;
    assert.equal(findEclairDatabaseIn(buildDir), undefined);
    fs.mkdirSync(path.join(buildDir, 'sca', 'eclair'), { recursive: true });
    fs.writeFileSync(path.join(buildDir, 'sca', 'eclair', 'PROJECT.ecd'), '');
    const db = findEclairDatabaseIn(buildDir) as string;
    assert.equal(db, path.join(buildDir, 'sca', 'eclair', 'PROJECT.ecd'));
    const program = process.platform === 'win32' ? 'eclair_report.exe' : 'eclair_report';
    assert.equal(eclairReportServerCommand('/opt/eclair/bin', db), `"${path.join('/opt/eclair/bin', program)}" -db="${db}" -browser -server=restart`);
    assert.equal(eclairReportServerCommand(undefined, db), `"eclair_report" -db="${db}" -browser -server=restart`);
  });

  describe('probe', () => {
    const exe = (dir: string, name: string) => {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
      fs.writeFileSync(file, '#!/bin/sh\n');
      fs.chmodSync(file, 0o755);
    };
    const envYml = (text: string) => {
      fs.mkdirSync(path.join(root, '.zinstaller'), { recursive: true });
      fs.writeFileSync(path.join(root, '.zinstaller', 'env.yml'), text);
    };

    beforeEach(() => {
      setEnv('VSCODE_PORTABLE', root);
      setEnv('PATH', path.join(root, 'empty-path'));
    });

    it('finds nothing when ECLAIR is not installed, and writes nothing', () => {
      const probe = probeEclair();
      assert.deepEqual(probe, { dir: undefined, source: undefined, eclairEnv: undefined, eclairReport: undefined, envYmlHasPath: false });
      assert.ok(!fs.existsSync(path.join(root, '.zinstaller', 'env.yml')));
    });

    it('finds the folder env.yml records, with its companion programs', () => {
      const dir = path.join(root, 'eclair', 'bin');
      exe(dir, 'eclair');
      exe(dir, 'eclair_env');
      envYml(`other:\n  EXTRA_TOOLS:\n    path:\n      - ${dir}\n`);
      const before = fs.readFileSync(path.join(root, '.zinstaller', 'env.yml'), 'utf8');
      const probe = probeEclair();
      assert.equal(probe.dir, dir);
      assert.equal(probe.source, 'env_yml');
      assert.ok(probe.eclairEnv);
      assert.equal(probe.eclairReport, undefined);
      assert.equal(probe.envYmlHasPath, true);
      assert.equal(fs.readFileSync(path.join(root, '.zinstaller', 'env.yml'), 'utf8'), before);
    });

    posixOnly('finds ECLAIR on PATH and says env.yml does not record it yet', () => {
      const dir = path.join(root, 'eclair-on-path');
      exe(dir, 'eclair');
      exe(dir, 'eclair_env');
      exe(dir, 'eclair_report');
      setEnv('PATH', `${dir}${path.delimiter}/usr/bin${path.delimiter}/bin`);
      envYml('other:\n  EXTRA_TOOLS:\n    path: []\n');
      const probe = probeEclair();
      assert.equal(probe.dir, dir);
      assert.equal(probe.source, 'path');
      assert.equal(probe.envYmlHasPath, false);
      assert.ok(probe.eclairReport);
    });
  });
});
