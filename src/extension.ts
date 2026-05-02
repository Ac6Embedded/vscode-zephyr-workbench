// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { westBoardsCommand, westInitCommand, westUpdateCommand, westPackagesInstallCommand, westBuildCommand, westConfigCommand, westRebuildCommand, westSpdxGenerateCommand, westSpdxInitCommand } from './commands/WestCommands';
import { WestWorkspace } from './models/WestWorkspace';
import { ZephyrApplication } from './models/ZephyrApplication';
import { ZephyrDebugConfigurationProvider } from './providers/ZephyrDebugConfigurationProvider';
import { ZephyrBuildConfig } from './models/ZephyrBuildConfig';
import { ArmGnuToolchainInstallation, normalizeZephyrSdkVariant, ZephyrSdkInstallation, IarToolchainInstallation } from './models/ToolchainInstallations';
import { checkAndCreateTasksJson, isReservedTaskLabel, removeCppToolsConfiguration, saveCustomTaskDefinition, setDefaultProjectSettings, setDefaultWorkspaceApplicationSettings, updateCppToolsConfiguration, updateTasks, ZephyrTaskDefinition, ZephyrTaskProvider } from './providers/ZephyrTaskProvider';
import { changeBoardQuickStep } from './quicksteps/changeBoardQuickStep';
import { changeEnvVarQuickStep } from './quicksteps/changeEnvVarQuickStep';
import { changeWestWorkspaceQuickStep } from './quicksteps/changeWestWorkspaceQuickStep';
import { ZEPHYR_BUILD_CONFIG_DEFAULT_RUNNER_SETTING_KEY, ZEPHYR_BUILD_CONFIG_CUSTOM_ARGS_SETTING_KEY, ZEPHYR_BUILD_CONFIG_SYSBUILD_SETTING_KEY, ZEPHYR_BUILD_CONFIG_WEST_FLAGS_D_SETTING_KEY, ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY, ZEPHYR_PROJECT_BOARD_SETTING_KEY, ZEPHYR_PROJECT_SDK_SETTING_KEY, ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY, ZEPHYR_WEST_WORKSPACE_APPLICATIONS_SETTING_KEY, ZEPHYR_WEST_WORKSPACE_SELECTED_APPLICATION_SETTING_KEY, ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY, ZEPHYR_PROJECT_IAR_SETTING_KEY, ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY, ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY, ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY } from './constants';
import {
	getLaunchConfiguration,
	getRunner,
	getFlashRunners,
	getStaticFlashRunnerNames,
	ZEPHYR_WORKBENCH_DEBUG_APP_ROOT_KEY,
	ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME,
} from './utils/debugTools/debugUtils';
import { ensureTerminalStickyScrollDisabled, executeTask, getTerminalDefaultProfile, isSpdxOnlyVenvPath, normalizeSlashesIfPath, resolveConfiguredPath } from './utils/execUtils';
import { checkEnvFile, checkHomebrew, checkHostTools, cleanupDownloadDir, createLocalVenv, createLocalVenvSPDX, download, forceInstallHostTools, installHostDebugTools, installVenv, runInstallHostTools, setDefaultSettings, verifyHostTools, installOpenOcdRunnerSilently } from './utils/installUtils';
import { generateWestManifest } from './utils/zephyr/manifestUtils';
import { CreateWestWorkspacePanel } from './panels/CreateWestWorkspacePanel';
import { CreateZephyrAppPanel } from './panels/CreateZephyrAppPanel';
import { DebugManagerPanel } from './panels/DebugManagerPanel';
import { DebugToolsPanel } from './panels/DebugToolsPanel';
import { WestManagerPanel } from './panels/WestManagerPanel';
import { HostToolsPanel } from './panels/HostToolsPanel';
import { ImportZephyrSDKPanel } from './panels/ImportZephyrSDKPanel';
import { EclairManagerPanel } from './panels/EclairManagerPanel';
import { ZephyrDashboardViewProvider } from './panels/ZephyrDashboardViewProvider';
import { changeToolchainQuickStep } from "./quicksteps/changeToolchainQuickStep";
import { getBoardFromIdentifier } from './utils/zephyr/boardDiscovery';
import { pickApplicationQuickStep } from './quicksteps/pickApplicationQuickStep';
import { pickBuildConfigQuickStep } from './quicksteps/pickBuildConfigQuickStep';
import { WestWorkspaceApplicationTreeItem, WestWorkspaceDataProvider, WestWorkspaceEnvTreeItem, WestWorkspaceEnvValueTreeItem, WestWorkspaceTreeItem } from './providers/WestWorkspaceDataProvider';
import { ZephyrApplicationDataProvider, ZephyrApplicationEnvTreeItem, ZephyrApplicationEnvValueTreeItem, ZephyrApplicationTreeItem, ZephyrApplicationWestWorkspaceTreeItem, ZephyrConfigBoardTreeItem, ZephyrConfigDefaultRunnerTreeItem, ZephyrConfigCustomArgsTreeItem, ZephyrConfigEnvTreeItem, ZephyrConfigEnvValueTreeItem, ZephyrConfigTreeItem, ZephyrConfigWestFlagsDTreeItem, ZephyrConfigWestFlagsDValueTreeItem } from './providers/ZephyrApplicationProvider';
import { ZephyrHostToolsCommandProvider } from './providers/ZephyrHostToolsCommandProvider';
import { ZephyrOtherResourcesCommandProvider } from './providers/ZephyrOtherResourcesCommandProvider';
import { ToolchainInstallationsDataProvider, ToolchainInstallationTreeItem } from "./providers/ToolchainInstallationsDataProvider";
import { ZephyrShortcutCommandProvider } from './providers/ZephyrShortcutCommandProvider';
import { extractSDK, generateSdkUrls, registerZephyrSDK, unregisterZephyrSDK, registerIARToolchain, unregisterIARToolchain } from './utils/zephyr/sdkUtils';
import { registerArmGnuToolchain, unregisterArmGnuToolchain } from './utils/zephyr/armGnuToolchainUtils';
import { setConfigQuickStep } from './quicksteps/setConfigQuickStep';
import { addWorkspaceFolder, copySampleSync, createWorkspaceFolderReference, deleteFolder, fileExists, findArmGnuToolchainInstallation, findConfigTask, findIarToolchainInstallation, getExactWorkspaceFolder, getInternalToolsDirRealPath, getRegisteredArmGnuToolchainInstallations, getRegisteredIarToolchainInstallations, getRegisteredZephyrSdkInstallations, getWestWorkspace, getWestWorkspaces, getWorkspaceFolder, getZephyrApplication, getZephyrSdkInstallation, isWorkspaceFolder, msleep, removeWorkspaceFolder, checkZinstallerVersion } from './utils/utils';
import { addEnvValue, removeEnvValue, replaceEnvValue, saveEnv } from './utils/env/zephyrEnvUtils';
import { getZephyrEnvironment, getZephyrTerminal, runCommandTerminal } from './utils/zephyr/zephyrTerminalUtils';
import { execCveBinToolCommand, execNtiaCheckerCommand, execSBom2DocCommand } from './commands/SPDXCommands';
import { syncAutoDetectEnv } from './utils/debugTools/autoDetectSyncUtils';
import { initDtsIntegration } from './utils/zephyr/dtsIntegration';
import { normalizeWestFlagDValue } from './utils/zephyr/westArgUtils';
import {
	findContainingWorkspaceApplicationEntry,
	getEffectiveWorkspaceApplicationEntry,
	isPathWithin as isPathWithinWorkspaceApplication,
	readWorkspaceApplicationEntries,
	removeWorkspaceApplicationEntry,
	resolveWorkspaceApplicationPath,
	setSelectedWorkspaceApplicationPath,
} from './utils/zephyr/workspaceApplications';
import {
	addApplicationConfig,
	deleteApplicationConfig,
	saveApplicationConfigEnv,
	saveApplicationConfigSetting,
	saveApplicationEnv,
	updateApplicationSettings,
} from './utils/zephyr/applicationSettings';

let statusBarBuildItem: vscode.StatusBarItem;
let statusBarDebugItem: vscode.StatusBarItem;
// Shows the selected west workspace application for the active editor's west
// workspace. Hidden for freestanding apps and when the active file isn't part
// of any west workspace that declares applications.
let statusBarSelectedAppItem: vscode.StatusBarItem;
let zephyrTaskProvider: vscode.Disposable | undefined;
let zephyrDebugConfigurationProvide: vscode.Disposable | undefined;
const WEST_FLAGS_D_LABEL = 'west Flags -D';

function addWestFlagDValue(config: ZephyrBuildConfig, value: string): boolean {
	const normalized = normalizeWestFlagDValue(value);
	if (!normalized || config.westFlagsD.includes(normalized)) {
		return false;
	}
	config.westFlagsD.push(normalized);
	return true;
}

function replaceWestFlagDValue(config: ZephyrBuildConfig, oldValue: string, value: string): boolean {
	const normalized = normalizeWestFlagDValue(value);
	if (!normalized) {
		return false;
	}

	const index = config.westFlagsD.indexOf(oldValue);
	if (index === -1) {
		return false;
	}

	if (normalized !== oldValue) {
		const duplicateIndex = config.westFlagsD.indexOf(normalized);
		if (duplicateIndex !== -1) {
			config.westFlagsD.splice(index, 1);
			return true;
		}
	}

	config.westFlagsD[index] = normalized;
	return true;
}

function removeWestFlagDValue(config: ZephyrBuildConfig, value: string): boolean {
	const index = config.westFlagsD.indexOf(value);
	if (index === -1) {
		return false;
	}
	config.westFlagsD.splice(index, 1);
	return true;
}

function isValidVenvDirectory(venvPath: string): boolean {
	const normalizedPath = path.normalize(venvPath);
	const candidates = process.platform === 'win32'
		? [
			path.join(normalizedPath, 'Scripts', 'python.exe'),
			path.join(normalizedPath, 'Scripts', 'Activate.ps1'),
			path.join(normalizedPath, 'Scripts', 'activate.bat'),
		]
		: [
			path.join(normalizedPath, 'bin', 'python'),
			path.join(normalizedPath, 'bin', 'python3'),
			path.join(normalizedPath, 'bin', 'activate'),
		];

	return candidates.some(candidate => fileExists(candidate));
}

async function showLocalVenvQuickStep(
	workspaceFolder: vscode.WorkspaceFolder,
	initialValue = '',
): Promise<string | undefined> {
	class BrowseButton implements vscode.QuickInputButton {
		constructor(public iconPath: vscode.ThemeIcon, public tooltip: string) { }
	}

	const browseButton = new BrowseButton(vscode.ThemeIcon.Folder, 'Browse for venv folder');
	const inputBox = vscode.window.createInputBox();
	inputBox.title = 'Set Local Python Virtual Environment';
	inputBox.value = resolveConfiguredPath(initialValue, workspaceFolder) ?? initialValue;
	inputBox.prompt = 'Enter the venv root folder for this application. Leave empty to clear the local override.';
	inputBox.placeholder = '${workspaceFolder}/.venv';
	inputBox.buttons = [browseButton];
	inputBox.ignoreFocusOut = true;

	return new Promise((resolve) => {
		let accepted = false;

		inputBox.onDidTriggerButton(async (button) => {
			if (button !== browseButton) {
				return;
			}

			const selection = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				defaultUri: workspaceFolder.uri,
				openLabel: 'Use this venv',
				title: 'Select the Python virtual environment root folder',
			});

			if (selection && selection.length > 0) {
				inputBox.value = selection[0].fsPath;
			}
		});

		inputBox.onDidAccept(() => {
			const trimmedValue = inputBox.value.trim();
			if (trimmedValue.length === 0) {
				accepted = true;
				resolve('');
				inputBox.hide();
				return;
			}

			const resolvedValue = resolveConfiguredPath(trimmedValue, workspaceFolder) ?? trimmedValue;
			if (isSpdxOnlyVenvPath(resolvedValue)) {
				inputBox.validationMessage = 'The SPDX-only venv is ignored for normal runtime operations. Choose a normal venv such as .venv.';
				return;
			}
			if (!isValidVenvDirectory(resolvedValue)) {
				inputBox.validationMessage = 'Select the venv root folder containing Scripts/ or bin/.';
				return;
			}

			inputBox.validationMessage = undefined;
			accepted = true;
			resolve(resolvedValue);
			inputBox.hide();
		});

		inputBox.onDidChangeValue(() => {
			inputBox.validationMessage = undefined;
		});

		inputBox.onDidHide(() => {
			if (!accepted) {
				resolve(undefined);
			}
			inputBox.dispose();
		});

		inputBox.show();
	});
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	// Migrate deprecated venv.activatePath to venv.path if present
	(async () => {
		const stripActivate = (p: string): string => {
			const patterns = [
				/[/\\]Scripts[/\\]activate(?:\.bat)?$/i,
				/[/\\]Scripts[/\\]Activate\.ps1$/i,
				/[/\\]bin[/\\]activate(?:\.(?:csh|fish))?$/
			];
			for (const rx of patterns) {
				if (rx.test(p)) { return p.replace(rx, ''); }
			}
			return p;
		};

		// Global scope
		const globalCfg = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY);
		const oldGlobal = globalCfg.get<string>(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY, '');
		const newGlobal = globalCfg.get<string>(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY, '');
		if (oldGlobal && !newGlobal) {
			const venvPath = stripActivate(oldGlobal);
			await globalCfg.update(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY, venvPath, vscode.ConfigurationTarget.Global);
			await globalCfg.update(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY, undefined, vscode.ConfigurationTarget.Global);
		}

		// Per-workspace-folder scope
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const cfg = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, folder);
			const old = cfg.get<string>(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY, '');
			const neu = cfg.get<string>(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY, '');
			if (old && !neu) {
				const venvPath = stripActivate(old);
				await cfg.update(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY, venvPath, vscode.ConfigurationTarget.WorkspaceFolder);
				await cfg.update(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
			}
		}
	})();
	// Disable terminal sticky scroll at workspace level (only if the user hasn't
	// explicitly set it) — it overlays the env banner on open and corrupts TUIs
	// like menuconfig. Fire-and-forget; takes effect once for this workspace.
	void ensureTerminalStickyScrollDisabled();

	// Sync env.yml auto-detect entries from debug-tools.yml when versions differ
	syncAutoDetectEnv(context);
	// Setup task and debug providers
	zephyrTaskProvider = vscode.tasks.registerTaskProvider(ZephyrTaskProvider.ZephyrType, new ZephyrTaskProvider());
	zephyrDebugConfigurationProvide = vscode.debug.registerDebugConfigurationProvider('cppdbg', new ZephyrDebugConfigurationProvider());

	// Setup Status bar
	statusBarBuildItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
	statusBarBuildItem.text = "$(gear) Build";
	statusBarBuildItem.command = "zephyr-workbench.build-app";
	statusBarDebugItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBarDebugItem.text = "$(debug-alt) Debug";
	statusBarDebugItem.command = "zephyr-workbench.debug-app";
	// Higher priority than Build/Debug so the project name reads as the leftmost
	// indicator of the trio. It provides the context for the build/debug actions
	// to its right.
	statusBarSelectedAppItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 102);
	statusBarSelectedAppItem.command = "zephyr-workbench.select-workspace-application";

	context.subscriptions.push(statusBarBuildItem);
	context.subscriptions.push(statusBarDebugItem);
	context.subscriptions.push(statusBarSelectedAppItem);

	// Setup Tree view providers
	const zephyrShortcutProvider = new ZephyrShortcutCommandProvider();
	vscode.window.registerTreeDataProvider('zephyr-workbench-shortcuts', zephyrShortcutProvider);

	const toolchainInstallationsProvider = new ToolchainInstallationsDataProvider();
	vscode.window.registerTreeDataProvider('zephyr-workbench-sdk-explorer', toolchainInstallationsProvider);

	const westWorkspaceProvider = new WestWorkspaceDataProvider();
	vscode.window.registerTreeDataProvider('zephyr-workbench-west-workspace', westWorkspaceProvider);

	const zephyrAppProvider = new ZephyrApplicationDataProvider();
	vscode.window.registerTreeDataProvider('zephyr-workbench-app-explorer', zephyrAppProvider);
	const dashboardViewProvider = new ZephyrDashboardViewProvider();
	context.subscriptions.push(
		dashboardViewProvider,
		vscode.window.registerWebviewViewProvider(
			ZephyrDashboardViewProvider.viewId,
			dashboardViewProvider,
			{
				webviewOptions: {
					retainContextWhenHidden: true,
				},
			},
		),
	);
	void dashboardViewProvider.refresh();
	let appRefreshSuspendCount = 0;
	let appRefreshPending = false;

	const flushAppRefresh = () => {
		appRefreshPending = false;
		zephyrAppProvider.refresh();
		void dashboardViewProvider.refresh();
	};

	const requestAppRefresh = () => {
		// Project create/import updates workspace folders, tasks, and several settings in sequence.
		// While that batch is running, collapse repeated refresh requests into one final refresh.
		if (appRefreshSuspendCount > 0) {
			appRefreshPending = true;
			return;
		}
		flushAppRefresh();
	};

	const withAppRefreshBatch = async <T>(fn: () => Promise<T>): Promise<T> => {
		appRefreshSuspendCount++;
		try {
			return await fn();
		} finally {
			appRefreshSuspendCount--;
			// Only the outermost batch flushes, so nested callers still produce a single tree refresh.
			if (appRefreshSuspendCount === 0 && appRefreshPending) {
				flushAppRefresh();
			}
		}
	};

	const zephyrToolsCommandProvider = new ZephyrHostToolsCommandProvider();
	vscode.window.registerTreeDataProvider('zephyr-workbench-tools-explorer', zephyrToolsCommandProvider);

	const zephyrResourcesCommandProvider = new ZephyrOtherResourcesCommandProvider();
	vscode.window.registerTreeDataProvider('zephyr-workbench-other-resources', zephyrResourcesCommandProvider);

	// Initialize DTS-LSP integration: creates contexts on .overlay/.dts opens
	initDtsIntegration(context);

	// Register commands
	// TODO: Could be refactored / Optimized
	vscode.commands.registerCommand('zephyr-workbench-sdk-explorer.refresh', () => toolchainInstallationsProvider.refresh());
	vscode.commands.registerCommand('zephyr-workbench-west-workspace.refresh', () => westWorkspaceProvider.refresh());
	vscode.commands.registerCommand('zephyr-workbench-app-explorer.refresh', () => {
		zephyrAppProvider.refresh();
		void dashboardViewProvider.refresh();
	});
	vscode.commands.registerCommand('zephyr-workbench.workbench-dashboard.refresh', () => dashboardViewProvider.refresh());

	vscode.commands.registerCommand('zephyr-workbench.build-app', async () => {
		let currentProject: ZephyrApplication | vscode.Uri | undefined = vscode.window.activeTextEditor?.document.uri;
		if (currentProject === undefined) {
			currentProject = await pickApplicationQuickStep(context);
		}

		if (currentProject) {
			vscode.commands.executeCommand("zephyr-workbench-app-explorer.build-app", currentProject);
		}
	});

	vscode.commands.registerCommand('zephyr-workbench.rebuild-app', async () => {
		let currentProject: ZephyrApplication | vscode.Uri | undefined = vscode.window.activeTextEditor?.document.uri;
		if (currentProject === undefined) {
			currentProject = await pickApplicationQuickStep(context);
		}

		if (currentProject) {
			vscode.commands.executeCommand("zephyr-workbench-app-explorer.clean.pristine", currentProject);
		}
	});

	vscode.commands.registerCommand('zephyr-workbench.debug-app', async () => {
		let currentProject: ZephyrApplication | vscode.Uri | undefined = vscode.window.activeTextEditor?.document.uri;
		if (currentProject === undefined) {
			currentProject = await pickApplicationQuickStep(context);
		}

		if (currentProject) {
			vscode.commands.executeCommand("zephyr-workbench-app-explorer.debug-app", currentProject);
		}
	});

	vscode.commands.registerCommand('zephyr-workbench.open-webpage', async (site_url: string) => {
		if (site_url === 'Coming soon') {
			vscode.window.showInformationMessage('Tutorials are coming soon...');
		} else {
			const url = vscode.Uri.parse(site_url);
			vscode.env.openExternal(url);
		}
	});

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench.workbench-dashboard.open', async (node?: any) => {
			await dashboardViewProvider.reveal(node);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench.west-dashboard.open', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {
			if (!node?.project) {
				return;
			}

			const buildConfig = node instanceof ZephyrConfigTreeItem
				? node.buildConfig
				: (node.project.buildConfigs.find(c => c.active) ?? node.project.buildConfigs[0]);
			if (!buildConfig) {
				return;
			}

			// `executeConfigTask` resolves AFTER the task finishes (it awaits our
			// `executeTask` end-listener internally). Once it returns, the dashboard
			// artifact should be on disk if the build succeeded.
			const taskExec = await executeConfigTask('West Dashboard', node);
			if (!taskExec || taskExec.length === 0) {
				return;
			}

			const dashboardHtml = path.join(buildConfig.getBuildDir(node.project), 'dashboard', 'index.html');
			if (fs.existsSync(dashboardHtml)) {
				await vscode.env.openExternal(vscode.Uri.file(dashboardHtml));
			} else {
				vscode.window.showWarningMessage(`Dashboard not generated: ${dashboardHtml} not found.`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench.eclair-manager.open', async (node?: any) => {
			const { workspaceFolder, settingsRoot } = resolveWorkspaceFolderForEclair(node);
			EclairManagerPanel.render(context.extensionUri, workspaceFolder, settingsRoot);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench.west-manager', async (node?: WestWorkspaceTreeItem) => {
			WestManagerPanel.render(context.extensionUri, node?.westWorkspace);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.spdx.analyze.dt-doctor', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {
			if (!node?.project) {
				return;
			}
			await executeConfigTask('DT Doctor', node);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-west-workspace.open-wizard', async () => {
			if (await checkHostTools() && await checkEnvFile()) {
				CreateWestWorkspacePanel.render(context.extensionUri);
			} else {
				const installHostToolsItem = 'Install Host Tools';
				const choice = await vscode.window.showErrorMessage("Host tools are missing, please install them first", installHostToolsItem);
				if (choice === installHostToolsItem) {
					vscode.commands.executeCommand('zephyr-workbench.install-host-tools.open-manager');
				}
				return;
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.import-local", async (projectPath, venvMode = 'global') => {
			if (projectPath) {
				CreateWestWorkspacePanel.currentPanel?.dispose();
				if (ZephyrApplication.isApplicationPath(projectPath)) {
					await withAppRefreshBatch(async () => {
						await addWorkspaceFolder(projectPath);
						// Optionally create a local venv for the imported project
						if (venvMode === 'local') {
							const workspaceFolder = getWorkspaceFolder(projectPath);
							if (workspaceFolder) {
								const venvPath = await createLocalVenv(context, workspaceFolder);
								if (venvPath) {
									await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
										.update(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY, venvPath, vscode.ConfigurationTarget.WorkspaceFolder);
								}
							}
						}

						requestAppRefresh();
					});
				} else {
					const containingWorkspace = vscode.workspace.workspaceFolders?.find(folder =>
						WestWorkspace.isWestWorkspaceFolder(folder)
						&& isPathWithinWorkspaceApplication(folder.uri.fsPath, projectPath)
					);
					const existingEntry = containingWorkspace
						? findContainingWorkspaceApplicationEntry(containingWorkspace, projectPath)
						: undefined;
					if (containingWorkspace && existingEntry) {
						const appPath = resolveWorkspaceApplicationPath(existingEntry, containingWorkspace) ?? projectPath;
						await setSelectedWorkspaceApplicationPath(containingWorkspace, appPath);
						requestAppRefresh();
						westWorkspaceProvider.refresh();
						vscode.window.showInformationMessage(`Using existing West workspace application '${path.basename(appPath)}'.`);
					} else if (containingWorkspace && ZephyrApplication.isApplicationPathLike(projectPath)) {
						vscode.window.showErrorMessage("This is a West workspace application. Select its workspace, board, and toolchain to link it first.");
					} else {
						vscode.window.showErrorMessage("The folder is not a Zephyr project");
					}
				}
			} else {
				vscode.window.showErrorMessage("The selected location folder is invalid");
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.build-app', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem | ZephyrApplication | vscode.WorkspaceFolder | vscode.Uri, configName: string) => {
			// After first build, parse toolchain name from .config
			let folder: vscode.WorkspaceFolder | undefined = undefined;
			let boardIdentifier: string = '';
			if (node instanceof ZephyrConfigTreeItem) {
				const westWorkspace = getWestWorkspace(node.project.westWorkspaceRootPath);
				await westBuildCommand(node.project, westWorkspace, '', configName ?? node.buildConfig.name);
				if (node.project) {
					folder = node.project.appWorkspaceFolder;
					boardIdentifier = node.buildConfig.boardIdentifier;
				}
			} else if (node instanceof ZephyrApplicationTreeItem) {
				const westWorkspace = getWestWorkspace(node.project.westWorkspaceRootPath);
				await westBuildCommand(node.project, westWorkspace, '', configName);
				folder = node.project.appWorkspaceFolder;
			} else if (node instanceof ZephyrApplication) {
				const westWorkspace = getWestWorkspace(node.westWorkspaceRootPath);
				await westBuildCommand(node, westWorkspace, '', configName);
				folder = node.appWorkspaceFolder;
			} else if ((node as vscode.WorkspaceFolder).uri) {
				// It's a WorkspaceFolder
				const project = await getZephyrApplication((node as vscode.WorkspaceFolder).uri.fsPath);
				await westBuildCommand(project, getWestWorkspace(project.westWorkspaceRootPath), '', configName);
				folder = node as vscode.WorkspaceFolder;
			} else if ((node as vscode.Uri).fsPath) {
				// It's a Uri from right-click in Explorer
				const project = await getZephyrApplication((node as vscode.Uri).fsPath);
				const westWorkspace = getWestWorkspace(project.westWorkspaceRootPath);
				await westBuildCommand(project, westWorkspace, '', configName);
				folder = vscode.workspace.getWorkspaceFolder(node as vscode.Uri) || undefined;
			}

			if (folder) {
				let gccPath: string | undefined = vscode.workspace.getConfiguration('C_Cpp', folder).get('default.compilerPath');
				if (gccPath && gccPath.includes('undefined')) {
					const project = await getZephyrApplication(folder.uri.fsPath);

					// Use-case if build out of APPLICATIONS view, means from WorkspaceFolder 
					// Cannot know board identifier beforehand so detect if after parsing settings.json
					// On non-legacy project, assume first config can be the "master"
					if (boardIdentifier.length === 0) {
						boardIdentifier = project.buildConfigs[0].boardIdentifier;
					}
					await updateCompileSetting(project, configName, boardIdentifier);
				}
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench.explorer.build', async (uri: vscode.Uri) => {
			await vscode.commands.executeCommand('zephyr-workbench-app-explorer.build-app', uri);
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.clean.pristine', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem | ZephyrApplication | vscode.WorkspaceFolder | vscode.Uri, configName?: string) => {
			if (node instanceof ZephyrConfigTreeItem) {
				const westWorkspace = getWestWorkspace(node.project.westWorkspaceRootPath);
				await westRebuildCommand(node.project, westWorkspace, configName ?? node.buildConfig.name);
			} else if (node instanceof ZephyrApplicationTreeItem) {
				const westWorkspace = getWestWorkspace(node.project.westWorkspaceRootPath);
				await westRebuildCommand(node.project, westWorkspace, configName);
			} else if (node instanceof ZephyrApplication) {
				const westWorkspace = getWestWorkspace(node.westWorkspaceRootPath);
				await westRebuildCommand(node, westWorkspace, configName);
			} else if ((node as vscode.WorkspaceFolder).uri) {
				const project = await getZephyrApplication((node as vscode.WorkspaceFolder).uri.fsPath);
				await westRebuildCommand(project, getWestWorkspace(project.westWorkspaceRootPath), configName);
			} else if ((node as vscode.Uri).fsPath) {
				const project = await getZephyrApplication((node as vscode.Uri).fsPath);
				const westWorkspace = getWestWorkspace(project.westWorkspaceRootPath);
				await westRebuildCommand(project, westWorkspace, configName);
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench.explorer.rebuild', async (uri: vscode.Uri) => {
			await vscode.commands.executeCommand('zephyr-workbench-app-explorer.clean.pristine', uri);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench.explorer.terminal', async (uri: vscode.Uri) => {
			await vscode.commands.executeCommand('zephyr-workbench-app-explorer.open-terminal', uri);
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.clean.delete', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {
			let buildDir: string = '';
			if (node instanceof ZephyrApplicationTreeItem) {
				if (node.project) {
					buildDir = 'build';
				}
			} else if (node instanceof ZephyrConfigTreeItem) {
				if (node.buildConfig) {
					buildDir = node.buildConfig.relativeBuildDir;
				}
			}

			if (node.project && buildDir.length > 0) {
				vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: "Deleting Zephyr Application build directory",
					cancellable: false,
				}, async () => {
					deleteFolder(path.join(node.project.appRootPath, buildDir));
				}
				);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.guiconfig-app', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {
			const profile = getTerminalDefaultProfile();

			if (!profile) {
				await executeConfigTask('Gui config', node);
				return;
			}

			if (node instanceof ZephyrConfigTreeItem && profile) {
				const westWorkspace = getWestWorkspace(node.project.westWorkspaceRootPath);
				westConfigCommand(node.project, westWorkspace, "guiconfig");
			}
			else if (node instanceof ZephyrApplicationTreeItem && profile) {
				const westWorkspace = getWestWorkspace(node.project.westWorkspaceRootPath);
				westConfigCommand(node.project, westWorkspace, "guiconfig");
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.menuconfig-app', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {
			const profile = getTerminalDefaultProfile();
			if (!profile) {
				await executeConfigTask('Menuconfig', node);
				return;
			}
			if (node instanceof ZephyrConfigTreeItem && profile) {
				const westWorkspace = getWestWorkspace(node.project.westWorkspaceRootPath);
				westConfigCommand(node.project, westWorkspace, "menuconfig");
			}
			else if (node instanceof ZephyrApplicationTreeItem && profile) {
				const westWorkspace = getWestWorkspace(node.project.westWorkspaceRootPath);
				westConfigCommand(node.project, westWorkspace, "menuconfig");
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.hardenconfig-app', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {	
			const profile = getTerminalDefaultProfile();
			if (!profile) {
				await executeConfigTask('Harden Config', node);
				return;
			}
			if (node instanceof ZephyrConfigTreeItem && profile) {
				const westWorkspace = getWestWorkspace(node.project.westWorkspaceRootPath);
				westConfigCommand(node.project, westWorkspace, "hardenconfig");
			}
			else if (node instanceof ZephyrApplicationTreeItem && profile) {
				const westWorkspace = getWestWorkspace(node.project.westWorkspaceRootPath);
				westConfigCommand(node.project, westWorkspace, "hardenconfig");
			}
		})
	);
	context.subscriptions.push(
    vscode.commands.registerCommand('zephyr-workbench-app-explorer.set-default-runner', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem | ZephyrConfigDefaultRunnerTreeItem) => {
			let project: ZephyrApplication | undefined;
			let targetConfig: ZephyrBuildConfig | undefined;

			if (node instanceof ZephyrApplicationTreeItem) {
				project = node.project;
				// For single-config apps, use that config; for multi, ask which active? else pick
				if (project.buildConfigs.length === 1) {
					targetConfig = project.buildConfigs[0];
				} else if (project.buildConfigs.length > 1) {
					const picked = await pickBuildConfigQuickStep(project);
					if (picked) {
						targetConfig = project.getBuildConfiguration(picked);
					}
				}
      } else if (node instanceof ZephyrConfigTreeItem) {
        project = node.project;
        targetConfig = node.buildConfig;
      } else if (node instanceof ZephyrConfigDefaultRunnerTreeItem) {
        project = node.project;
        targetConfig = node.config;
      }

			if (!project || !targetConfig) {
				vscode.window.showErrorMessage('Unable to determine target configuration to set default runner.');
				return;
			}

			const chosenRunner = await addCustomRunners(project, targetConfig);
			if (!chosenRunner){
				return;
			}

			await saveApplicationConfigSetting(project, targetConfig.name, ZEPHYR_BUILD_CONFIG_DEFAULT_RUNNER_SETTING_KEY, chosenRunner);

			const customArgs = await vscode.window.showInputBox({
				title: 'Custom Arguments For Runner',
				prompt: 'Optional: enter extra arguments passed to the runner.',
				placeHolder: 'Example: --erase',
				value: targetConfig.customArgs ?? '',
				ignoreFocusOut: true,
			});
			if (customArgs !== undefined) {
				await saveApplicationConfigSetting(project, targetConfig.name, ZEPHYR_BUILD_CONFIG_CUSTOM_ARGS_SETTING_KEY, customArgs.trim());
			}

			vscode.commands.executeCommand('zephyr-workbench-app-explorer.refresh');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('zephyr-workbench-app-explorer.change-default-runner', async (node: any) => {
      // Reuse the same implementation as set-default-runner
      vscode.commands.executeCommand('zephyr-workbench-app-explorer.set-default-runner', node);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('zephyr-workbench-app-explorer.remove-default-runner', async (node: any) => {
      let project: ZephyrApplication | undefined;
      let targetConfig: ZephyrBuildConfig | undefined;

      if (node instanceof ZephyrApplicationTreeItem) {
        project = node.project;
        if (project.buildConfigs.length === 1) {
          targetConfig = project.buildConfigs[0];
        } else if (project.buildConfigs.length > 1) {
          const picked = await pickBuildConfigQuickStep(project);
          if (picked) {
            targetConfig = project.getBuildConfiguration(picked);
          }
        }
      } else if (node instanceof ZephyrConfigTreeItem) {
        project = node.project;
        targetConfig = node.buildConfig;
      } else if (node instanceof ZephyrConfigDefaultRunnerTreeItem) {
        project = node.project;
        targetConfig = node.config;
      }

      if (!project || !targetConfig) {
        return;
      }

      await saveApplicationConfigSetting(project, targetConfig.name, ZEPHYR_BUILD_CONFIG_DEFAULT_RUNNER_SETTING_KEY, "");
      // Also clear custom args when removing the runner
      await saveApplicationConfigSetting(project, targetConfig.name, ZEPHYR_BUILD_CONFIG_CUSTOM_ARGS_SETTING_KEY, "");
      vscode.commands.executeCommand('zephyr-workbench-app-explorer.refresh');
    })
  );

  // Set or change custom arguments
  context.subscriptions.push(
    vscode.commands.registerCommand('zephyr-workbench-app-explorer.set-custom-args', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem | ZephyrConfigDefaultRunnerTreeItem | ZephyrConfigCustomArgsTreeItem) => {
      let project: ZephyrApplication | undefined;
      let targetConfig: ZephyrBuildConfig | undefined;

      if (node instanceof ZephyrApplicationTreeItem) {
        project = node.project;
        if (project.buildConfigs.length === 1) {
          targetConfig = project.buildConfigs[0];
        } else if (project.buildConfigs.length > 1) {
          const picked = await pickBuildConfigQuickStep(project);
          if (picked) {
            targetConfig = project.getBuildConfiguration(picked);
          }
        }
      } else if (node instanceof ZephyrConfigTreeItem) {
        project = node.project;
        targetConfig = node.buildConfig;
      } else if (node instanceof ZephyrConfigDefaultRunnerTreeItem) {
        project = node.project;
        targetConfig = node.config;
      } else if (node instanceof ZephyrConfigCustomArgsTreeItem) {
        project = node.project;
        targetConfig = node.config;
      }

      if (!project || !targetConfig) {
        vscode.window.showErrorMessage('Unable to determine target configuration to set custom arguments.');
        return;
      }

      if (!targetConfig.defaultRunner || targetConfig.defaultRunner.length === 0) {
        vscode.window.showWarningMessage('Set a default runner first before adding custom arguments for the runner.');
        return;
      }

      const customArgs = await vscode.window.showInputBox({
        title: 'Custom Arguments For Runner',
        prompt: 'Optional: enter extra arguments passed to the runner.',
        placeHolder: 'Example: --erase',
        value: targetConfig.customArgs ?? '',
        ignoreFocusOut: true,
      });
      if (customArgs !== undefined) {
        await saveApplicationConfigSetting(project, targetConfig.name, ZEPHYR_BUILD_CONFIG_CUSTOM_ARGS_SETTING_KEY, customArgs.trim());
        vscode.commands.executeCommand('zephyr-workbench-app-explorer.refresh');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('zephyr-workbench-app-explorer.change-custom-args', async (node: any) => {
      vscode.commands.executeCommand('zephyr-workbench-app-explorer.set-custom-args', node);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('zephyr-workbench-app-explorer.remove-custom-args', async (node: ZephyrConfigCustomArgsTreeItem | ZephyrConfigDefaultRunnerTreeItem) => {
      let project: ZephyrApplication | undefined;
      let targetConfig: ZephyrBuildConfig | undefined;

      if (node instanceof ZephyrConfigCustomArgsTreeItem) {
        project = node.project;
        targetConfig = node.config;
      } else if (node instanceof ZephyrConfigDefaultRunnerTreeItem) {
        project = node.project;
        targetConfig = node.config;
      }

      if (!project || !targetConfig) {
        return;
      }

      await saveApplicationConfigSetting(project, targetConfig.name, ZEPHYR_BUILD_CONFIG_CUSTOM_ARGS_SETTING_KEY, "");
      vscode.commands.executeCommand('zephyr-workbench-app-explorer.refresh');
    })
  );

  context.subscriptions.push(
      vscode.commands.registerCommand('zephyr-workbench-app-explorer.run-app', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {
        await executeConfigTask('West Flash', node);
      })
  );
  context.subscriptions.push(
      vscode.commands.registerCommand('zephyr-workbench-app-explorer.flash-run-app', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {
        await executeConfigTask('West Flash', node);
      })
  );
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.debug-app', async (
			node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem | ZephyrApplication | vscode.WorkspaceFolder | vscode.Uri
		) => {
			let workspaceFolder: vscode.WorkspaceFolder | undefined;
			let project: ZephyrApplication | undefined;
			let buildConfigName: string | undefined;

			if (node instanceof ZephyrApplicationTreeItem) {
				if (node.project) {
					project = node.project;
					workspaceFolder = node.project.appWorkspaceFolder;

					if (project.buildConfigs.length === 1) {
						buildConfigName = project.buildConfigs[0].name;
					}
				}
			} else if (node instanceof ZephyrConfigTreeItem) {
				if (node.project && node.buildConfig) {
					project = node.project;
					workspaceFolder = node.project.appWorkspaceFolder;
					buildConfigName = node.buildConfig.name;
				}
			} else if (node instanceof ZephyrApplication) {
				project = node;
				workspaceFolder = node.appWorkspaceFolder;
			} else if ((node as vscode.WorkspaceFolder).uri) {
				workspaceFolder = node as vscode.WorkspaceFolder;
				project = await getZephyrApplication(workspaceFolder.uri.fsPath);
			} else if ((node as vscode.Uri).fsPath) {
				workspaceFolder = vscode.workspace.getWorkspaceFolder(node as vscode.Uri) || undefined;
				if (workspaceFolder) {
					project = await getZephyrApplication((node as vscode.Uri).fsPath);
				}
			}

			if (!project || !workspaceFolder) {
				vscode.window.showErrorMessage("Could not determine the Zephyr project or workspace folder.");
				return;
			}

			if (!buildConfigName) {
				if (project.buildConfigs.length > 1) {
					const activeConfig = project.buildConfigs.find(config => config.active);
					if (activeConfig) {
						buildConfigName = activeConfig.name;
					} else {
						vscode.window.showInformationMessage("No active configuration found, please set one as active first.");
						buildConfigName = await pickBuildConfigQuickStep(project);
					}
				} else if (project.buildConfigs.length === 1) {
					buildConfigName = project.buildConfigs[0].name;
				}
			}

			if (workspaceFolder) {
				const launchConfig = vscode.workspace.getConfiguration('launch', workspaceFolder.uri);
				const configurations: vscode.DebugConfiguration[] = launchConfig.get('configurations', []);

				let configName = ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME;
				if (buildConfigName) {
					configName = `${ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME} [${buildConfigName}]`;
				}

				const launchConfiguration = findLaunchConfigurationForProject(configurations, project, configName);

				if (launchConfiguration) {
					if (project.isWestWorkspaceApplication) {
						await setSelectedWorkspaceApplicationPath(project.appWorkspaceFolder, project.appRootPath);
						await vscode.debug.startDebugging(workspaceFolder, {
							...launchConfiguration,
							[ZEPHYR_WORKBENCH_DEBUG_APP_ROOT_KEY]: project.appRootPath,
						});
					} else {
						await vscode.debug.startDebugging(workspaceFolder, configName);
					}
				} else {
					// Fallback: open Debug Manager with the resolved project/config selection
					const buildConfig = buildConfigName ? project.getBuildConfiguration(buildConfigName) : undefined;
					vscode.commands.executeCommand('zephyr-workbench.debug-manager', {
						project,
						buildConfig,
					});
				}
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench.explorer.debug', async (uri: vscode.Uri) => {
			await vscode.commands.executeCommand('zephyr-workbench-app-explorer.debug-app', uri);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.spdx.install-dependencies', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {
			vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "Create new local environment for SPDX",
				cancellable: false,
			}, async () => {
				await createLocalVenvSPDX(context, node.project.appWorkspaceFolder);
			}
			);
		})
	);

	function getSpdxParentUri(node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem): vscode.Uri | undefined {
		if (!node.project) {
			return undefined;
		}

		const targetConfig =
			node instanceof ZephyrConfigTreeItem
				? node.buildConfig
				: node.project.buildConfigs.find(config => config.active) ?? node.project.buildConfigs[0];
		if (!targetConfig) {
			return undefined;
		}

		const buildUri = vscode.Uri.file(targetConfig.getBuildDir(node.project));
		return vscode.Uri.joinPath(buildUri, 'spdx');
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.spdx.analyze.ntia-checker', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {
			if (node.project) {
				const parentUri = getSpdxParentUri(node);
				if (parentUri && fileExists(parentUri.fsPath)) {
					const spdxFile = await openSPDXDialog(parentUri);
					if (spdxFile) {
						await execNtiaCheckerCommand(spdxFile.fsPath, node.project);
					}
				} else {
					vscode.window.showErrorMessage("No SPDX file to analyze");
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.spdx.analyze.sbom2doc', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {
			if (node.project) {
				const parentUri = getSpdxParentUri(node);
				if (parentUri && fileExists(parentUri.fsPath)) {
					const spdxFile = await openSPDXDialog(parentUri);
					if (spdxFile) {
						await execSBom2DocCommand(spdxFile.fsPath, node.project);
					}
				} else {
					vscode.window.showErrorMessage("No SPDX file to analyze");
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.spdx.analyze.cve-bin-tool', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {
			if (node.project) {
				const parentUri = getSpdxParentUri(node);
				if (parentUri && fileExists(parentUri.fsPath)) {
					const spdxFile = await openSPDXDialog(parentUri);
					if (spdxFile) {
						await execCveBinToolCommand(spdxFile.fsPath, node.project);
					}
				} else {
					vscode.window.showErrorMessage("No SPDX file to analyze");
				}
			}
		})
	);

	async function openSPDXDialog(parentDir?: vscode.Uri): Promise<vscode.Uri | undefined> {
		const fileUri = await vscode.window.showOpenDialog({
			defaultUri: parentDir,
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			openLabel: 'Select',
			filters: {
				'SPDX files': ['spdx'],
				'All files': ['*']
			}
		});

		if (fileUri && fileUri[0]) {
			return fileUri[0];
		} else {
			return undefined;
		}
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.spdx.build', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {
			const project = node.project;
			if (!project) {
				return;
			}

			const targetConfig =
				node instanceof ZephyrConfigTreeItem
					? node.buildConfig
					: project.buildConfigs.find(config => config.active) ?? project.buildConfigs[0];
			if (!targetConfig) {
				vscode.window.showErrorMessage('No build configuration available for SPDX generation.');
				return;
			}

			const buildDirToDelete =
				node instanceof ZephyrConfigTreeItem
					? targetConfig.getBuildDir(project)
					: path.join(project.appRootPath, 'build');

			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "Deleting Zephyr Application build directory",
				cancellable: false,
			}, async () => {
				deleteFolder(buildDirToDelete);
			});

			const westWorkspace = getWestWorkspace(project.westWorkspaceRootPath);
			const extraArgs = appendBuildOutputMeta(targetConfig.westArgs);
			const previousActiveStates = project.buildConfigs.map(config => ({
				config,
				active: config.active,
			}));

			try {
				await westSpdxInitCommand(project, westWorkspace, targetConfig);

				for (const config of project.buildConfigs) {
					config.active = config.name === targetConfig.name;
				}

				await westBuildCommand(project, westWorkspace, extraArgs, targetConfig.name);
				await westSpdxGenerateCommand(project, westWorkspace, targetConfig);
			} catch (error) {
				vscode.window.showErrorMessage(`Error generating SPDX: ${error}`);
			} finally {
				for (const state of previousActiveStates) {
					state.config.active = state.active;
				}
			}

			function appendBuildOutputMeta(input: string): string {
				if (input) {
					if (input.includes('CONFIG_BUILD_OUTPUT_META=y')) {
						return input;
					} else if (input.includes('--')) {
						return `${input} -DCONFIG_BUILD_OUTPUT_META=y`;
					} else {
						return `${input} -- -DCONFIG_BUILD_OUTPUT_META=y`;
					}
				} else {
					return '-- -DCONFIG_BUILD_OUTPUT_META=y';
				}
			}
		})
	);


	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.remove", async (node: ZephyrApplicationTreeItem) => {
			if (node.project) {
				if (node.project.isWestWorkspaceApplication) {
					await removeWorkspaceApplicationAndGeneratedConfig(node.project);
					zephyrAppProvider.refresh();
					westWorkspaceProvider.refresh();
				} else {
					removeWorkspaceFolder(node.project.appWorkspaceFolder);
				}
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.delete", async (node: ZephyrApplicationTreeItem) => {
			if (node.project) {
				if (await showConfirmMessage(`Delete ${node.project.appName} permanently ?`)) {
					vscode.window.withProgress({
						location: vscode.ProgressLocation.Notification,
						title: "Deleting Zephyr Application",
						cancellable: false,
					}, async () => {
						if (node.project.isWestWorkspaceApplication) {
							await removeWorkspaceApplicationAndGeneratedConfig(node.project);
						} else {
							removeWorkspaceFolder(node.project.appWorkspaceFolder);
						}
						deleteFolder(node.project.appRootPath);
						zephyrAppProvider.refresh();
						westWorkspaceProvider.refresh();
					}
					);
				}
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.set-venv", async (node: ZephyrApplicationTreeItem) => {
			vscode.commands.executeCommand('workbench.action.openSettings', `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY}`);
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.set-local-venv", async (node: ZephyrApplicationTreeItem) => {
			if (!node?.project?.appWorkspaceFolder) {
				return;
			}

			const cfg = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, node.project.appWorkspaceFolder);
			const currentLocalVenvPath = node.project.venvPath
				?? cfg.inspect<string>(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY)?.workspaceFolderValue
				?? '';
			const nextVenvPath = await showLocalVenvQuickStep(node.project.appWorkspaceFolder, currentLocalVenvPath);
			if (typeof nextVenvPath === 'undefined') {
				return;
			}

			await updateApplicationSettings(node.project, {
				[ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY]: nextVenvPath.length > 0 ? nextVenvPath : undefined,
			});
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.create-venv", async (node: ZephyrApplicationTreeItem) => {
			vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "Create new local environment",
				cancellable: false,
			}, async () => {
				let venvPath = await createLocalVenv(
					context,
					node.project.appWorkspaceFolder,
					node.project.westWorkspaceRootPath,
					node.project.isWestWorkspaceApplication ? node.project.appRootPath : undefined,
				);
				await updateApplicationSettings(node.project, {
					[ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY]: venvPath,
				});
			}
			);
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.reveal-os', async (node: ZephyrApplicationTreeItem) => {
			if (node.project.appWorkspaceFolder) {
				vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(node.project.appRootPath));
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.reveal-explorer', async (node: ZephyrApplicationTreeItem) => {
			if (node.project.appWorkspaceFolder) {
				vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(node.project.appRootPath));
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.change-board', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem | ZephyrConfigBoardTreeItem) => {
			if (node.project) {
				let boardId;
				if (node instanceof ZephyrConfigTreeItem) {
					boardId = await changeBoardQuickStep(context, node.project, node.buildConfig.name);
				}
				else {
					boardId = await changeBoardQuickStep(context, node.project);
				}
				if (boardId) {
					if (node instanceof ZephyrConfigTreeItem) {
						await saveApplicationConfigSetting(node.project, node.buildConfig.name, ZEPHYR_PROJECT_BOARD_SETTING_KEY, boardId);
					} else if (node instanceof ZephyrConfigBoardTreeItem) {
						await saveApplicationConfigSetting(node.project, node.config.name, ZEPHYR_PROJECT_BOARD_SETTING_KEY, boardId);
					} else if (node instanceof ZephyrApplicationTreeItem) {
						if (node.project.buildConfigs && node.project.buildConfigs.length === 1) {
							await saveApplicationConfigSetting(node.project, node.project.buildConfigs[0].name, ZEPHYR_PROJECT_BOARD_SETTING_KEY, boardId);
						}
					}
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.change-west-workspace', async (node: ZephyrApplicationWestWorkspaceTreeItem | ZephyrApplicationTreeItem) => {
			if (node.project) {
				if (node.project.isWestWorkspaceApplication) {
					vscode.window.showInformationMessage('West workspace applications are scoped by their containing workspace.');
					return;
				}
				const westWorkspacePath = await changeWestWorkspaceQuickStep(context, node.project);
				if (westWorkspacePath) {
					await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, node.project.appWorkspaceFolder).update(
						ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY,
						westWorkspacePath,
						vscode.ConfigurationTarget.WorkspaceFolder,
					);
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"zephyr-workbench-app-explorer.change-toolchain",
			async (node: ZephyrApplicationTreeItem) => {
				if (!node.project) { return; }

				const pick = await changeToolchainQuickStep(context, node.project);
				if (!pick) { return; }

				if (pick.selectedVariant === "zephyr" || pick.selectedVariant === "zephyr/llvm") {
					await updateApplicationSettings(node.project, {
						[ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY]: pick.selectedVariant,
						[ZEPHYR_PROJECT_SDK_SETTING_KEY]: pick.zephyrSdkPath,
						[ZEPHYR_PROJECT_IAR_SETTING_KEY]: undefined,
						[ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY]: undefined,
					});

					if (pick.zephyrSdkPath) {
						const activeConfig = node.project.buildConfigs.find(config => config.active) ?? node.project.buildConfigs[0];
						if (activeConfig?.boardIdentifier) {
							try {
								const zephyrSdkInstallation = getZephyrSdkInstallation(pick.zephyrSdkPath);
								const westWorkspace = getWestWorkspace(node.project.westWorkspaceRootPath);
								const board = await getBoardFromIdentifier(
									activeConfig.boardIdentifier,
									westWorkspace,
									node.project,
									activeConfig
								);
								const socToolchainName = activeConfig.getKConfigValue(node.project, 'SOC_TOOLCHAIN_NAME');
								if (isSelectedIntelliSenseApplication(node.project)) {
									await updateCppToolsConfiguration(node.project.appWorkspaceFolder, {
										compilerPath: zephyrSdkInstallation.getCompilerPath(board.arch, socToolchainName, pick.selectedVariant),
									});
								}
							} catch {
								// Keep the variant change even if the compiler path cannot be refreshed yet.
							}
						}
					}
				} else if (pick.selectedVariant === 'gnuarmemb') {
					const armGnuToolchainInstallation = pick.armGnuToolchainPath ? findArmGnuToolchainInstallation(pick.armGnuToolchainPath) : undefined;
					if (!armGnuToolchainInstallation) {
						vscode.window.showErrorMessage("The selected Arm GNU toolchain could not be found.");
						return;
					}

					await updateApplicationSettings(node.project, {
						[ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY]: armGnuToolchainInstallation.toolchainPath,
						[ZEPHYR_PROJECT_SDK_SETTING_KEY]: undefined,
						[ZEPHYR_PROJECT_IAR_SETTING_KEY]: undefined,
						[ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY]: "gnuarmemb",
					});

					try {
						if (isSelectedIntelliSenseApplication(node.project)) {
							await updateCppToolsConfiguration(node.project.appWorkspaceFolder, {
								compilerPath: armGnuToolchainInstallation.compilerPath,
							});
						}
					} catch {
						// Keep the toolchain change even if the compiler path cannot be refreshed yet.
					}
				} else {
					const iarToolchainInstallation = pick.iarToolchainPath ? findIarToolchainInstallation(pick.iarToolchainPath) : undefined;
					await updateApplicationSettings(node.project, {
						[ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY]: "iar",
						[ZEPHYR_PROJECT_IAR_SETTING_KEY]: pick.iarToolchainPath,
						[ZEPHYR_PROJECT_SDK_SETTING_KEY]: iarToolchainInstallation?.zephyrSdkPath,
						[ZEPHYR_PROJECT_ARM_GNU_TOOLCHAIN_SETTING_KEY]: undefined,
					});
					if (pick.iarToolchainPath) {
						try {
							if (iarToolchainInstallation) {
								if (isSelectedIntelliSenseApplication(node.project)) {
									await updateCppToolsConfiguration(node.project.appWorkspaceFolder, {
										compilerPath: iarToolchainInstallation.compilerPath,
									});
								}
							}
						} catch {
							// Keep the toolchain change even if the compiler path cannot be refreshed yet.
						}
					}
				}
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.sysbuild.enable', async (node: any) => {
			if (node instanceof ZephyrConfigTreeItem) {
				node.buildConfig.sysbuild = 'true';
				await saveApplicationConfigSetting(node.project, node.buildConfig.name, ZEPHYR_BUILD_CONFIG_SYSBUILD_SETTING_KEY, 'true');
				await updateBuildConfigCompileCommandsSetting(node.project, node.buildConfig, true);
			} else if (node.project) {
				const targetConfig = getActiveOrDefaultBuildConfig(node.project);
				if (targetConfig) {
					targetConfig.sysbuild = 'true';
					await saveApplicationConfigSetting(node.project, targetConfig.name, ZEPHYR_BUILD_CONFIG_SYSBUILD_SETTING_KEY, 'true');
					await updateBuildConfigCompileCommandsSetting(node.project, targetConfig, true);
				}
			}
			vscode.window.showInformationMessage("Sysbuild enabled.");
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.sysbuild.disable', async (node: any) => {
			if (node instanceof ZephyrConfigTreeItem) {
				node.buildConfig.sysbuild = 'false';
				await saveApplicationConfigSetting(node.project, node.buildConfig.name, ZEPHYR_BUILD_CONFIG_SYSBUILD_SETTING_KEY, 'false');
				await updateBuildConfigCompileCommandsSetting(node.project, node.buildConfig, false);
			} else if (node.project) {
				const targetConfig = getActiveOrDefaultBuildConfig(node.project);
				if (targetConfig) {
					targetConfig.sysbuild = 'false';
					await saveApplicationConfigSetting(node.project, targetConfig.name, ZEPHYR_BUILD_CONFIG_SYSBUILD_SETTING_KEY, 'false');
					await updateBuildConfigCompileCommandsSetting(node.project, targetConfig, false);
				}
			}
			vscode.window.showInformationMessage("Sysbuild disabled.");
		})
	);


	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.open-terminal', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem | ZephyrApplication | vscode.Uri) => {
			let workspaceFolder: vscode.WorkspaceFolder | undefined;
			let project: ZephyrApplication | undefined;
			if (node instanceof ZephyrApplicationTreeItem) {
				if (node.project) {
					if (node.project.buildConfigs && node.project.buildConfigs.length === 1) {
						let terminal: vscode.Terminal = ZephyrBuildConfig.getTerminal(node.project, node.project.buildConfigs[0]);
						terminal.show();
					} else {
						let terminal: vscode.Terminal = ZephyrApplication.getTerminal(node.project);
						terminal.show();
					}
				}
			} else if (node instanceof ZephyrConfigTreeItem) {
				if (node.buildConfig) {
					let terminal: vscode.Terminal = ZephyrBuildConfig.getTerminal(node.project, node.buildConfig);
					terminal.show();
				}
			} else if (node instanceof ZephyrApplication) {
				if (node.buildConfigs && node.buildConfigs.length === 1) {
					let terminal: vscode.Terminal = ZephyrBuildConfig.getTerminal(node, node.buildConfigs[0]);
					terminal.show();
				} else {
					let terminal: vscode.Terminal = ZephyrApplication.getTerminal(node);
					terminal.show();
				}
			}
			else if ((node as vscode.Uri).fsPath) {
				workspaceFolder = vscode.workspace.getWorkspaceFolder(node as vscode.Uri) || undefined;
				if (!workspaceFolder) {
					vscode.window.showInformationMessage("No workspace folder found for the selected path.");
					return;
				}
				const isWestWorkspace = WestWorkspace.isWestWorkspaceFolder(workspaceFolder);
				if (isWestWorkspace) {
					const entry = findContainingWorkspaceApplicationEntry(workspaceFolder, (node as vscode.Uri).fsPath);
					const appPath = entry ? resolveWorkspaceApplicationPath(entry, workspaceFolder) : undefined;
					project = entry && appPath
						? new ZephyrApplication(workspaceFolder, appPath, { workspaceApplicationSettings: entry })
						: undefined;
				} else {
					project = await getZephyrApplication((node as vscode.Uri).fsPath);
				}
				if (project) {
					if (project.buildConfigs && project.buildConfigs.length === 1) {
						let terminal: vscode.Terminal = ZephyrBuildConfig.getTerminal(project, project.buildConfigs[0]);
						terminal.show();
					}
					else {
						let terminal: vscode.Terminal = ZephyrApplication.getTerminal(project);
						terminal.show();
					}
				}
				else if (isWestWorkspace) {
					const westWorkspace = getWestWorkspace(workspaceFolder.uri.fsPath);
					let terminal: vscode.Terminal = WestWorkspace.getTerminal(westWorkspace);
					terminal.show();
				}
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.memory-analysis.ram-report', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem | vscode.WorkspaceFolder) => {
			await executeConfigTask('West RAM Report', node);
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.memory-analysis.rom-report', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem | vscode.WorkspaceFolder) => {
			await executeConfigTask('West ROM Report', node);
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.memory-analysis.ram-plot', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem | vscode.WorkspaceFolder) => {
			let taskExec = await executeConfigTask('West RAM Plot', node);
			const taskStartListener = vscode.tasks.onDidStartTask(async (event) => {
				if (taskExec && event.execution === taskExec[0]) {
					const stopItem = 'Terminate';
					const choice = await vscode.window.showWarningMessage('RAM Plot server is running...', stopItem);
					if (choice === stopItem) {
						taskExec[0].terminate();
						taskStartListener.dispose();
					};
				}
			});
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.memory-analysis.rom-plot', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem | vscode.WorkspaceFolder) => {
			let taskExec = await executeConfigTask('West ROM Plot', node);
			const taskStartListener = vscode.tasks.onDidStartTask(async (event) => {
				if (taskExec && event.execution === taskExec[0]) {
					const stopItem = 'Terminate';
					const choice = await vscode.window.showWarningMessage('ROM Plot server is running...', stopItem);
					if (choice === stopItem) {
						taskExec[0].terminate();
						taskStartListener.dispose();
					};
				}
			});
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.memory-analysis.puncover', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem | vscode.WorkspaceFolder) => {
			let taskExec = await executeConfigTask('West Puncover', node);
			const taskStartListener = vscode.tasks.onDidStartTask(async (event) => {
				if (taskExec && event.execution === taskExec[0]) {
					const stopItem = 'Terminate';
					const choice = await vscode.window.showWarningMessage('Puncover server is running...', stopItem);
					if (choice === stopItem) {
						taskExec[0].terminate();
						taskStartListener.dispose();
					};
				}
			});
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.add-config', async (node: ZephyrApplicationTreeItem) => {
			if (node.project) {
				let newConfig = new ZephyrBuildConfig();
				let configName = await setConfigQuickStep(newConfig, node.project);
				if (configName) {
					newConfig.active = false;
					newConfig.name = configName;
					let boardId = await changeBoardQuickStep(context, node.project);
					if (boardId) {
						newConfig.boardIdentifier = boardId;
						node.project.addBuildConfiguration(newConfig);
						await addApplicationConfig(node.project, newConfig);
					}
				}
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.add-custom-task', async (node: ZephyrApplicationTreeItem) => {
			if (!node.project) {
				return;
			}

			await checkAndCreateTasksJson(node.project.appWorkspaceFolder);

			const taskDefinition = await promptCustomTaskDefinition(node.project);
			if (!taskDefinition) {
				return;
			}

			let result = await saveCustomTaskDefinition(node.project.appWorkspaceFolder, taskDefinition);
			if (result.status === 'conflict') {
				const overwrite = await showConfirmMessage(`A task named "${taskDefinition.label}" already exists in this application. Replace it?`);
				if (!overwrite) {
					return;
				}

				result = await saveCustomTaskDefinition(node.project.appWorkspaceFolder, taskDefinition, { overwrite: true });
			}

			const openTasksJsonItem = 'Open tasks.json';
			const message = result.status === 'updated'
				? `Custom task "${taskDefinition.label}" updated.`
				: `Custom task "${taskDefinition.label}" added.`;
			const choice = await vscode.window.showInformationMessage(message, openTasksJsonItem);

			if (choice === openTasksJsonItem) {
				const document = await vscode.workspace.openTextDocument(vscode.Uri.file(result.tasksJsonPath));
				await vscode.window.showTextDocument(document);
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.select-application', async (node: ZephyrApplicationTreeItem | WestWorkspaceApplicationTreeItem) => {
			if (node instanceof WestWorkspaceApplicationTreeItem) {
				const workspaceFolder = getWorkspaceFolder(node.westWorkspace.rootUri.fsPath);
				if (!workspaceFolder) {
					return;
				}
				await setSelectedWorkspaceApplicationPath(workspaceFolder, node.appRootPath);
				const project = await getZephyrApplication(node.appRootPath).catch(() => undefined);
				const targetConfig = project ? getActiveOrDefaultBuildConfig(project) : undefined;
				if (project && targetConfig) {
					await updateBuildConfigCompileCommandsSetting(project, targetConfig);
				}
				zephyrAppProvider.refresh();
				westWorkspaceProvider.refresh();
				void dashboardViewProvider.refresh();
				return;
			}

			if (!node?.project?.isWestWorkspaceApplication) {
				vscode.window.showInformationMessage('Only West workspace applications need workspace-level selection.');
				return;
			}

			await setSelectedWorkspaceApplicationPath(node.project.appWorkspaceFolder, node.project.appRootPath);
			const targetConfig = getActiveOrDefaultBuildConfig(node.project);
			if (targetConfig) {
				await updateBuildConfigCompileCommandsSetting(node.project, targetConfig);
			}
			zephyrAppProvider.refresh();
			westWorkspaceProvider.refresh();
			void dashboardViewProvider.refresh();
		})
	);
	// Status-bar entry point for changing the selected west workspace application.
	// Resolves the west workspace from the active editor (rather than from a tree
	// node) and shows a quick pick scoped to that workspace's declared apps.
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench.select-workspace-application', async () => {
			const activeUri = vscode.window.activeTextEditor?.document.uri;
			if (!activeUri) {
				vscode.window.showInformationMessage('Open a file in a west workspace to pick its application.');
				return;
			}

			const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeUri);
			if (!workspaceFolder || !WestWorkspace.isWestWorkspaceFolder(workspaceFolder)) {
				vscode.window.showInformationMessage('The active file is not inside a west workspace.');
				return;
			}

			// Read entries straight from settings so the quick pick reflects every
			// declared app, including ones that don't yet have a prj.conf on disk
			// (filtering by isApplicationPathLike happens in getApplications).
			const entries = readWorkspaceApplicationEntries(workspaceFolder);
			if (entries.length === 0) {
				vscode.window.showInformationMessage('No west workspace applications are declared in this workspace.');
				return;
			}

			const effectiveEntry = getEffectiveWorkspaceApplicationEntry(workspaceFolder);
			const effectivePath = effectiveEntry
				? resolveWorkspaceApplicationPath(effectiveEntry, workspaceFolder)
				: undefined;
			const normalizedEffectivePath = effectivePath ? path.normalize(effectivePath) : undefined;

			type AppPickItem = vscode.QuickPickItem & { appRootPath: string };
			const items: AppPickItem[] = entries.flatMap(entry => {
				const appPath = resolveWorkspaceApplicationPath(entry, workspaceFolder);
				if (!appPath) {
					return [];
				}
				const isSelected = normalizedEffectivePath === path.normalize(appPath);
				return [{
					// `$(check)` marks the currently-selected app so the user can see
					// the current state without opening the tree view.
					label: `${isSelected ? '$(check) ' : ''}${path.basename(appPath)}`,
					description: path.relative(workspaceFolder.uri.fsPath, appPath).replace(/\\/g, '/') || '.',
					detail: appPath,
					appRootPath: appPath,
				}];
			});

			const picked = await vscode.window.showQuickPick<AppPickItem>(items, {
				title: `Select application for ${workspaceFolder.name}`,
				placeHolder: 'Pick the west workspace application to use',
				ignoreFocusOut: true,
				canPickMany: false,
			});
			if (!picked) {
				return;
			}

			// Reuse the same downstream side-effects as the tree-driven command:
			// persist the selection, refresh IntelliSense for the newly active app,
			// and refresh views/status bar so all surfaces agree.
			await setSelectedWorkspaceApplicationPath(workspaceFolder, picked.appRootPath);
			const project = await getZephyrApplication(picked.appRootPath).catch(() => undefined);
			const targetConfig = project ? getActiveOrDefaultBuildConfig(project) : undefined;
			if (project && targetConfig) {
				await updateBuildConfigCompileCommandsSetting(project, targetConfig);
			}
			zephyrAppProvider.refresh();
			westWorkspaceProvider.refresh();
			void dashboardViewProvider.refresh();
			updateStatusBar();
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.delete-config', async (node: ZephyrConfigTreeItem) => {
			if (node.project.buildConfigs.length <= 1) {
				vscode.window.showErrorMessage("One build configuration is required, firstly create a new one before deleting.");
			} else {
				if (node.buildConfig) {
					let confirm = await showConfirmMessage("Are you sure you want to delete this configuration ?");
					if (confirm) {
						await deleteApplicationConfig(node.project, node.buildConfig);
					}
				}
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.rename-config', async (node: ZephyrConfigTreeItem) => {
			if (node.buildConfig) {
				const oldConfigName = node.buildConfig.name;
				let newConfigName = await setConfigQuickStep(node.buildConfig, node.project);
				if (newConfigName) {
					node.buildConfig.name = newConfigName;
					await saveApplicationConfigSetting(node.project, oldConfigName, 'name', newConfigName);
				}
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.activate-config', async (node: ZephyrConfigTreeItem) => {
			if (node.buildConfig) {
				node.buildConfig.active = true;

				let activeIndex = 0;
				for (let configIndex = 0; configIndex < node.project.buildConfigs.length; configIndex++) {
					if (node.project.buildConfigs[configIndex].name !== node.buildConfig.name) {
						await saveApplicationConfigSetting(node.project, node.project.buildConfigs[configIndex].name, 'active', '');
					} else {
						await saveApplicationConfigSetting(node.project, node.buildConfig.name, 'active', 'true');
						await updateBuildConfigCompileCommandsSetting(node.project, node.buildConfig);
						activeIndex = configIndex;
					}
				}
				updateTasks(node.project.appWorkspaceFolder, node.buildConfig.name, activeIndex);
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.deactivate-config', async (node: ZephyrConfigTreeItem) => {
			if (node.buildConfig) {
				node.buildConfig.active = true;
				await saveApplicationConfigSetting(node.project, node.buildConfig.name, 'active', "");
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-west-workspace.open-terminal', async (node: WestWorkspaceTreeItem) => {
			if (node.westWorkspace) {
				let terminal: vscode.Terminal = WestWorkspace.getTerminal(node.westWorkspace);
				terminal.show();
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-west-workspace.install-python-deps", async (node: WestWorkspaceTreeItem) => {
			if (!node?.westWorkspace) { return; }
			await westPackagesInstallCommand(node.westWorkspace.rootUri.fsPath);
		}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-west-workspace.update', async (node: WestWorkspaceTreeItem) => {
			if (node.westWorkspace) {
				try {
					await westUpdateCommand(node.westWorkspace.rootUri.fsPath);
					await westBoardsCommand(node.westWorkspace.rootUri.fsPath);
				} finally {
					westWorkspaceProvider.refresh();
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-west-workspace.delete", async (node: WestWorkspaceTreeItem) => {
			if (node.westWorkspace) {
				if (await showConfirmMessage(`Delete ${node.westWorkspace.name} permanently ?`)) {
					vscode.window.withProgress({
						location: vscode.ProgressLocation.Notification,
						title: "Deleting West Workspace",
						cancellable: false,
					}, async () => {
						let workspaceFolder = getWorkspaceFolder(node.westWorkspace.rootUri.fsPath);
						if (workspaceFolder) {
							removeWorkspaceFolder(workspaceFolder);
							deleteFolder(node.westWorkspace.rootUri.fsPath);
						}
					}
					);
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench.env.add", async (node: any) => {
			if (node instanceof WestWorkspaceEnvTreeItem) {
				if (node.westWorkspace) {
					const westWorkspace = node.westWorkspace;
					let value = await changeEnvVarQuickStep(westWorkspace, node.envKey);
					if (value) {
						addEnvValue(westWorkspace.envVars, node.envKey, value);
						let workspaceFolder = getWorkspaceFolder(westWorkspace.rootUri.fsPath);
						if (workspaceFolder) {
							await saveEnv(workspaceFolder, node.envKey, westWorkspace.envVars[node.envKey]);
						}
					}
					westWorkspaceProvider.refresh();
				}
			} else if (node instanceof ZephyrApplicationEnvTreeItem) {
				if (node.project) {
					const project = node.project;
					let value = await changeEnvVarQuickStep(project, node.envKey);
					if (value) {
						addEnvValue(project.envVars, node.envKey, value);
						await saveApplicationEnv(project, node.envKey, project.envVars[node.envKey]);
					}
					zephyrAppProvider.refresh();
				}
			} else if (node instanceof ZephyrConfigEnvTreeItem) {
				if (node.config) {
					const project = node.project;
					const config = node.config;
					let value = await changeEnvVarQuickStep(config, node.envKey, node.project);
					if (value) {
						addEnvValue(config.envVars, node.envKey, value);
						await saveApplicationConfigEnv(project, config.name, node.envKey, config.envVars[node.envKey]);
					}
					zephyrAppProvider.refresh();
				}
			} else if (node instanceof ZephyrConfigWestFlagsDTreeItem) {
				if (node.config) {
					const project = node.project;
					const config = node.config;
					const value = await changeEnvVarQuickStep(config, WEST_FLAGS_D_LABEL);
					if (value) {
						addWestFlagDValue(config, value);
						await saveApplicationConfigSetting(project, config.name, ZEPHYR_BUILD_CONFIG_WEST_FLAGS_D_SETTING_KEY, config.westFlagsD);
					}
					zephyrAppProvider.refresh();
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench.env.edit", async (node: any) => {
			if (node instanceof WestWorkspaceEnvValueTreeItem) {
				if (node.westWorkspace) {
					const westWorkspace = node.westWorkspace;
					let value = await changeEnvVarQuickStep(westWorkspace, node.envKey, node.envValue);
					if (value) {
						replaceEnvValue(westWorkspace.envVars, node.envKey, node.envValue, value);
						let workspaceFolder = getWorkspaceFolder(westWorkspace.rootUri.fsPath);
						if (workspaceFolder) {
							await saveEnv(workspaceFolder, node.envKey, westWorkspace.envVars[node.envKey]);
						}
					}
					westWorkspaceProvider.refresh();
				}
			} else if (node instanceof ZephyrApplicationEnvValueTreeItem) {
				if (node.project) {
					const project = node.project;
					let value = await changeEnvVarQuickStep(project, node.envKey, node.envValue);
					if (value) {
						replaceEnvValue(project.envVars, node.envKey, node.envValue, value);
						await saveApplicationEnv(project, node.envKey, project.envVars[node.envKey]);
					}
					zephyrAppProvider.refresh();
				}
			} else if (node instanceof ZephyrConfigEnvValueTreeItem) {
				if (node.config) {
					const project = node.project;
					const config = node.config;
					let value = await changeEnvVarQuickStep(project, node.envKey, node.envValue);
					if (value) {
						replaceEnvValue(config.envVars, node.envKey, node.envValue, value);
						await saveApplicationConfigEnv(project, config.name, node.envKey, config.envVars[node.envKey]);
					}
					zephyrAppProvider.refresh();
				}
			} else if (node instanceof ZephyrConfigWestFlagsDValueTreeItem) {
				if (node.config) {
					const project = node.project;
					const config = node.config;
					const value = await changeEnvVarQuickStep(config, WEST_FLAGS_D_LABEL, node.flagValue);
					if (value && replaceWestFlagDValue(config, node.flagValue, value)) {
						await saveApplicationConfigSetting(project, config.name, ZEPHYR_BUILD_CONFIG_WEST_FLAGS_D_SETTING_KEY, config.westFlagsD);
					}
					zephyrAppProvider.refresh();
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench.env.delete", async (node: any) => {
			if (node instanceof WestWorkspaceEnvValueTreeItem) {
				if (node.westWorkspace) {
					const westWorkspace = node.westWorkspace;
					removeEnvValue(westWorkspace.envVars, node.envKey, node.envValue);
					let workspaceFolder = getWorkspaceFolder(westWorkspace.rootUri.fsPath);
					if (workspaceFolder) {
						await saveEnv(workspaceFolder, node.envKey, westWorkspace.envVars[node.envKey]);
					}
					westWorkspaceProvider.refresh();
				}
			} else if (node instanceof ZephyrApplicationEnvValueTreeItem) {
				if (node.project) {
					const project = node.project;
					removeEnvValue(project.envVars, node.envKey, node.envValue);
					await saveApplicationEnv(project, node.envKey, project.envVars[node.envKey]);
					zephyrAppProvider.refresh();
				}
			} else if (node instanceof ZephyrConfigEnvValueTreeItem) {
				if (node.config) {
					const project = node.project;
					const config = node.config;
					removeEnvValue(config.envVars, node.envKey, node.envValue);
					await saveApplicationConfigEnv(project, config.name, node.envKey, config.envVars[node.envKey]);
					zephyrAppProvider.refresh();
				}
			} else if (node instanceof ZephyrConfigWestFlagsDValueTreeItem) {
				if (node.config) {
					const project = node.project;
					const config = node.config;
					if (removeWestFlagDValue(config, node.flagValue)) {
						await saveApplicationConfigSetting(project, config.name, ZEPHYR_BUILD_CONFIG_WEST_FLAGS_D_SETTING_KEY, config.westFlagsD);
					}
					zephyrAppProvider.refresh();
				}
			}
		})
	);

	context.subscriptions.push(
		// The action should be able to modify argument and string environment variable
		vscode.commands.registerCommand("zephyr-workbench.arg.edit", async (node: any) => {
			if (node.project) {
				const project = node.project;
				let context = node.project;
				if (node.config) {
					context = node.config;
				}

				let value = await changeEnvVarQuickStep(context, node.argName, node.argValue);
				if (value !== undefined) {
					value = normalizeSlashesIfPath(value);
					node.argValue = value;
					if (node.argSetting) {
						await saveApplicationConfigSetting(project, context.name, node.argSetting, node.argValue);
					} else {
						await saveApplicationConfigEnv(project, context.name, node.argName, node.argValue);
					}
				}
				zephyrAppProvider.refresh();
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"zephyr-workbench.install-host-tools",
			async (force = false,
				listToolchains = "") => {

				return vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Installing host tools",
						cancellable: true,
					},
					async (progress, token) => {
						// Close deprecated SDK Manager panel if open (no-op as panel removed)

                        if (!force) {
                            await runInstallHostTools(
                                context, listToolchains, progress, token);
                        } else {
                            await forceInstallHostTools(
                                context, listToolchains, progress, token);
                        }

                        toolchainInstallationsProvider.refresh();
                        zephyrShortcutProvider.refresh();
                        zephyrToolsCommandProvider.refresh();
                        // If Host Tools Manager is open, refresh its content
                        try { HostToolsPanel.currentPanel?.refresh(); } catch {}

                        // After host tools progress ends, start a new progress for OpenOCD installation
                        try {
                            let didOpenOCD = false;
                            if (await checkHostTools() && await checkEnvFile()) {
                                await vscode.window.withProgress(
                                    {
                                        location: vscode.ProgressLocation.Notification,
                                        title: 'Installing OpenOCD runner',
                                        cancellable: false,
                                    },
                                    async () => {
                                        await installOpenOcdRunnerSilently(context);
                                        didOpenOCD = true;
                                    }
                                );
                            }

                            // When everything finishes, offer quick entry to install more runners.
                            // Use an information message with an action, and a 10s status bar item fallback.
                            const action = 'Install Runners';
                            vscode.window.showInformationMessage(
                                didOpenOCD
                                  ? 'OpenOCD is installed. You can install additional runners.'
                                  : 'You can install additional runners.',
                                action
                            ).then(async (choice) => {
                                if (choice === action) {
                                    try { await vscode.commands.executeCommand('zephyr-workbench.install-runners'); } catch {}
                                }
                            });

                            try {
                                const sbi = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
                                sbi.text = '$(tools) Install Runners';
                                sbi.tooltip = 'Open Install Runners manager to install additional runners';
                                sbi.command = 'zephyr-workbench.install-runners';
                                sbi.show();
                                setTimeout(() => { try { sbi.dispose(); } catch {} }, 10000);
                            } catch {}
                        } catch {}
					}
				);
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"zephyr-workbench.install-host-tools.open-manager",
			async (force = false) => {

				if (process.platform === "darwin") {
					try {
						if (!(await checkHomebrew())) {
							vscode.window.showErrorMessage(
								"Homebrew is not installed or not in your PATH. " +
								"Please install it first.");
							return;
						}
					} catch {
						vscode.window.showErrorMessage(
							"Homebrew is not installed or not in your PATH. " +
							"Please install it first.");
						return;
					}
				}

				if (force) {
					const yes = await showConfirmMessage(
						"Are you sure you want to reinstall the host tools ?");
					if (!yes) { return; }
				}

				return vscode.commands.executeCommand(
					"zephyr-workbench.install-host-tools",
					force,
					""
				);
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"zephyr-workbench.host-tools-manager",
			async () => {
				HostToolsPanel.render(context.extensionUri);
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench.reinstall-venv", async (force = false) => {
			vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "Reinstalling Virtual environment",
				cancellable: false,
			}, async () => {
				await installVenv(context);
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench.verify-host-tools", async () => {
			vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "Verify host tools",
				cancellable: true,
			}, async () => {
				try {
					await verifyHostTools(context);
					// Refresh Host Tools Manager to reflect parsed versions from check output
					try { HostToolsPanel.currentPanel?.refresh(); } catch {}
				} catch (error) {

					if (error instanceof Error) {
						if ((error as any).cause.startsWith(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)) {
							const openSettingItem = 'Open Setting';
							const choice = await vscode.window.showErrorMessage(`Fail verifying tools...\n${error}`, openSettingItem);
							if (choice === openSettingItem) {
								vscode.commands.executeCommand('workbench.action.openSettings', (error as any).cause);
							}
						} else {
							vscode.window.showErrorMessage(`Fail verifying tools...\n${error}`);
						}
					}
				}
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench.install-runners", async () => {
			DebugToolsPanel.render(context.extensionUri);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench.debug-manager", async (node: any) => {
			let project = undefined;
			let buildConfig = undefined;
			if (node) {
				if (node.project) {
					project = node.project;
				}
				if (node.buildConfig) {
					buildConfig = node.buildConfig;
				}
			}
			DebugManagerPanel.render(context.extensionUri, project, buildConfig);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench.debug-manager.debug", async (
			target: vscode.WorkspaceFolder | ZephyrApplication,
			configName: string,
			appRootPath?: string,
		) => {
			let folder: vscode.WorkspaceFolder | undefined;
			let project: ZephyrApplication | undefined;
			if (target instanceof ZephyrApplication) {
				project = target;
				folder = target.appWorkspaceFolder;
			} else if ((target as vscode.WorkspaceFolder)?.uri) {
				folder = target as vscode.WorkspaceFolder;
			}
			if (!project && appRootPath) {
				project = await getZephyrApplication(appRootPath).catch(() => undefined);
			}

			DebugManagerPanel.currentPanel?.dispose();
			if (project?.isWestWorkspaceApplication) {
				const buildConfigName = extractDebugBuildConfigName(configName);
				const [, launchConfiguration] = await getLaunchConfiguration(project, buildConfigName);
				if (launchConfiguration) {
					await setSelectedWorkspaceApplicationPath(project.appWorkspaceFolder, project.appRootPath);
					await vscode.debug.startDebugging(project.appWorkspaceFolder, {
						...launchConfiguration,
						[ZEPHYR_WORKBENCH_DEBUG_APP_ROOT_KEY]: project.appRootPath,
					});
					return;
				}
			}
			if (folder) {
				await vscode.debug.startDebugging(folder, configName);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench.run-install-debug-tools", async (panel, listTools) => {
			vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "Download and install debug host tools",
				cancellable: false,
			}, async (progress, token) => {
				await installHostDebugTools(context, listTools);

				// Auto detect tools after installation
				for (let tool of listTools) {
					let runner = getRunner(tool.tool);

					if (runner && runner.executable) {
						let runnerPath = path.join(getInternalToolsDirRealPath(), runner.name, runner.binDirPath, runner.executable);
						if (fileExists(runnerPath)) {
							runner.serverPath = runnerPath;
							await runner.updateSettings();
						}
					}
					panel.webview.postMessage({ command: 'exec-done', tool: `${tool.tool}` });
				}

				// Notify webview that the whole install batch has finished (single or pack)
				panel.webview.postMessage({ command: 'exec-install-finished' });
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-sdk-explorer.open-wizard", async () => {
			// Mirror the same guard used for creating a West workspace
			if (await checkHostTools() && await checkEnvFile()) {
				ImportZephyrSDKPanel.render(context.extensionUri);
			} else {
				const installHostToolsItem = 'Install Host Tools';
				const choice = await vscode.window.showErrorMessage(
					"Host tools are missing, please install them first",
					installHostToolsItem
				);
				if (choice === installHostToolsItem) {
					vscode.commands.executeCommand('zephyr-workbench.install-host-tools.open-manager');
				}
				return;
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-sdk-explorer.import-official-sdk", async (sdkType, sdkVersion, listToolchains, parentPath, includeLlvm = false) => {
			if (!parentPath) {
				vscode.window.showErrorMessage("No folder path was provided.");
				return;
			}	
			try {
				if (!fs.existsSync(parentPath)) {
					fs.mkdirSync(parentPath, { recursive: true });
				}
			} catch (err: any) {
				vscode.window.showErrorMessage(`Failed to create folder: ${err.message}`);
				return;
			}
			if (sdkType && sdkVersion && parentPath) {
				ImportZephyrSDKPanel.currentPanel?.dispose();
				vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: "Importing Zephyr SDK",
					cancellable: true,
				}, async (progress, token) => {
					let toolchains = listToolchains.split(' ');
					let urls = generateSdkUrls(sdkType, sdkVersion, toolchains, includeLlvm);

					try {
						let url = urls[0];
						if (url) {
							// Download SDK then extract SDK and get the first level extracted folder
							progress.report({
								message: `Download ${url}`,
								increment: 0,
							});
							let downloadedFileUri = await download(url, parentPath, context, progress, token);

							progress.report({
								message: `Extracting ${downloadedFileUri}`,
								increment: 40,
							});
							let zephyrSDKPath = await extractSDK(downloadedFileUri.fsPath, parentPath, progress, token);

							// If toolchain urls exist, download them
							if (urls.length > 1) {
								const gnuToolchainDestPath =
									(sdkVersion.startsWith('1.') || sdkVersion.startsWith('v1.'))
										? path.join(zephyrSDKPath, 'gnu')
										: zephyrSDKPath;
								if (!fs.existsSync(gnuToolchainDestPath)) {
									fs.mkdirSync(gnuToolchainDestPath, { recursive: true });
								}
								for (let i = 1; i < urls.length; i++) {
									progress.report({
										message: `Download ${urls[i]}`,
									});
									let downloadedFileUri = await download(urls[i], parentPath, context, progress, token);
									progress.report({
										message: `Extracting ${downloadedFileUri}`,
									});
									// LLVM archive already contains its llvm/ top-level folder; extract at SDK root.
									const isLlvm = urls[i].includes('/toolchain_llvm_');
									const destPath = isLlvm ? zephyrSDKPath : gnuToolchainDestPath;
									await extractSDK(downloadedFileUri.fsPath, destPath, progress, token);
								}
							}

							progress.report({
								message: `Importing SDK done`,
								increment: 60,
							});

							// Register the SDK into settings
							if (zephyrSDKPath) {
								await registerZephyrSDK(zephyrSDKPath);
								await cleanupDownloadDir(context);
							}
						}
					} catch (e: any) {
						if (e.code === 'ERR_STREAM_PREMATURE_CLOSE') {
							vscode.window.showInformationMessage("Download cancelled");
						} else if (e.code === 'TAR_BAD_ARCHIVE') {
							vscode.window.showErrorMessage("Extracting SDK failed");
						} else {
							vscode.window.showErrorMessage("Download failed: " + e);
						}
					}
					progress.report({ message: 'Importing SDK done', increment: 100 });
					toolchainInstallationsProvider.refresh();
				});
			} else {
				vscode.window.showErrorMessage('Missing information to download SDK');
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-sdk-explorer.import-remote-sdk", async (remotePath, parentPath) => {
			if (!parentPath) {
				vscode.window.showErrorMessage("No folder path was provided.");
				return;
			}	
			try {
				if (!fs.existsSync(parentPath)) {
					fs.mkdirSync(parentPath, { recursive: true });
				}
			} catch (err: any) {
				vscode.window.showErrorMessage(`Failed to create folder: ${err.message}`);
				return;
			}
			if (remotePath && parentPath) {
				ImportZephyrSDKPanel.currentPanel?.dispose();
				vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: "Importing Zephyr SDK",
					cancellable: true,
				}, async (progress, token) => {
					try {
						if (remotePath && parentPath) {
							// Download SDK then extract SDK and get the first level extracted folder
							progress.report({
								message: `Download ${remotePath}`,
								increment: 0
							});
							let downloadedFileUri = await download(remotePath, parentPath, context, progress, token);

							progress.report({
								message: `Extracting ${downloadedFileUri}`,
							});
							let zephyrSDKPath = await extractSDK(downloadedFileUri.fsPath, parentPath, progress, token);
							// Register the SDK into settings
							if (zephyrSDKPath) {
								await registerZephyrSDK(zephyrSDKPath);
								await cleanupDownloadDir(context);
							}
						}
					} catch (e: any) {
						if (e.code === 'ERR_STREAM_PREMATURE_CLOSE') {
							vscode.window.showInformationMessage("Download cancelled");
						} else if (e.code === 'TAR_BAD_ARCHIVE') {
							vscode.window.showErrorMessage("Extracting SDK failed");
						} else {
							vscode.window.showErrorMessage("Download failed: " + e);
						}
					}
					progress.report({ message: 'Importing SDK done', increment: 100 });
					toolchainInstallationsProvider.refresh();
				});
			} else {
				vscode.window.showErrorMessage('Missing information to download SDK');
			}
		})
	);


	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-sdk-explorer.import-local-sdk", async (sdkPath) => {
			if (sdkPath) {
				ImportZephyrSDKPanel.currentPanel?.dispose();
				if (ZephyrSdkInstallation.isSdkPath(sdkPath)) {
					await registerZephyrSDK(sdkPath);
					toolchainInstallationsProvider.refresh();
					vscode.window.showInformationMessage("Importing SDK done.");

				} else {
					vscode.window.showErrorMessage("The folder is not a Zephyr SDK");
				}
			} else {
				vscode.window.showErrorMessage("The entered Zephyr SDK location folder is invalid or already exists");
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"zephyr-workbench-sdk-explorer.import-arm-gnu-toolchain",
			async (
				version: string,
				targetTriple: string,
				downloadUrl: string,
				folderName: string,
				parentPath?: string,
			) => {
				if (!parentPath) {
					vscode.window.showErrorMessage("Please provide a destination folder for the Arm GNU toolchain.");
					return;
				}

				if (!version || !targetTriple || !downloadUrl || !folderName) {
					vscode.window.showErrorMessage("Missing Arm GNU download information.");
					return;
				}

				const trimmedFolderName = folderName.trim();
				if (
					!trimmedFolderName ||
					trimmedFolderName === '.' ||
					trimmedFolderName === '..' ||
					path.basename(trimmedFolderName) !== trimmedFolderName
				) {
					vscode.window.showErrorMessage("Please provide a valid Arm GNU install subfolder name.");
					return;
				}

				const installPath = path.join(parentPath, trimmedFolderName);

				try {
					if (!fs.existsSync(parentPath)) {
						fs.mkdirSync(parentPath, { recursive: true });
					}
					if (fs.existsSync(installPath)) {
						const existingItems = fs.readdirSync(installPath);
						if (existingItems.length > 0) {
							vscode.window.showErrorMessage(`The destination folder already exists and is not empty: ${installPath}`);
							return;
						}
					} else {
						fs.mkdirSync(installPath, { recursive: true });
					}
				} catch (err: any) {
					vscode.window.showErrorMessage(`Failed to create folder: ${err.message}`);
					return;
				}

				ImportZephyrSDKPanel.currentPanel?.dispose();

				await vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: "Importing ARM GNU Toolchain",
					cancellable: true,
				}, async (progress, token) => {
					try {
						progress.report({
							message: `Download ${downloadUrl}`,
							increment: 0,
						});
						const downloadedFileUri = await download(downloadUrl, parentPath, context, progress, token);

						progress.report({
							message: `Extracting ${downloadedFileUri}`,
							increment: 60,
						});
						let toolchainPath = await extractSDK(downloadedFileUri.fsPath, installPath, progress, token);
						if (!ArmGnuToolchainInstallation.isArmGnuPath(toolchainPath) && ArmGnuToolchainInstallation.isArmGnuPath(installPath)) {
							toolchainPath = installPath;
						}

						if (toolchainPath) {
							if (!ArmGnuToolchainInstallation.isArmGnuPath(toolchainPath)) {
								throw new Error("The extracted folder is not a valid Arm GNU toolchain.");
							}
							await registerArmGnuToolchain({
								toolchainPath,
								targetTriple: targetTriple as 'arm-none-eabi' | 'aarch64-none-elf',
								version,
							});
							await cleanupDownloadDir(context);
						}

						progress.report({
							message: "Importing ARM GNU Toolchain done",
							increment: 40,
						});
						toolchainInstallationsProvider.refresh();
						vscode.window.showInformationMessage("ARM GNU toolchain imported.");
					} catch (e: any) {
						if (e.code === 'ERR_STREAM_PREMATURE_CLOSE') {
							vscode.window.showInformationMessage("Download cancelled");
						} else if (e.code === 'TAR_BAD_ARCHIVE') {
							vscode.window.showErrorMessage("Extracting ARM GNU toolchain failed");
						} else {
							vscode.window.showErrorMessage("Download failed: " + e);
						}
					}
				});
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"zephyr-workbench-sdk-explorer.import-iar-sdk",
			async (
				iarZephyrSdkPath: string,
				token: string,
				iarPath?: string
			) => {
				if (!iarPath) {
					vscode.window.showErrorMessage(
						"Please provide IAR SDK path."
					);
					return;
				}

				let candidate = iarPath;
				if (path.basename(candidate).toLowerCase() === "arm") {
					const parent = path.dirname(candidate);
					if (fs.existsSync(path.join(parent, "common"))) {
						candidate = parent;
					}
				}
				iarPath = candidate;

				if (!IarToolchainInstallation.isIarPath(iarPath)) {
					vscode.window.showErrorMessage("The folder is not a valid IAR SDK.");
					return;
				}

				if (!token) {
					vscode.window.showInformationMessage("No IAR_LMS_BEARER_TOKEN provided. Using perpetual license.");
				}

				ImportZephyrSDKPanel.currentPanel?.dispose();

				await registerIARToolchain({
					zephyrSdkPath: iarZephyrSdkPath,
					iarPath: iarPath,
					token,
				});

				toolchainInstallationsProvider.refresh();
				vscode.window.showInformationMessage("IAR toolchain imported.");
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-sdk-explorer.remove-sdk", async (node: ToolchainInstallationTreeItem) => {
			if (node.installation) {
				if (await showConfirmMessage(`Remove ${node.installation.name} from workspace?`)) {
					if (node.installation instanceof ZephyrSdkInstallation) {
						await unregisterZephyrSDK(node.installation.rootUri.fsPath);
						toolchainInstallationsProvider.refresh();
					} else {
						vscode.window.showWarningMessage("Cannot remove IAR Toolchain using this command.");
					}
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-sdk-explorer.delete", async (node: ToolchainInstallationTreeItem) => {
			if (!node.installation) {return;}

			if (await showConfirmMessage(`Delete ${node.installation.name} permanently?`)) {
				if (node.installation instanceof ZephyrSdkInstallation) {
					const sdkPath = node.installation.rootUri.fsPath;

					vscode.window.withProgress(
						{
							location: vscode.ProgressLocation.Notification,
							title: "Deleting Zephyr SDK",
							cancellable: false,
						},
						async () => {
							await unregisterZephyrSDK(sdkPath);
							deleteFolder(sdkPath);
							toolchainInstallationsProvider.refresh();
						}
					);
				} else {
					vscode.window.showWarningMessage(
						"Cannot delete IAR Toolchain from disk. Please remove it manually."
					);
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"zephyr-workbench-sdk-explorer.remove-iar",
			async (node: ToolchainInstallationTreeItem) => {
				if (!node.installation || !(node.installation instanceof IarToolchainInstallation)) {return;}

				if (await showConfirmMessage(`Remove ${node.installation.name} from workspace?`)) {
					await unregisterIARToolchain(node.installation.iarPath);
					toolchainInstallationsProvider.refresh();
				}
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"zephyr-workbench-sdk-explorer.remove-arm-gnu",
			async (node: ToolchainInstallationTreeItem) => {
				if (!node.installation || !(node.installation instanceof ArmGnuToolchainInstallation)) {return;}

				if (await showConfirmMessage(`Remove ${node.installation.name} from workspace?`)) {
					await unregisterArmGnuToolchain(node.installation.toolchainPath);
					toolchainInstallationsProvider.refresh();
				}
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"zephyr-workbench-sdk-explorer.delete-arm-gnu",
			async (node: ToolchainInstallationTreeItem) => {
				if (!node.installation || !(node.installation instanceof ArmGnuToolchainInstallation)) {
					vscode.window.showWarningMessage("No Arm GNU toolchain selected.");
					return;
				}

				if (!(await showConfirmMessage(`Delete ${node.installation.name} permanently?`))) {
					return;
				}

				const toolchainPath = node.installation.toolchainPath;

				vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Deleting ARM GNU Toolchain",
						cancellable: false,
					},
					async () => {
						await unregisterArmGnuToolchain(toolchainPath);
						deleteFolder(toolchainPath);
						toolchainInstallationsProvider.refresh();
					}
				);
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"zephyr-workbench-sdk-explorer.delete-iar",
			async (node: ToolchainInstallationTreeItem) => {
				/* guard‑rails */
				if (!node.installation || !(node.installation instanceof IarToolchainInstallation)) {
					vscode.window.showWarningMessage("No IAR toolchain selected.");
					return;
				}

				/* confirm with user */
				if (
					!(await showConfirmMessage(`Delete ${node.installation.name} permanently?`))
				) {
					return;
				}

				const iarPath = node.installation.iarPath;

				vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Deleting IAR Toolchain",
						cancellable: false,
					},
					async () => {
						await unregisterIARToolchain(iarPath);
						deleteFolder(iarPath);
						toolchainInstallationsProvider.refresh();
					}
				);
			}
		)
	);


	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.open-wizard", async () => {
			if (getWestWorkspaces().length === 0) {
				const initWorkspaceItem = 'Initialize Workspace';
				const choice = await vscode.window.showErrorMessage("No west workspace found. Please initialize a workspace first.", initWorkspaceItem);
				if (choice === initWorkspaceItem) {
					vscode.commands.executeCommand('zephyr-workbench-west-workspace.open-wizard');
				}
				return;
			}
			const [
				zephyrSdkInstallations,
				iarToolchainInstallations,
				armGnuToolchainInstallations,
			] = await Promise.all([
				getRegisteredZephyrSdkInstallations(),
				getRegisteredIarToolchainInstallations(),
				getRegisteredArmGnuToolchainInstallations(),
			]);

			if (
				zephyrSdkInstallations.length === 0
				&& iarToolchainInstallations.length === 0
				&& armGnuToolchainInstallations.length === 0
			) {
				const importToolchainItem = 'Import Toolchain';
				const choice = await vscode.window.showErrorMessage("No toolchain found. Please import a toolchain first.", importToolchainItem);
				if (choice === importToolchainItem) {
					vscode.commands.executeCommand('zephyr-workbench-sdk-explorer.open-wizard');
				}
				return;
			}

			CreateZephyrAppPanel.render(context.extensionUri);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.create-app", async (westWorkspace, zephyrSample, zephyrBoard, projectLoc = '', projectName = '', toolchainInstallation, venvMode = 'global', debugPreset = false, toolchainVariant = 'zephyr', settingsPathMode = 'relative', applicationType = 'freestanding') => {
			if (!westWorkspace) {
				vscode.window.showErrorMessage('Missing west workspace, please select a west workspace');
				return;
			}

			if (!toolchainInstallation) {
				vscode.window.showErrorMessage('Missing toolchain installation, a toolchain is required to configure your application');
				return;
			}

			if (!projectName || projectName.length === 0) {
				vscode.window.showErrorMessage('The project name is empty or invalid');
				return;
			}

			if (!zephyrBoard) {
				vscode.window.showErrorMessage('Missing target board');
				return;
			}

			if (!zephyrSample) {
				vscode.window.showErrorMessage('Missing selected sample or test app, it serves as base for your project');
				return;
			}

			const isWorkspaceApplication = applicationType === 'workspace';
			if (!fileExists(projectLoc) && !isWorkspaceApplication) {
				vscode.window.showErrorMessage(`Project destination location "${projectLoc}" does not exists`);
				return;
			}

			await withAppRefreshBatch(async () => {
				await vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: "Adding application...",
					cancellable: false,
				}, async (progress, token) => {
					let projLoc: string;
					if (projectLoc.length === 0) {
						projLoc = zephyrSample.rootDir.fsPath;
					} else {
						if (isWorkspaceApplication && !fileExists(projectLoc)) {
							fs.mkdirSync(projectLoc, { recursive: true });
						}
						let projectPath = path.join(projectLoc, projectName);
						if (fileExists(projectPath)) {
							vscode.window.showErrorMessage(`The folder [${projectPath}] already exists. Please change the project name or its location.`);
							return;
						}
						projLoc = copySampleSync(zephyrSample.rootDir.fsPath, projectPath);
					}

					if (isWorkspaceApplication) {
						const workspaceFolder = getWorkspaceFolder(westWorkspace.rootUri.fsPath);
						if (!workspaceFolder) {
							vscode.window.showErrorMessage('The selected west workspace is not open in VS Code.');
							return;
						}

						if (debugPreset) {
							await debugPresetContent(projLoc);
						}

						let venvPath: string | undefined;
						if (venvMode === 'local') {
							venvPath = await createLocalVenv(context, workspaceFolder, westWorkspace.rootUri.fsPath, projLoc);
						}

						await setDefaultWorkspaceApplicationSettings(workspaceFolder, projLoc, westWorkspace, zephyrBoard, toolchainInstallation, {
							toolchainVariant,
							venvPath,
							pathMode: settingsPathMode,
						});
						CreateZephyrAppPanel.currentPanel?.dispose();

						vscode.window.showInformationMessage(`Application '${path.basename(projLoc)}' added to ${westWorkspace.name} !`);
						requestAppRefresh();
						westWorkspaceProvider.refresh();
						return;
					}

					// Freestanding settings are app-local by contract. Write them
					// against the new path directly; adding the folder to VS Code is
					// a UI step and may lag/fail when the current window is a plain
					// folder window rather than a saved multi-root workspace.
					const workspaceFolder = createWorkspaceFolderReference(projLoc);
					if (debugPreset) {
						await debugPresetContent(workspaceFolder.uri.fsPath);
					}
					let venvPath: string | undefined;
					if (venvMode === 'local') {
						venvPath = await createLocalVenv(context, workspaceFolder, westWorkspace.rootUri.fsPath);
					}

					await setDefaultProjectSettings(workspaceFolder, westWorkspace, zephyrBoard, toolchainInstallation, {
						toolchainVariant,
						venvPath,
						pathMode: settingsPathMode,
					});
					await assertFreestandingApplicationFilesCreated(projLoc);

					const addedToWorkspace = await addWorkspaceFolder(projLoc);
					CreateZephyrAppPanel.currentPanel?.dispose();

					vscode.window.showInformationMessage(`Application '${workspaceFolder.name}' added !`);
					if (!addedToWorkspace && !getExactWorkspaceFolder(projLoc)) {
						vscode.window.showWarningMessage(`Application settings were created, but '${workspaceFolder.name}' could not be added as a VS Code workspace folder.`);
					}
					requestAppRefresh();
				});
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.import-app", async (projectLoc, westWorkspace, zephyrBoard, toolchainInstallation, venvMode = 'global', toolchainVariant = 'zephyr', settingsPathMode = 'relative') => {
			if (!fileExists(projectLoc)) {
				vscode.window.showInformationMessage(`Project '${projectLoc}' not found !`);
				return;
			}

			await withAppRefreshBatch(async () => {
				const detectedWestWorkspace = westWorkspace
					?? getWestWorkspaces().find(candidate => isPathWithinWorkspaceApplication(candidate.rootUri.fsPath, projectLoc));
				const isWorkspaceApplication = !!detectedWestWorkspace
					&& isPathWithinWorkspaceApplication(detectedWestWorkspace.rootUri.fsPath, projectLoc);

				if (isWorkspaceApplication && detectedWestWorkspace) {
					const workspaceFolder = getWorkspaceFolder(detectedWestWorkspace.rootUri.fsPath);
					if (!workspaceFolder) {
						vscode.window.showErrorMessage('The detected west workspace is not open in VS Code.');
						return;
					}

					if (!zephyrBoard || !toolchainInstallation) {
						const existingEntry = findContainingWorkspaceApplicationEntry(workspaceFolder, projectLoc);
						if (existingEntry) {
							const appPath = resolveWorkspaceApplicationPath(existingEntry, workspaceFolder) ?? projectLoc;
							await setSelectedWorkspaceApplicationPath(workspaceFolder, appPath);
							vscode.window.showInformationMessage(`Using existing West workspace application '${path.basename(appPath)}'.`);
							requestAppRefresh();
							westWorkspaceProvider.refresh();
							return;
						}
						vscode.window.showErrorMessage('Importing a West workspace application requires a board and toolchain the first time it is linked.');
						return;
					}

					let venvPath: string | undefined;
					if (venvMode === 'local') {
						venvPath = await createLocalVenv(context, workspaceFolder, detectedWestWorkspace.rootUri.fsPath, projectLoc);
					}

					await setDefaultWorkspaceApplicationSettings(workspaceFolder, projectLoc, detectedWestWorkspace, zephyrBoard, toolchainInstallation, {
						toolchainVariant,
						venvPath,
						pathMode: settingsPathMode,
					});
					vscode.window.showInformationMessage(`Importing West workspace application '${path.basename(projectLoc)}' done`);
					requestAppRefresh();
					westWorkspaceProvider.refresh();
					return;
				}

				let workspaceFolder = createWorkspaceFolderReference(projectLoc);
				if (workspaceFolder && westWorkspace && zephyrBoard && toolchainInstallation) {
					let venvPath: string | undefined;
					if (venvMode === 'local') {
						venvPath = await createLocalVenv(context, workspaceFolder, westWorkspace.rootUri.fsPath);
					}

					await setDefaultProjectSettings(workspaceFolder, westWorkspace, zephyrBoard, toolchainInstallation, {
						toolchainVariant,
						venvPath,
						pathMode: settingsPathMode,
					});
					await assertFreestandingApplicationFilesCreated(projectLoc);

					const addedToWorkspace = await addWorkspaceFolder(projectLoc);
					vscode.window.showInformationMessage(`Importing Application '${workspaceFolder.name}' done`);
					if (!addedToWorkspace && !getExactWorkspaceFolder(projectLoc)) {
						vscode.window.showWarningMessage(`Application settings were created, but '${workspaceFolder.name}' could not be added as a VS Code workspace folder.`);
					}
					requestAppRefresh();
				}
			});
		})
	);

	context.subscriptions.push(
		vscode.window.registerTerminalProfileProvider('zephyr-workbench.terminal', {
		provideTerminalProfile(token: vscode.CancellationToken): vscode.ProviderResult<vscode.TerminalProfile> {
			let opts: vscode.TerminalOptions = {
				name: "Zephyr BuildSystem Terminal",
				shellPath: "bash",
				env: getZephyrEnvironment(),
			};
			return new vscode.TerminalProfile(opts);
		}
	})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("west.init", async (srcUrl, srcRev, workspaceDestPath, manifestPath) => {
			if (workspaceDestPath && !isWorkspaceFolder(workspaceDestPath)) {
				vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: "Initializing west workspace",
					cancellable: true,
				}, async (progress, token) => {
					try {
						progress.report({ increment: 5, message: 'Initializing manifest...' });
						await westInitCommand(srcUrl, srcRev, workspaceDestPath, manifestPath);
						if (token.isCancellationRequested) {
							throw new Error('West workspace import cancelled.', { cause: 'cancelled' });
						}
						progress.report({ increment: 5, message: 'Updating projects...' });
						await westUpdateCommand(workspaceDestPath, progress, token);
						if (token.isCancellationRequested) {
							throw new Error('West workspace import cancelled.', { cause: 'cancelled' });
						}
						progress.report({ increment: 10, message: 'Loading boards...' });
						await westBoardsCommand(workspaceDestPath);
						if (token.isCancellationRequested) {
							throw new Error('West workspace import cancelled.', { cause: 'cancelled' });
						}
						CreateWestWorkspacePanel.currentPanel?.dispose();
						await addWorkspaceFolder(workspaceDestPath);

						// Update settings.json to avoid CMake automatic scan after importing west workspace
						const workspaceFolder = getWorkspaceFolder(workspaceDestPath);
						await vscode.workspace.getConfiguration('cmake', workspaceFolder).update('enableAutomaticKitScan', false, vscode.ConfigurationTarget.WorkspaceFolder);
						westWorkspaceProvider.refresh();
						progress.report({ increment: 80, message: 'Import complete' });
					} catch (e) {
						if (e instanceof Error) {
							const cause = (e as any).cause;
							if (cause === 'cancelled') {
								vscode.window.showInformationMessage('West workspace import cancelled.');
							} else if (typeof cause === 'string' && cause.startsWith(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)) {
								const openSettingItem = 'Open Setting';
								const choice = await vscode.window.showErrorMessage(`Fail to execute west init command...\n${e}`, openSettingItem);
								if (choice === openSettingItem) {
									vscode.commands.executeCommand('workbench.action.openSettings', (e as any).cause);
								}
							} else {
								vscode.window.showErrorMessage(`Fail to execute west init command...\n${e}`);
							}
						} else {
							vscode.window.showErrorMessage('Fail to execute west init command...\n Error: Unknown');
						}
						return;
					}
				});
			} else {
				vscode.window.showErrorMessage("The west workspace location folder is invalid or already exists");
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-west-workspace.import-local", async (workspaceDestPath) => {
			if (workspaceDestPath && !isWorkspaceFolder(workspaceDestPath)) {
				CreateWestWorkspacePanel.currentPanel?.dispose();
				if (WestWorkspace.isWestWorkspacePath(workspaceDestPath)) {
					await addWorkspaceFolder(workspaceDestPath);
					await westBoardsCommand(workspaceDestPath);
				} else {
					vscode.window.showErrorMessage("The folder is not a West workspace");
				}
			} else {
				vscode.window.showErrorMessage("The west workspace location folder is invalid or already exists");
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-west-workspace.import-from-template", async (remotePath, remoteBranch, workspacePath, templateHal, templateMode, manifestDir?: string, pathPrefix?: string, projects?: string[]) => {
			if (remotePath && remoteBranch && workspacePath && templateHal) {
				try {
					// Determine if mode is 'full' or 'minimal'
					const isFull = templateMode === 'full';
					// Generate west.xml from template
					let manifestFile = generateWestManifest(context, remotePath, remoteBranch, workspacePath, templateHal, isFull, manifestDir, pathPrefix, projects);
					// Run west init to the newly create manifest
					vscode.commands.executeCommand("west.init", '', '', workspacePath, manifestFile);
				} catch (error) {
					vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
				}
			}
		})
	);


	context.subscriptions.push(
		vscode.commands.registerCommand("west.version", async () => {
			const terminal = await getZephyrTerminal();
			runCommandTerminal(terminal, "west --version");
		})
	);

	/* Listeners on active editor */
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => {
			updateStatusBar();
			void dashboardViewProvider.refresh();
		})
	);

	/* Listeners on workspace changes */
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders((event: vscode.WorkspaceFoldersChangeEvent) => {
			requestAppRefresh();
			//zephyrModuleProvider.refresh();
			westWorkspaceProvider.refresh();
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			updateStatusBar();
			void dashboardViewProvider.refresh();
		})
	);

	/* Listeners on setttings changes */
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async (event) => {
			if (event.affectsConfiguration('tasks')) {
				requestAppRefresh();
			}

			if (event.affectsConfiguration(ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY)) {
				toolchainInstallationsProvider.refresh();
			}

			if (event.affectsConfiguration(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY)) {
				zephyrShortcutProvider.refresh();
				zephyrToolsCommandProvider.refresh();
			}

			if (event.affectsConfiguration(`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY}`) ||
				event.affectsConfiguration(`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_SDK_SETTING_KEY}`) ||
				event.affectsConfiguration(`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WEST_WORKSPACE_APPLICATIONS_SETTING_KEY}`) ||
				event.affectsConfiguration(`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WEST_WORKSPACE_SELECTED_APPLICATION_SETTING_KEY}`) ||
				event.affectsConfiguration(`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.build.configurations`)) {
				requestAppRefresh();
				westWorkspaceProvider.refresh();
				// Selection / declared-apps changes don't fire active-editor events,
				// so the status bar item needs an explicit refresh here.
				updateStatusBar();
			}

			void dashboardViewProvider.refresh();
		})
	);

	if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
		(async () => {
			const cmakeConfig = vscode.workspace.getConfiguration('cmake');

			const settingsToApply: [string, any][] = [
				['ignoreCMakeListsMissing', true],
				['configureOnOpen', false],
				['enableAutomaticKitScan', false],
				['sourceDirectory', '${workspaceFolder}/nonexistent']
			];

			// Check if any setting needs to be updated
			const needsChange = settingsToApply.some(([key, desiredValue]) => {
				const currentValue = cmakeConfig.get(key);
				return currentValue !== desiredValue;
			});

			if (needsChange) {
				const choice = await vscode.window.showInformationMessage(
					'Zephyr Workbench recommends applying CMake settings to prevent popup conflicts (e.g., sourceDirectory). Apply now?',
					'Yes', 'No'
				);

				if (choice === 'Yes') {
					for (const [key, value] of settingsToApply) {
						// target workspace-wide, not global or per-folder
						await cmakeConfig.update(key, value, vscode.ConfigurationTarget.Workspace);
					}
					vscode.window.showInformationMessage(
						'Zephyr Workbench applied recommended CMake settings.'
					);
				}
			}
		})();
	}

	checkZinstallerVersion(context).catch(console.error);

	setDefaultSettings();
}

function resolveWorkspaceFolderForEclair(node?: any): { workspaceFolder?: vscode.WorkspaceFolder, settingsRoot?: string } {
	if ((node as vscode.Uri)?.fsPath) {
		const wf = vscode.workspace.getWorkspaceFolder(node as vscode.Uri) || undefined;
		return { workspaceFolder: wf, settingsRoot: (node as vscode.Uri).fsPath };
	}
	const fallback = getCurrentWorkspaceFolder() ?? vscode.workspace.workspaceFolders?.[0];
	return { workspaceFolder: fallback, settingsRoot: fallback?.uri.fsPath };
}

function getCurrentWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
	const editor = vscode.window.activeTextEditor;
	if (editor) {
		const resource = editor.document.uri;
		const folder = vscode.workspace.getWorkspaceFolder(resource);
		return folder;
	}
	return undefined;
}

async function updateStatusBar() {
	const resource = vscode.window.activeTextEditor?.document.uri;
	const projects = resource
		? await ZephyrApplication.getApplications(vscode.workspace.workspaceFolders ?? [])
		: [];

	// Direct match: file is inside an application's own folder.
	const containingProject = resource
		? projects.find(project => isPathWithinWorkspaceApplication(project.appRootPath, resource.fsPath))
		: undefined;

	// Fallback: file is somewhere else inside a west workspace (shared module,
	// workspace root, etc.). Build/Debug commands resolve through the same
	// effective-application fallback in getZephyrApplication, so the status
	// bar contract has to match — otherwise the icons would hide while the
	// commands still work, which is just confusing.
	const fallbackProject = !containingProject && resource
		? resolveEffectiveWorkspaceProject(resource, projects)
		: undefined;

	const projectForActions = containingProject ?? fallbackProject;
	if (projectForActions) {
		statusBarBuildItem.tooltip = `Zephyr: Build ${projectForActions.appName}`;
		statusBarDebugItem.tooltip = `Zephyr: Debug ${projectForActions.appName}`;
		statusBarBuildItem.show();
		statusBarDebugItem.show();
	} else {
		statusBarBuildItem.hide();
		statusBarDebugItem.hide();
	}

	updateSelectedWorkspaceAppStatusBar(resource);
}

// Resolve the west workspace's effective (selected) application for files
// living outside any individual app folder. Returns the matching project from
// the already-loaded list to avoid re-parsing settings twice per refresh.
function resolveEffectiveWorkspaceProject(
	resource: vscode.Uri,
	projects: ZephyrApplication[],
): ZephyrApplication | undefined {
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(resource);
	if (!workspaceFolder || !WestWorkspace.isWestWorkspaceFolder(workspaceFolder)) {
		return undefined;
	}

	const effectiveEntry = getEffectiveWorkspaceApplicationEntry(workspaceFolder);
	const effectivePath = effectiveEntry
		? resolveWorkspaceApplicationPath(effectiveEntry, workspaceFolder)
		: undefined;
	if (!effectivePath) {
		return undefined;
	}

	const normalizedEffectivePath = path.normalize(effectivePath);
	return projects.find(project => path.normalize(project.appRootPath) === normalizedEffectivePath);
}

// Reflects the currently-selected west workspace application of the workspace
// containing the active file. The item only appears when the file lives inside
// a west workspace folder that declares ≥1 application, since picking an app is
// otherwise meaningless.
function updateSelectedWorkspaceAppStatusBar(resource: vscode.Uri | undefined): void {
	if (!resource) {
		statusBarSelectedAppItem.hide();
		return;
	}

	const workspaceFolder = vscode.workspace.getWorkspaceFolder(resource);
	if (!workspaceFolder || !WestWorkspace.isWestWorkspaceFolder(workspaceFolder)) {
		statusBarSelectedAppItem.hide();
		return;
	}

	const entries = readWorkspaceApplicationEntries(workspaceFolder);
	if (entries.length === 0) {
		statusBarSelectedAppItem.hide();
		return;
	}

	// When multiple apps exist but none is explicitly selected, the picker is
	// the only way out, so surface that as a prompt rather than hiding the item.
	const effectiveEntry = getEffectiveWorkspaceApplicationEntry(workspaceFolder);
	const effectivePath = effectiveEntry
		? resolveWorkspaceApplicationPath(effectiveEntry, workspaceFolder)
		: undefined;

	if (effectivePath) {
		const appName = path.basename(effectivePath);
		statusBarSelectedAppItem.text = `$(folder-active) ${appName}`;
		statusBarSelectedAppItem.tooltip = `Selected west workspace application: ${appName} (${workspaceFolder.name}). Click to change.`;
	} else {
		statusBarSelectedAppItem.text = `$(folder-active) Select application…`;
		statusBarSelectedAppItem.tooltip = `Pick a west workspace application for ${workspaceFolder.name}`;
	}
	statusBarSelectedAppItem.show();
}

function getActiveOrDefaultBuildConfig(project: ZephyrApplication): ZephyrBuildConfig | undefined {
	return project.buildConfigs.find(config => config.active) ?? project.buildConfigs[0];
}

function isSysbuildEnabled(buildConfig: ZephyrBuildConfig, override?: boolean): boolean {
	return typeof override === 'boolean'
		? override
		: String(buildConfig.sysbuild).toLowerCase() === 'true';
}

function getBuildConfigCompileCommandsPath(
	project: ZephyrApplication,
	buildConfig: ZephyrBuildConfig,
	sysbuildOverride?: boolean,
): string {
	const buildDir = buildConfig.getBuildDir(project);
	if (isSysbuildEnabled(buildConfig, sysbuildOverride)) {
		return path.join(buildDir, path.basename(project.appRootPath), 'compile_commands.json');
	}
	return path.join(buildDir, 'compile_commands.json');
}

function extractDebugBuildConfigName(debugConfigName: string): string | undefined {
	const match = debugConfigName.match(/\[(.*?)\]/);
	return match ? match[1] : undefined;
}

function findLaunchConfigurationForProject(
	configurations: vscode.DebugConfiguration[] | undefined,
	project: ZephyrApplication,
	configName: string,
): vscode.DebugConfiguration | undefined {
	const matchingConfigurations = (configurations ?? []).filter(config => config && config.name === configName);
	if (!project.isWestWorkspaceApplication) {
		return matchingConfigurations[0];
	}

	const normalizedProjectPath = path.normalize(project.appRootPath);
	const matchingApplicationConfig = matchingConfigurations.find(config => {
		const appRoot = config[ZEPHYR_WORKBENCH_DEBUG_APP_ROOT_KEY];
		return typeof appRoot === 'string' && path.normalize(appRoot) === normalizedProjectPath;
	});
	if (matchingApplicationConfig) {
		return matchingApplicationConfig;
	}

	// Older workspace-app launch entries did not carry an app-root marker. Treat
	// a single unmarked match as belonging to this app so existing users do not
	// need to recreate their debug config; ambiguous duplicates fall back to the
	// Debug Manager where a new marked config can be written.
	if (matchingConfigurations.length === 1 && !matchingConfigurations[0][ZEPHYR_WORKBENCH_DEBUG_APP_ROOT_KEY]) {
		return matchingConfigurations[0];
	}

	return undefined;
}

async function removeWorkspaceApplicationAndGeneratedConfig(project: ZephyrApplication): Promise<void> {
	const removed = await removeWorkspaceApplicationEntry(project.appWorkspaceFolder, project.appRootPath);
	if (!removed) {
		return;
	}

	if (readWorkspaceApplicationEntries(project.appWorkspaceFolder).length === 0) {
		await removeCppToolsConfiguration(project.appWorkspaceFolder);
	}
}

async function assertFreestandingApplicationFilesCreated(applicationRootPath: string): Promise<void> {
	const requiredFiles = [
		path.join(applicationRootPath, '.vscode', 'settings.json'),
		path.join(applicationRootPath, '.vscode', 'c_cpp_properties.json'),
	];
	const missingFiles = requiredFiles.filter(requiredFile => !fileExists(requiredFile));
	if (missingFiles.length === 0) {
		return;
	}

	const message = `Freestanding application settings were not created in '${applicationRootPath}'. Missing: ${missingFiles.map(file => path.basename(file)).join(', ')}`;
	vscode.window.showErrorMessage(message);
	throw new Error(message);
}

function isSelectedIntelliSenseApplication(project: ZephyrApplication): boolean {
	if (!project.isWestWorkspaceApplication) {
		return true;
	}

	const effectiveEntry = getEffectiveWorkspaceApplicationEntry(project.appWorkspaceFolder);
	const effectivePath = effectiveEntry
		? resolveWorkspaceApplicationPath(effectiveEntry, project.appWorkspaceFolder)
		: undefined;
	return !!effectivePath && path.normalize(effectivePath) === path.normalize(project.appRootPath);
}

async function updateBuildConfigCompileCommandsSetting(
	project: ZephyrApplication,
	buildConfig: ZephyrBuildConfig,
	sysbuildOverride?: boolean,
): Promise<void> {
	if (!isSelectedIntelliSenseApplication(project)) {
		return;
	}
	await updateCppToolsConfiguration(project.appWorkspaceFolder, {
		compileCommandsPath: getBuildConfigCompileCommandsPath(project, buildConfig, sysbuildOverride),
	});
}

async function updateCompileSetting(project: ZephyrApplication, configName: string, boardIdentifier: string) {
	if (!isSelectedIntelliSenseApplication(project)) {
		return;
	}
	const buildConfig = project.getBuildConfiguration(configName);
	const westWorkspace = getWestWorkspace(project.westWorkspaceRootPath);
	const board = await getBoardFromIdentifier(boardIdentifier, westWorkspace);
	const toolchainVariantId = project.toolchainVariant;
	const zephyrSdkInstallation = project.zephyrSdkPath ? getZephyrSdkInstallation(project.zephyrSdkPath) : undefined;
	const toolchainVariant = normalizeZephyrSdkVariant(toolchainVariantId, zephyrSdkInstallation);

	if (buildConfig) {
		let socToolchainName = buildConfig.getKConfigValue(project, 'SOC_TOOLCHAIN_NAME');
		if (socToolchainName) {
			let compilerPath: string | undefined;
			if (toolchainVariantId === 'gnuarmemb') {
				compilerPath = project.selectedArmGnuToolchainInstallation?.compilerPath;
			} else if (zephyrSdkInstallation) {
				compilerPath = zephyrSdkInstallation.getCompilerPath(board.arch, socToolchainName, toolchainVariant);
			}
			if (compilerPath) {
				await updateCppToolsConfiguration(project.appWorkspaceFolder, { compilerPath });
			}
		}
	}
}

async function debugPresetContent(projectRoot: string): Promise<void> {
	const prjConfPath = path.join(projectRoot, 'prj.conf');
	let content = '';
	if (fs.existsSync(prjConfPath)) {
		content = fs.readFileSync(prjConfPath, 'utf8');
	}

	// Avoid adding the block more than once.
	if (/^\s*CONFIG_DEBUG_OPTIMIZATIONS=y\s*$/m.test(content)) {
		return;
	}

	// Remove placeholder comments like "# nothing here" when debug preset is enabled.
	content = content
		.split(/\r?\n/)
		.filter(line => !/^\s*#\s*nothing\s+here\s*$/i.test(line))
		.join('\n');

	if (content.length > 0 && !content.endsWith('\n')) {
		content += '\n';
	}

	const block = [
		'',
		'# Added automatically by Workbench for Zephyr',
		'#--- DEBUG PRESET - BEGIN ---#',
		'# Set to -Og',
		'CONFIG_DEBUG_OPTIMIZATIONS=y',
		'# Thread awareness support',
		'CONFIG_DEBUG_THREAD_INFO=y',
		'# Generate stack usage per-function',
		'CONFIG_STACK_USAGE=y',
		'# Other options in case not set by default',
		'CONFIG_BUILD_OUTPUT_HEX=y',
		'CONFIG_BUILD_OUTPUT_META=y',
		'CONFIG_OUTPUT_SYMBOLS=y',
		'CONFIG_OUTPUT_STAT=y',
		'CONFIG_OUTPUT_DISASSEMBLY=y',
		'CONFIG_OUTPUT_PRINT_MEMORY_USAGE=y',
		'#--- DEBUG PRESET - END ---#',
		''
	].join('\n');

	fs.writeFileSync(prjConfPath, `${content}${block}`, 'utf8');
}

type CustomTaskConfigPickItem = vscode.QuickPickItem & {
	configName: string | null;
};

async function promptCustomTaskDefinition(project: ZephyrApplication): Promise<ZephyrTaskDefinition | undefined> {
	const label = await vscode.window.showInputBox({
		title: 'Add Custom Task',
		prompt: 'Enter the task label to add to this application\'s tasks.json.',
		placeHolder: 'Example: West Size',
		ignoreFocusOut: true,
		validateInput: value => {
			const trimmed = value.trim();
			if (!trimmed) {
				return 'Task label is required.';
			}
			if (isReservedTaskLabel(trimmed)) {
				return 'This label is reserved by built-in Zephyr Workbench tasks.';
			}
			return undefined;
		},
	});

	if (label === undefined) {
		return undefined;
	}

	const command = await vscode.window.showInputBox({
		title: 'Add Custom Task',
		prompt: 'Enter the command to execute. Quote paths with spaces if needed.',
		placeHolder: 'Example: west',
		ignoreFocusOut: true,
		validateInput: value => value.trim() ? undefined : 'Command is required.',
	});

	if (command === undefined) {
		return undefined;
	}

	const args = await vscode.window.showInputBox({
		title: 'Add Custom Task',
		prompt: 'Optional: enter the arguments exactly as they should be passed to the command.',
		placeHolder: 'Example: build -t rom_report',
		ignoreFocusOut: true,
	});

	if (args === undefined) {
		return undefined;
	}

	const configItems: CustomTaskConfigPickItem[] = [
		{
			label: 'No build configuration',
			description: 'Run with the application-level environment only',
			configName: null,
		},
		...project.buildConfigs.map(config => ({
			label: config.name,
			description: config.active ? `${config.boardIdentifier} [active]` : config.boardIdentifier,
			configName: config.name,
		})),
	];

	const selectedConfig = await vscode.window.showQuickPick(configItems, {
		title: 'Add Custom Task',
		placeHolder: 'Select an optional build configuration context for this task.',
		ignoreFocusOut: true,
	});

	if (!selectedConfig) {
		return undefined;
	}

	const taskDefinition: ZephyrTaskDefinition = {
		label: label.trim(),
		type: ZephyrTaskProvider.ZephyrType,
		command: command.trim(),
		args: args.trim() ? [args.trim()] : [],
	};

	if (selectedConfig.configName) {
		taskDefinition.config = selectedConfig.configName;
	}

	return taskDefinition;
}

export async function showConfirmMessage(message: string): Promise<boolean> {
	const yesItem = 'Yes';
	const noItem = 'No';
	const choice = await vscode.window.showWarningMessage(message, yesItem, noItem);
	return (choice === yesItem) ? true : false;
}

export async function executeConfigTask(taskName: string, node: any, configName?: string): Promise<vscode.TaskExecution[] | undefined> {
  let context: ZephyrApplication | undefined = undefined;
  let folder: vscode.WorkspaceFolder | undefined = undefined;
	if (node instanceof ZephyrApplicationTreeItem) {
		if (node.project) {
			context = node.project;
			folder = node.project.appWorkspaceFolder;
		}
	} else if (node instanceof ZephyrConfigTreeItem) {
		if (node.project) {
			context = node.project;
			folder = node.project.appWorkspaceFolder;
			configName = node.buildConfig.name;
		}
	} else if (node instanceof ZephyrApplication) {
		context = node;
		folder = node.appWorkspaceFolder;
	} else if (node instanceof vscode.Uri) {
		folder = vscode.workspace.getWorkspaceFolder(node);
		if (folder) {
			context = await getZephyrApplication(node.fsPath);
			configName = undefined;
		}
	}
  else {
    context = await getZephyrApplication(node.uri.fsPath);
    folder = node;
  }

  // Get list of task to execute
  let listTasks: vscode.Task[] = [];
  if (context && folder) {
    // Ensure tasks.json exists for this workspace (avoids "Cannot find task" on fresh/migrated projects)
    await checkAndCreateTasksJson(folder);
    // Give VS Code a brief moment to pick up new tasks.json on first run
    await msleep(100);
    // IF: In configuration name is provided execute it
		// ELSE IF : run active if multiple build configurations
		// ELSE IF : run task if only one build configuration 
		if (configName) {
			let task = await findConfigTask(taskName, context, configName);
			if (task) {
				listTasks.push(task);
			}
		} else if (context.buildConfigs && context.buildConfigs.length > 1) {
			let hasActive = false;
			for (let config of context.buildConfigs) {
				if (config.active) {
					hasActive = true;
					let task = await findConfigTask(taskName, context, config.name);
					if (task) {
						listTasks.push(task);
					}
				}
			}

			if (!hasActive) {
				vscode.window.showInformationMessage("No active configuration found, please set one as active first.");
			}

		} else if (context.buildConfigs && context.buildConfigs.length === 1) {
			let task = await findConfigTask(taskName, context, context.buildConfigs[0].name);
			if (task) {
				listTasks.push(task);
			}
		}
	}

	return new Promise<vscode.TaskExecution[] | undefined>(async resolve => {
		// These specific commands below are executed directly, they are not saved in tasks.json
		const tasks = ['DT Doctor', 'West ROM Report', 'West RAM Report', 'West RAM Plot', 'West ROM Plot', 'Gui Config', 'Menu Config', 'Harden Config'];
		// Execute task
		if (listTasks.length > 0) {
			try {
				let tasksExec: vscode.TaskExecution[] = [];
				for (let task of listTasks) {
					tasksExec.push(await executeTask(task));
				}
				resolve(tasksExec);
			} catch (error) {
				vscode.window.showErrorMessage(`Error executing task: ${error}`);
				resolve(undefined);
			}
		} else {
			if (tasks) {
				resolve(undefined);
			}
			else{
				vscode.window.showErrorMessage(`Cannot find "${taskName}" task.`);
				resolve(undefined);
			}
			
		}
	});
}

async function addCustomRunners(
	project: ZephyrApplication,
	targetConfig: ZephyrBuildConfig
): Promise<string | undefined> {
	let items: vscode.QuickPickItem[] = [];
	try {
		const info = await vscode.window.withProgress<{ all: string[]; available: string[]; def?: string; output: string }>(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Collecting flash runners (this may take a while)…',
				cancellable: false,
			},
			async () => {
				return await getFlashRunners(project as ZephyrApplication, targetConfig);
			}
		);
		const all: string[] = info.all;
		const compatible: string[] = info.available;
		const defRunner: string | undefined = info.def;
		const sorted = all.slice().sort((a: string, b: string) => {
			const ac = compatible.includes(a) ? 0 : 1;
			const bc = compatible.includes(b) ? 0 : 1;
			return ac - bc || a.localeCompare(b);
		});
		const ordered = defRunner && sorted.includes(defRunner)
			? [defRunner, ...sorted.filter(n => n !== defRunner)]
			: sorted;
		items = ordered.map((name: string) => ({
			label: name + (compatible.includes(name) ? ' (compatible)' : ''),
			picked: name === targetConfig?.defaultRunner,
		}));
	} catch (e: any) {
		const msg = e?.message ? String(e.message) : 'Unknown error while collecting flash runners.';
		vscode.window.showWarningMessage(`Workbench for Zephyr: Using fallback flash runner list. ${msg}`);
		const names = getStaticFlashRunnerNames();
		items = names.map((name: string) => ({
			label: name,
			picked: name === targetConfig?.defaultRunner,
		}));
	}

	const selection = await vscode.window.showQuickPick(items, { placeHolder: 'Select default runner' });
	if (!selection) { return undefined; }
	return (selection.label || '').replace(' (compatible)', '');
}

// This method is called when your extension is deactivated
export function deactivate() {
	zephyrTaskProvider?.dispose();
	zephyrDebugConfigurationProvide?.dispose();
}
