// The building blocks manage_runners shares with the Install Runners panel:
// the manifest rules (packs, tools only a vendor ships, licenses, which paths
// the user may set), the installer command line for each way it is run, the
// env.yml writers, and the headless pyOCD target install.

import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'yaml';
import {
  expandDebugToolPack, getDebugToolLicense, getDebugToolPacks, isDebugToolDetectOnly, isDebugToolPathEditable, ManifestDebugTool,
} from '../../utils/debugTools/debugToolManifestUtils';
import type { DebugToolsManifest } from '../../utils/debugTools/debugToolVersionUtils';
import { removeRunnerPath, saveDoNotUse, saveRunnerPath } from '../../utils/debugTools/debugToolEnvUtils';
import { installPyOCDTargetSupport, PyOCDTargetOps } from '../../utils/debugTools/pyocdTargetSetup';
import { getExtraPaths, setExtraPaths } from '../../utils/env/envYamlUtils';
import { buildDebugToolsInstallCommand, planHostDebugToolsInstall, runPanelDebugToolsInstall } from '../../utils/installUtils';

const SHIPPED: DebugToolsManifest = yaml.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../scripts/runners/debug-tools.yml'), 'utf8'));

const toolOf = (id: string) => (SHIPPED.debug_tools as ManifestDebugTool[]).find(tool => tool.tool === id)!;

describe('runner tools install and settings', () => {
  describe('manifest rules, on the shipped manifest', () => {
    it('knows which tools only their vendor ships', () => {
      for (const id of ['stm32cubeprogrammer', 'stm32cubeclt', 'linkserver', 'openocd-custom']) {
        assert.equal(isDebugToolDetectOnly(toolOf(id)), true, `${id} is detect-only`);
      }
      for (const id of ['jlink', 'openocd-zephyr', 'pyocd', 'cp210x', 'udev-rules', 'nrfjprog']) {
        assert.equal(isDebugToolDetectOnly(toolOf(id)), false, `${id} installs somewhere`);
      }
    });

    it('marks J-Link, and only J-Link, as accepting a license for the user', () => {
      assert.deepEqual(getDebugToolLicense(toolOf('jlink')), { name: 'SEGGER J-Link terms of use', url: 'https://www.segger.com/downloads/jlink/' });
      for (const tool of SHIPPED.debug_tools as ManifestDebugTool[]) {
        if (tool.tool !== 'jlink') {
          assert.equal(getDebugToolLicense(tool), undefined, tool.tool);
        }
      }
    });

    it('lets the user set the path of an alias and of a plain tool, not of a variant or a no_edit tool', () => {
      assert.equal(isDebugToolPathEditable(SHIPPED, 'openocd'), true);
      assert.equal(isDebugToolPathEditable(SHIPPED, 'jlink'), true);
      assert.equal(isDebugToolPathEditable(SHIPPED, 'openocd-zephyr'), false, 'a variant shares the path of its alias');
      assert.equal(isDebugToolPathEditable(SHIPPED, 'pyocd'), false, 'no_edit');
      assert.equal(isDebugToolPathEditable(SHIPPED, 'stm32cubeclt'), false, 'no_edit');
      assert.equal(isDebugToolPathEditable(SHIPPED, 'nope'), false);
    });

    it('expands a pack as the panel does: installable tools, vendor pages, and the rest skipped', () => {
      assert.ok(getDebugToolPacks(SHIPPED).some(pack => pack.pack === 'stm32'));
      const windows = expandDebugToolPack(SHIPPED, 'stm32', 'win32')!;
      assert.deepEqual(windows.install.map(tool => tool.tool), ['openocd-zephyr', 'jlink']);
      assert.deepEqual(windows.vendorPages.map(tool => tool.tool), ['stm32cubeclt']);
      assert.deepEqual(windows.skipped, ['udev-rules'], 'udev-rules is Linux only and has no website');
      const linux = expandDebugToolPack(SHIPPED, 'stm32', 'linux')!;
      assert.deepEqual(linux.install.map(tool => tool.tool), ['openocd-zephyr', 'jlink', 'udev-rules']);
      const esp32 = expandDebugToolPack(SHIPPED, 'esp32', 'linux')!;
      assert.deepEqual(esp32.vendorPages.map(tool => tool.tool), ['cp210x'], 'a Windows driver is a vendor page elsewhere');
      assert.equal(expandDebugToolPack(SHIPPED, 'nope'), undefined);
    });
  });

  describe('the install command line', () => {
    const scripts = path.join('C:', 'ext dir', 'scripts', 'runners');

    it('keeps the escaped quotes of a ShellExecution on Windows, and plain quotes for a spawned process', () => {
      const task = buildDebugToolsInstallCommand(scripts, ['openocd-zephyr', 'jlink'], { platform: 'win32', destDir: 'C:\\Users\\me', quoting: 'shell-execution' })!;
      assert.equal(task.shell, 'powershell.exe');
      assert.equal(task.command, `powershell -File \\"${path.join(scripts, 'install-debug-tools.ps1')}\\"  -D \\"C:\\Users\\me\\" -Tools  openocd-zephyr,jlink`);
      const spawned = buildDebugToolsInstallCommand(scripts, ['openocd-zephyr', 'jlink'], { platform: 'win32', destDir: 'C:\\Users\\me', quoting: 'argv' })!;
      assert.equal(spawned.command, `powershell -File "${path.join(scripts, 'install-debug-tools.ps1')}"  -D "C:\\Users\\me" -Tools  openocd-zephyr,jlink`);
    });

    it('separates the tools with spaces on Linux and macOS, quoting a path with spaces only for a spawned process', () => {
      const linux = buildDebugToolsInstallCommand('/opt/ext/scripts/runners', ['nrfutil', 'pyocd'], { platform: 'linux', destDir: '/home/me' })!;
      assert.match(linux.command, /^bash [\\/]opt[\\/]ext[\\/]scripts[\\/]runners[\\/]install-debug-tools\.sh {2}-D \/home\/me nrfutil pyocd$/);
      assert.equal(linux.shell, 'bash');
      const mac = buildDebugToolsInstallCommand('/Apps/My Ext/runners', ['jlink'], { platform: 'darwin', destDir: '/Users/me', quoting: 'argv' })!;
      assert.match(mac.command, /^bash "[\\/]Apps[\\/]My Ext[\\/]runners[\\/]install-debug-tools-mac\.sh" {2}-D \/Users\/me jlink$/);
      const bare = buildDebugToolsInstallCommand('/Apps/My Ext/runners', ['jlink'], { platform: 'darwin', destDir: '/Users/me' })!;
      assert.match(bare.command, /^bash [\\/]Apps[\\/]My Ext/, 'the ShellExecution form stays as the panel always ran it');
      assert.equal(buildDebugToolsInstallCommand(scripts, ['jlink'], { platform: 'aix' }), undefined);
    });

    it('splits the root tools off on Linux and macOS, and keeps one PowerShell command on Windows', () => {
      const root = new Set(['jlink', 'udev-rules']);
      const linux = planHostDebugToolsInstall('/ext/runners', ['nrfutil', 'jlink', 'udev-rules'], root, { platform: 'linux', destDir: '/home/me' })!;
      assert.deepEqual(linux.root?.toolIds, ['jlink', 'udev-rules']);
      assert.match(linux.root!.command, / jlink udev-rules$/);
      assert.deepEqual(linux.nonRoot?.toolIds, ['nrfutil']);
      assert.equal(linux.nonRoot?.executableOverride, undefined);
      const onlyRoot = planHostDebugToolsInstall('/ext/runners', ['jlink'], root, { platform: 'darwin', destDir: '/Users/me' })!;
      assert.equal(onlyRoot.nonRoot, undefined);
      const windows = planHostDebugToolsInstall('C:\\ext\\runners', ['nrfutil', 'jlink'], root, { platform: 'win32', destDir: 'C:\\Users\\me', quoting: 'argv' })!;
      assert.equal(windows.root, undefined, 'the Windows installers raise UAC themselves');
      assert.deepEqual(windows.nonRoot?.toolIds, ['nrfutil', 'jlink']);
      assert.equal(windows.nonRoot?.executableOverride, 'powershell.exe');
      assert.deepEqual(windows.nonRoot?.shellOpts.shellArgs, ['-Command']);
      assert.equal(planHostDebugToolsInstall('/x', ['jlink'], root, { platform: 'aix' }), undefined);
    });
  });

  describe('env.yml writers', () => {
    let root: string;
    let saved: string | undefined;
    const envFile = () => path.join(root, '.zinstaller', 'env.yml');
    const envData = () => yaml.parse(fs.readFileSync(envFile(), 'utf8'));

    beforeEach(() => {
      saved = process.env.VSCODE_PORTABLE;
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-runner-env-'));
      process.env.VSCODE_PORTABLE = root;
      fs.mkdirSync(path.join(root, '.zinstaller'), { recursive: true });
      fs.writeFileSync(envFile(), yaml.stringify({ global: { version: 1 }, runners: { jlink: { version: '9.54' } } }));
    });

    afterEach(() => {
      if (saved === undefined) {
        delete process.env.VSCODE_PORTABLE;
      } else {
        process.env.VSCODE_PORTABLE = saved;
      }
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('records a path with forward slashes and keeps the rest of the entry', () => {
      assert.equal(saveRunnerPath('jlink', 'C:\\Program Files\\SEGGER\\JLink'), true);
      assert.deepEqual(envData().runners.jlink, { version: '9.54', path: 'C:/Program Files/SEGGER/JLink' });
      assert.deepEqual(envData().global, { version: 1 });
    });

    it('stores do_not_use, and forgets the whole entry when the path is cleared', () => {
      assert.equal(saveDoNotUse('nrfutil', true), true);
      assert.deepEqual(envData().runners.nrfutil, { do_not_use: true });
      assert.equal(removeRunnerPath('jlink'), true);
      assert.equal(removeRunnerPath('nrfutil'), true);
      assert.equal(envData().runners, undefined, 'an empty runners map is dropped');
    });

    it('replaces the extra runner folders in one write, and drops the list when it empties', () => {
      setExtraPaths('EXTRA_RUNNERS', ['C:\\tools\\a ', '', '/opt/b']);
      assert.deepEqual(getExtraPaths('EXTRA_RUNNERS'), ['C:/tools/a', '/opt/b']);
      setExtraPaths('EXTRA_RUNNERS', []);
      assert.deepEqual(getExtraPaths('EXTRA_RUNNERS'), []);
      assert.equal(envData().other, undefined);
    });
  });

  describe('installPyOCDTargetSupport', () => {
    function ops(script: { available: boolean[]; packs: string[][] }) {
      const calls: string[] = [];
      const shown: Array<boolean | undefined> = [];
      const fake: PyOCDTargetOps = {
        checkTarget: async (name, venv) => { calls.push(`check ${name} ${venv ?? ''}`.trim()); return script.available.shift() ?? false; },
        dryRunInstall: async (pattern, opts) => { calls.push(`dry ${pattern}`); shown.push(opts.show); return script.packs.shift() ?? []; },
        updateIndex: async opts => { calls.push('update'); shown.push(opts.show); return ''; },
        install: async (name, opts) => { calls.push(`install ${name}`); shown.push(opts.show); return ''; },
      };
      return { fake, calls, shown };
    }

    it('does nothing when pyOCD already knows the target', async () => {
      const { fake, calls } = ops({ available: [true], packs: [] });
      const result = await installPyOCDTargetSupport('stm32f429zitx', { venvPath: '/venv' }, fake);
      assert.deepEqual(result, { target: 'stm32f429zitx', alreadyAvailable: true, packs: [], indexUpdated: false, available: true });
      assert.deepEqual(calls, ['check stm32f429zitx /venv']);
    });

    it('resolves the pack with a dry run, installs it and checks again, never revealing the output channel', async () => {
      const { fake, calls, shown } = ops({ available: [false, true], packs: [['Keil.STM32F4xx_DFP.2.17.1']] });
      const result = await installPyOCDTargetSupport('stm32f429zitx', {}, fake);
      assert.equal(result.available, true);
      assert.deepEqual(result.packs, ['Keil.STM32F4xx_DFP.2.17.1']);
      assert.deepEqual(calls, ['check stm32f429zitx', 'dry stm32f429zitx', 'install stm32f429zitx', 'check stm32f429zitx']);
      assert.ok(shown.every(value => value === false));
    });

    it('refreshes a stale index once, and reports a target no pack provides', async () => {
      const { fake, calls } = ops({ available: [false], packs: [[], []] });
      const result = await installPyOCDTargetSupport('nosuchchip', {}, fake);
      assert.deepEqual(result, { target: 'nosuchchip', alreadyAvailable: false, packs: [], indexUpdated: true, available: false });
      assert.deepEqual(calls, ['check nosuchchip', 'dry nosuchchip', 'update', 'dry nosuchchip']);
    });
  });

  describe('an install batch of the Install Runners panel', () => {
    function batch(install: () => Promise<void>, refresh: () => Promise<void> = async () => undefined) {
      const events: string[] = [];
      const deps = {
        install: async () => { events.push('install'); await install(); },
        refresh: async (_context: unknown, ids: readonly string[]) => { events.push(`refresh ${ids.join(',')}`); await refresh(); },
        reportError: (title: string) => { events.push(`error ${title}`); },
      };
      const post = (message: Record<string, string>) => events.push(`${message.command}${message.tool ? ` ${message.tool}` : ''}`);
      return { events, run: () => runPanelDebugToolsInstall({} as never, [{ tool: 'openocd-zephyr' }, { tool: 'jlink' }], post, deps as never) };
    }

    it('records what did install when a later tool of the pack fails, then ends the batch', async () => {
      const { events, run } = batch(async () => { throw new Error('Installing the runners failed (exit code 1)'); });
      await run();
      assert.deepEqual(events, [
        'install', 'error Debug tools installation failed', 'refresh openocd-zephyr,jlink',
        'exec-done openocd-zephyr', 'exec-done jlink', 'exec-install-finished',
      ]);
    });

    it('refreshes then ends the batch after a clean install, reporting nothing', async () => {
      const { events, run } = batch(async () => undefined);
      await run();
      assert.deepEqual(events, ['install', 'refresh openocd-zephyr,jlink', 'exec-done openocd-zephyr', 'exec-done jlink', 'exec-install-finished']);
    });

    it('still ends the batch when the refresh fails', async () => {
      const { events, run } = batch(async () => undefined, async () => { throw new Error('env.yml is locked'); });
      await run();
      assert.deepEqual(events, ['install', 'refresh openocd-zephyr,jlink', 'exec-done openocd-zephyr', 'exec-done jlink', 'exec-install-finished']);
    });
  });
});
