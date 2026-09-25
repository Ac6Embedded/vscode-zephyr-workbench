// createApplication and the wizard helpers it shares with the Add Application
// wizard, run against real folders and a VS Code window whose settings live
// in each folder's .vscode/settings.json.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ZephyrSdkInstallation } from '../../models/ToolchainInstallations';
import { WestWorkspace } from '../../models/WestWorkspace';
import { ZephyrBoard } from '../../models/ZephyrBoard';
import { collectSettingsWarnings } from '../../providers/ZephyrTaskProvider';
import {
  ApplicationCreationError, createApplication, debugPresetContent, findCreateParameterError, workspaceApplicationParentPath,
} from '../../utils/zephyr/applicationCreation';
import { useUiGuard } from './mcp/uiGuard';
import {
  FakeUri, FakeWindow, installFakeWindow, makeApplicationFolder, makeSdk, makeWestWorkspace, readSettingsFile, tempDir, writeFile,
} from './appTestWorkspace';

const COMPLETE = {
  westWorkspaceRootPath: 'file:///ws',
  toolchainInstallationPath: '/sdk',
  projectName: 'blinky',
  appLocationType: 'freestanding',
  applicationsSubfolder: '',
  boardYamlPath: '/ws/zephyr/boards/b/board.yml',
  boardIdentifier: '',
  samplePath: '/ws/zephyr/samples/blinky',
};

describe('applicationCreation', () => {
  describe('findCreateParameterError', () => {
    it('reports the first problem with the texts the wizard shows', () => {
      assert.equal(findCreateParameterError(COMPLETE, '/apps'), undefined);
      assert.equal(findCreateParameterError({ ...COMPLETE, westWorkspaceRootPath: '' }, '/apps'), 'Missing west workspace, please select a west workspace');
      assert.match(findCreateParameterError({ ...COMPLETE, toolchainInstallationPath: '' }, '/apps')!, /^Missing toolchain/);
      assert.equal(findCreateParameterError({ ...COMPLETE, projectName: '' }, '/apps'), 'The project name is empty or invalid');
      assert.equal(findCreateParameterError({ ...COMPLETE, projectName: 'my app' }, '/apps'), 'The project name cannot contain spaces.');
      assert.equal(findCreateParameterError({ ...COMPLETE, appLocationType: 'workspace', applicationsSubfolder: 'my apps' }, '/apps'),
        'The applications subfolder cannot contain spaces.');
      assert.equal(findCreateParameterError(COMPLETE, '/my apps'), 'The project location cannot contain spaces.');
      assert.equal(findCreateParameterError({ ...COMPLETE, boardYamlPath: '', boardIdentifier: '' }, '/apps'), 'Missing target board');
      assert.equal(findCreateParameterError({ ...COMPLETE, boardYamlPath: '', boardIdentifier: 'custom_board' }, '/apps'), undefined);
      assert.match(findCreateParameterError({ ...COMPLETE, samplePath: '' }, '/apps')!, /^Missing selected sample or test app/);
    });

    it('checks the subfolder only for a workspace application', () => {
      assert.equal(findCreateParameterError({ ...COMPLETE, applicationsSubfolder: 'my apps' }, '/apps'), undefined);
    });
  });

  it('puts a workspace application under the applications subfolder, ignoring outer separators', () => {
    assert.equal(workspaceApplicationParentPath('/ws', '/applications/'), path.join('/ws', 'applications'));
    assert.equal(workspaceApplicationParentPath('/ws', '  '), '/ws');
    assert.equal(workspaceApplicationParentPath('/ws', 'a/b'), path.join('/ws', 'a/b'));
  });

  it('adds the debug preset once and drops the placeholder comment', async () => {
    const dir = tempDir('zw-preset-');
    writeFile(path.join(dir, 'prj.conf'), '# nothing here\nCONFIG_GPIO=y');
    await debugPresetContent(dir);
    await debugPresetContent(dir);
    const text = fs.readFileSync(path.join(dir, 'prj.conf'), 'utf8');
    assert.equal(text.match(/CONFIG_DEBUG_OPTIMIZATIONS=y/g)?.length, 1);
    assert.ok(!/nothing here/.test(text));
    assert.match(text, /^CONFIG_GPIO=y\n\n# Added automatically by Workbench for Zephyr/);
  });

  describe('createApplication', () => {
    useUiGuard();

    let window: FakeWindow;
    let root: string;
    let wsRoot: string;
    let sdkRoot: string;
    let sample: string;
    let board: ZephyrBoard;

    beforeEach(() => {
      root = tempDir('zw-create-');
      wsRoot = makeWestWorkspace(path.join(root, 'ws'));
      sample = path.join(wsRoot, 'zephyr', 'samples', 'hello_world');
      writeFile(path.join(sample, '.vscode', 'settings.json'), '{"left": "behind"}');
      writeFile(path.join(sample, 'build', 'CMakeCache.txt'));
      sdkRoot = makeSdk(path.join(root, 'zephyr-sdk-0.17.0'), '0.17.0');
      const boardDir = path.join(wsRoot, 'zephyr', 'boards', 'nordic', 'nrf52840dk');
      writeFile(path.join(boardDir, 'nrf52840dk_nrf52840.yaml'), 'identifier: nrf52840dk\narch: arm\n');
      window = installFakeWindow();
      board = new ZephyrBoard(FakeUri.file(boardDir) as never, 'nrf52840dk/nrf52840');
    });
    afterEach(() => window.restore());

    const workspace = () => new WestWorkspace('ws', FakeUri.file(wsRoot) as never);
    const sdk = () => new ZephyrSdkInstallation(FakeUri.file(sdkRoot) as never);

    it('copies the template into a freestanding folder with its own settings, without adding it to the window', async () => {
      const parent = path.join(root, 'apps');
      fs.mkdirSync(parent);
      const created = await createApplication({
        westWorkspace: workspace(), templatePath: sample, board, toolchain: sdk(), kind: 'freestanding',
        parentDir: parent, name: 'blinky', toolchainVariant: 'zephyr', settingsPathMode: 'relative',
        intellisenseProvider: 'cpptools', debugPreset: true,
      });
      const app = path.join(parent, 'blinky');
      assert.equal(created.appRoot, app);
      assert.equal(created.kind, 'freestanding');
      assert.equal(created.settingsFolder.uri.fsPath, app);
      assert.deepEqual(window.folders, [], 'the folder is added by the caller');
      assert.ok(fs.existsSync(path.join(app, 'src', 'main.c')));
      assert.ok(!fs.existsSync(path.join(app, 'build')), 'the template build folder is not copied');
      assert.ok(!fs.existsSync(path.join(app, 'sample.yaml')), 'the template metadata is not copied');
      assert.match(fs.readFileSync(path.join(app, 'prj.conf'), 'utf8'), /CONFIG_DEBUG_OPTIMIZATIONS=y/);

      const settings = readSettingsFile(app);
      assert.equal(settings['left'], undefined, 'the template settings are not copied');
      assert.equal(settings['zephyr-workbench.westWorkspace'], '${workspaceFolder}/../../ws');
      assert.equal(settings['zephyr-workbench.sdk'], '${workspaceFolder}/../../zephyr-sdk-0.17.0');
      assert.equal(settings['zephyr-workbench.toolchain'], 'zephyr');
      assert.equal(settings['zephyr-workbench.intellisense.provider'], 'cpptools');
      assert.deepEqual(settings['zephyr-workbench.build.configurations'], [{ name: 'primary', board: 'nrf52840dk/nrf52840', active: 'true' }]);
      assert.equal(settings['cmake.configureOnOpen'], false);
      const cpp = JSON.parse(fs.readFileSync(path.join(app, '.vscode', 'c_cpp_properties.json'), 'utf8'));
      assert.match(cpp.configurations[0].compilerPath, /arm-zephyr-eabi-gcc/);
    });

    it('declares a workspace application in the settings of its open west workspace', async () => {
      window.folders.push(wsRoot);
      const created = await createApplication({
        westWorkspace: workspace(), templatePath: sample, board, toolchain: sdk(), kind: 'workspace',
        parentDir: workspaceApplicationParentPath(wsRoot, 'applications'), name: 'hello', settingsPathMode: 'relative',
        intellisenseProvider: 'cpptools', debugPreset: false,
      });
      const app = path.join(wsRoot, 'applications', 'hello');
      assert.equal(created.appRoot, app);
      assert.equal(created.settingsFolder.uri.fsPath, wsRoot);
      assert.ok(!fs.existsSync(path.join(app, '.vscode')), 'a workspace application has no settings of its own');
      assert.doesNotMatch(fs.readFileSync(path.join(app, 'prj.conf'), 'utf8'), /DEBUG PRESET/);
      const entries = readSettingsFile(wsRoot)['zephyr-workbench.westWorkspace.applications'];
      assert.equal(entries.length, 1);
      assert.equal(entries[0].path, 'applications/hello');
      assert.equal(entries[0].sdk, '${workspaceFolder}/../zephyr-sdk-0.17.0');
      assert.deepEqual(entries[0]['build.configurations'], [{ name: 'primary', board: 'nrf52840dk/nrf52840', active: 'true' }]);
      assert.ok(fs.existsSync(path.join(wsRoot, '.vscode', 'c_cpp_properties.json')));
    });

    it('refuses a destination that exists, with the wizard text, and copies nothing', async () => {
      const parent = path.join(root, 'apps');
      makeApplicationFolder(path.join(parent, 'blinky'), 'CONFIG_MINE=y\n');
      await assert.rejects(createApplication({
        westWorkspace: workspace(), templatePath: sample, board, toolchain: sdk(), kind: 'freestanding', parentDir: parent, name: 'blinky',
      }), (error: unknown) => error instanceof ApplicationCreationError && error.code === 'destination-exists'
        && error.message === `The folder [${path.join(parent, 'blinky')}] already exists. Please change the project name or its location.`);
      assert.equal(fs.readFileSync(path.join(parent, 'blinky', 'prj.conf'), 'utf8'), 'CONFIG_MINE=y\n');
    });

    it('refuses a workspace application while its west workspace is not open, as the command does after copying', async () => {
      await assert.rejects(createApplication({
        westWorkspace: workspace(), templatePath: sample, board, toolchain: sdk(), kind: 'workspace',
        parentDir: path.join(wsRoot, 'applications'), name: 'hello',
      }), (error: unknown) => error instanceof ApplicationCreationError && error.code === 'workspace-not-open'
        && error.message === 'The selected west workspace is not open in VS Code.');
    });

    it('runs the venv step between copying and the settings, and stores what it returns', async () => {
      window.folders.push(wsRoot);
      const calls: Array<Array<string | boolean | undefined>> = [];
      await createApplication({
        westWorkspace: workspace(), templatePath: sample, board, toolchain: sdk(), kind: 'workspace',
        parentDir: path.join(wsRoot, 'applications'), name: 'hello',
        createVenv: async (folder, westRoot, appRoot) => {
          calls.push([folder.uri.fsPath, westRoot, appRoot, fs.existsSync(path.join(appRoot!, 'prj.conf'))]);
          return path.join(appRoot!, '.venv');
        },
      });
      assert.deepEqual([...calls], [[wsRoot, wsRoot, path.join(wsRoot, 'applications', 'hello'), true]]);
      const entry = readSettingsFile(wsRoot)['zephyr-workbench.westWorkspace.applications'][0];
      assert.equal(entry['venv.path'], '${workspaceFolder}/applications/hello/.venv');

      const parent = path.join(root, 'apps');
      fs.mkdirSync(parent);
      await createApplication({
        westWorkspace: workspace(), templatePath: sample, board, toolchain: sdk(), kind: 'freestanding', parentDir: parent, name: 'solo',
        createVenv: async (folder, westRoot, appRoot) => {
          calls.push([folder.uri.fsPath, westRoot, appRoot]);
          return undefined;
        },
      });
      assert.deepEqual(calls[1], [path.join(parent, 'solo'), wsRoot, undefined], 'a freestanding venv goes in its own settings folder');
    });

    it('collects the settings writers\' warnings instead of showing them', async () => {
      window.folders.push(wsRoot);
      writeFile(path.join(wsRoot, '.vscode', 'c_cpp_properties.json'), '{ not json');
      const warnings: string[] = [];
      await collectSettingsWarnings(warnings, () => createApplication({
        westWorkspace: workspace(), templatePath: sample, board, toolchain: sdk(), kind: 'workspace',
        parentDir: path.join(wsRoot, 'applications'), name: 'hello',
      }));
      assert.deepEqual(warnings, ['Cannot setup C/C++ properties: c_cpp_properties.json format is invalid.']);
    });
  });
});
