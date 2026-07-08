import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  parseNinjaMenuconfigCommand,
  readMenuconfigCommandFromNinja,
  tokenizeCommand,
  extractFromNinja,
  extractFromFallback,
  resolveInnerBuildDir,
  preflight,
  isExtractError,
} from '../../../utils/kconfig/kconfigEnvExtractor';

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'kconfig');

describe('kconfigEnvExtractor', () => {
  describe('tokenizeCommand', () => {
    it('splits on unquoted whitespace', () => {
      assert.deepEqual(tokenizeCommand('a b  c'), ['a', 'b', 'c']);
    });
    it('keeps double-quoted spans and strips the quotes', () => {
      assert.deepEqual(tokenizeCommand('KEY="a b" X'), ['KEY=a b', 'X']);
    });
    it('produces an empty-valued token for empty single quotes', () => {
      assert.deepEqual(tokenizeCommand("SHIELD_AS_LIST='' next"), ['SHIELD_AS_LIST=', 'next']);
    });
    it('treats && as its own token', () => {
      assert.deepEqual(tokenizeCommand('cd /a/b && cmake'), ['cd', '/a/b', '&&', 'cmake']);
    });
  });

  describe('parseNinjaMenuconfigCommand', () => {
    const base =
      'cd /w/build/zephyr/kconfig && /usr/bin/cmake -E env ' +
      'ZEPHYR_BASE=/z srctree=/z CONFIG_=CONFIG_ ' +
      'KCONFIG_CONFIG=/w/build/zephyr/.config BOARD=nrf52 ' +
      'APPVERSION= EDT_PICKLE=/w/build/zephyr/edt.pickle ' +
      "SHIELD_AS_LIST='' " +
      '/venv/bin/python /z/scripts/kconfig/menuconfig.py /z/Kconfig';

    it('extracts env, python, kconfigRoot and cwd', () => {
      const p = parseNinjaMenuconfigCommand(base);
      assert.ok(p);
      assert.equal(p!.cwd, '/w/build/zephyr/kconfig');
      assert.equal(p!.python, '/venv/bin/python');
      assert.equal(p!.script, '/z/scripts/kconfig/menuconfig.py');
      assert.equal(p!.kconfigRoot, '/z/Kconfig');
      assert.equal(p!.env.ZEPHYR_BASE, '/z');
      assert.equal(p!.env.srctree, '/z');
      assert.equal(p!.env.CONFIG_, 'CONFIG_');
      assert.equal(p!.env.KCONFIG_CONFIG, '/w/build/zephyr/.config');
      assert.equal(p!.env.BOARD, 'nrf52');
      assert.equal(p!.env.EDT_PICKLE, '/w/build/zephyr/edt.pickle');
    });

    it('preserves empty env values (APPVERSION=)', () => {
      const p = parseNinjaMenuconfigCommand(base);
      assert.ok('APPVERSION' in p!.env);
      assert.equal(p!.env.APPVERSION, '');
    });

    it('yields an empty SHIELD_AS_LIST for empty quotes', () => {
      const p = parseNinjaMenuconfigCommand(base);
      assert.equal(p!.env.SHIELD_AS_LIST, '');
    });

    it('unescapes escaped semicolons in SHIELD_AS_LIST', () => {
      const cmd = base.replace("SHIELD_AS_LIST=''", "SHIELD_AS_LIST='a\\;b\\;c'");
      const p = parseNinjaMenuconfigCommand(cmd);
      assert.equal(p!.env.SHIELD_AS_LIST, 'a;b;c');
    });

    it('handles the Windows `cd /D` prefix', () => {
      const cmd =
        'cd /D C:/w/build/zephyr/kconfig && C:/cmake.exe -E env ' +
        'ZEPHYR_BASE=C:/z srctree=C:/z CONFIG_=CONFIG_ KCONFIG_CONFIG=C:/w/build/zephyr/.config ' +
        'C:/venv/Scripts/python.exe C:/z/scripts/kconfig/menuconfig.py C:/z/Kconfig';
      const p = parseNinjaMenuconfigCommand(cmd);
      assert.ok(p);
      assert.equal(p!.cwd, 'C:/w/build/zephyr/kconfig');
      assert.equal(p!.python, 'C:/venv/Scripts/python.exe');
      assert.equal(p!.kconfigRoot, 'C:/z/Kconfig');
    });

    it('handles a quoted path containing spaces', () => {
      const cmd =
        'cd "/w space/build/zephyr/kconfig" && /usr/bin/cmake -E env ' +
        'ZEPHYR_BASE=/z srctree=/z CONFIG_=CONFIG_ KCONFIG_CONFIG="/w space/build/zephyr/.config" ' +
        '/venv/bin/python /z/scripts/kconfig/menuconfig.py /z/Kconfig';
      const p = parseNinjaMenuconfigCommand(cmd);
      assert.ok(p);
      assert.equal(p!.cwd, '/w space/build/zephyr/kconfig');
      assert.equal(p!.env.KCONFIG_CONFIG, '/w space/build/zephyr/.config');
    });

    it('ignores a PTY wrapper token before python', () => {
      const cmd = base.replace('/venv/bin/python', '/z/scripts/pty_wrapper.sh /venv/bin/python');
      const p = parseNinjaMenuconfigCommand(cmd);
      assert.ok(p);
      // python is anchored as the token right before the .py script.
      assert.equal(p!.python, '/venv/bin/python');
      assert.equal(p!.kconfigRoot, '/z/Kconfig');
    });

    it('returns undefined for a non-menuconfig-shaped command', () => {
      assert.equal(parseNinjaMenuconfigCommand('echo hello'), undefined);
    });
  });

  describe('readMenuconfigCommandFromNinja', () => {
    it('extracts the COMMAND from the real macOS fixture', () => {
      const ninja = fs.readFileSync(path.join(FIXTURE_DIR, 'menuconfig-command-macos.ninja.txt'), 'utf8');
      const cmd = readMenuconfigCommandFromNinja(ninja);
      assert.ok(cmd, 'should find a command');
      const p = parseNinjaMenuconfigCommand(cmd!);
      assert.ok(p, 'should parse');
      assert.equal(p!.env.BOARD, 'lp_mspm0l2228');
      assert.equal(p!.env.CONFIG_, 'CONFIG_');
      assert.equal(p!.env.SHIELD_AS_LIST, '');
      assert.equal(p!.env.APPVERSION, '');
      assert.ok(p!.env.ZEPHYR_BASE.endsWith('/deps/zephyr'));
      assert.ok(p!.env.KCONFIG_CONFIG.endsWith('/zephyr/.config'));
      assert.ok(p!.env.EDT_PICKLE.endsWith('/zephyr/edt.pickle'));
      assert.ok(p!.python.endsWith('/python'));
      assert.ok(p!.kconfigRoot.endsWith('/Kconfig'));
      assert.ok(p!.cwd.endsWith('/zephyr/kconfig'));
    });

    it('falls back to the guiconfig rule when menuconfig is absent', () => {
      const ninja = [
        'build guiconfig: phony CMakeFiles/guiconfig',
        'build CMakeFiles/guiconfig | x/CMakeFiles/guiconfig: CUSTOM_COMMAND',
        '  COMMAND = cd /w && /usr/bin/cmake -E env srctree=/z CONFIG_=CONFIG_ KCONFIG_CONFIG=/w/.config /py /z/scripts/kconfig/guiconfig.py /z/Kconfig',
        '  restat = 1',
      ].join('\n');
      const cmd = readMenuconfigCommandFromNinja(ninja);
      assert.ok(cmd);
      assert.ok(cmd!.includes('guiconfig.py'));
    });

    it('joins ninja line-continuations', () => {
      const ninja = [
        'build CMakeFiles/menuconfig | x: CUSTOM_COMMAND',
        '  COMMAND = cd /w && /cmake -E env srctree=/z $',
        '    CONFIG_=CONFIG_ KCONFIG_CONFIG=/w/.config /py /z/scripts/kconfig/menuconfig.py /z/Kconfig',
      ].join('\n');
      const cmd = readMenuconfigCommandFromNinja(ninja);
      assert.ok(cmd);
      const p = parseNinjaMenuconfigCommand(cmd!);
      assert.ok(p);
      assert.equal(p!.env.srctree, '/z');
      assert.equal(p!.env.CONFIG_, 'CONFIG_');
    });
  });

  describe('extractFromFallback', () => {
    let tmp: string;
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zwb-kcenv-')); });
    afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('reconstructs the env from CMakeCache + module env file', () => {
      const build = path.join(tmp, 'build', 'primary');
      fs.mkdirSync(path.join(build, 'Kconfig'), { recursive: true });
      fs.writeFileSync(path.join(build, 'CMakeCache.txt'),
        'ZEPHYR_BASE:PATH=/z\nAPPLICATION_SOURCE_DIR:PATH=/app\nCACHED_BOARD:STRING=nrf52\nWEST_PYTHON:FILEPATH=/venv/bin/python\n');
      fs.writeFileSync(path.join(build, 'Kconfig', 'kconfig_module_dirs.env'),
        'ZEPHYR_FOO_MODULE_DIR=/mods/foo\nZEPHYR_FOO_KCONFIG=/mods/foo/Kconfig\n');
      // build.ninja intentionally absent so the primary path is skipped.
      const spec = extractFromFallback(build, 'primary');
      assert.ok(!isExtractError(spec));
      if (isExtractError(spec)) { return; }
      assert.equal(spec.source, 'fallback');
      assert.equal(spec.zephyrBase, '/z');
      assert.equal(spec.env.CONFIG_, 'CONFIG_');
      assert.equal(spec.env.ARCH, '*');
      assert.equal(spec.env.BOARD, 'nrf52');
      assert.equal(spec.env.ZEPHYR_FOO_MODULE_DIR, '/mods/foo');
      assert.equal(spec.python, '/venv/bin/python');
      assert.ok(spec.configPath.endsWith(path.join('zephyr', '.config')));
      assert.ok(spec.kconfigRoot.endsWith('Kconfig'));
    });

    it('errors when CMakeCache is missing', () => {
      const build = path.join(tmp, 'empty');
      fs.mkdirSync(build, { recursive: true });
      const spec = extractFromFallback(build);
      assert.ok(isExtractError(spec));
    });
  });

  describe('resolveInnerBuildDir + preflight', () => {
    let tmp: string;
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zwb-kcpf-')); });
    afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('prefers the flat build.ninja layout', () => {
      const build = path.join(tmp, 'build', 'primary');
      fs.mkdirSync(build, { recursive: true });
      fs.writeFileSync(path.join(build, 'build.ninja'), 'x');
      assert.equal(resolveInnerBuildDir(build, 'myapp'), build);
    });

    it('resolves the nested sysbuild layout', () => {
      const build = path.join(tmp, 'build', 'primary');
      const nested = path.join(build, 'myapp');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, 'build.ninja'), 'x');
      assert.equal(resolveInnerBuildDir(build, 'myapp'), nested);
    });

    it('prefers the dir holding zephyr/.config over a top-level sysbuild build.ninja', () => {
      // sysbuild: the root has its own build.ninja, but the app config lives nested.
      const build = path.join(tmp, 'build', 'primary');
      const nested = path.join(build, 'myapp');
      fs.mkdirSync(path.join(nested, 'zephyr'), { recursive: true });
      fs.writeFileSync(path.join(build, 'build.ninja'), 'sysbuild-root');
      fs.writeFileSync(path.join(nested, 'zephyr', '.config'), 'x');
      assert.equal(resolveInnerBuildDir(build, 'myapp'), nested);
    });

    it('reports missing artifacts for an unconfigured build dir', () => {
      const build = path.join(tmp, 'build', 'primary');
      fs.mkdirSync(build, { recursive: true });
      const a = preflight(build, 'myapp');
      assert.equal(a.ready, false);
      assert.deepEqual(a.missing.sort(), ['.config', 'build.ninja', 'edt.pickle']);
    });

    it('is ready when all artifacts exist', () => {
      const build = path.join(tmp, 'build', 'primary');
      fs.mkdirSync(path.join(build, 'zephyr'), { recursive: true });
      fs.writeFileSync(path.join(build, 'build.ninja'), 'x');
      fs.writeFileSync(path.join(build, 'zephyr', '.config'), 'x');
      fs.writeFileSync(path.join(build, 'zephyr', 'edt.pickle'), 'x');
      const a = preflight(build, 'myapp');
      assert.equal(a.ready, true);
      assert.equal(a.missing.length, 0);
    });
  });

  describe('extractFromNinja (integration with fixture copied into a build tree)', () => {
    let tmp: string;
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zwb-kcninja-')); });
    afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('produces a ninja-sourced launch spec', () => {
      const build = path.join(tmp, 'build', 'primary');
      fs.mkdirSync(build, { recursive: true });
      const fixture = fs.readFileSync(path.join(FIXTURE_DIR, 'menuconfig-command-macos.ninja.txt'), 'utf8');
      fs.writeFileSync(path.join(build, 'build.ninja'), fixture);
      const spec = extractFromNinja(build, 'hello_world');
      assert.ok(!isExtractError(spec));
      if (isExtractError(spec)) { return; }
      assert.equal(spec.source, 'ninja');
      assert.equal(spec.env.BOARD, 'lp_mspm0l2228');
      assert.ok(spec.python.length > 0);
      assert.ok(spec.kconfigRoot.endsWith('Kconfig'));
    });
  });
});
