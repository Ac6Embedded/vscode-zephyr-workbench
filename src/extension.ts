// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import path from 'path';
import * as vscode from 'vscode';
import { westBoardsCommand, westInitCommand, westUpdateCommand } from './WestCommands';
import { WestWorkspace } from './WestWorkspace';
import { ZephyrAppProject } from './ZephyrAppProject';
import { ZephyrDebugConfigurationProvider } from './ZephyrDebugConfigurationProvider';
import { ZephyrProject } from './ZephyrProject';
import { ZephyrProjectBuildConfiguration } from './ZephyrProjectBuildConfiguration';
import { ZephyrSDK } from './ZephyrSDK';
import { createExtensionsJson, createTasksJson, setDefaultProjectSettings, updateTasks, ZephyrTaskProvider } from './ZephyrTaskProvider';
import { changeBoardQuickStep } from './changeBoardQuickStep';
import { changeEnvVarQuickStep } from './changeEnvVarQuickStep';
import { changeWestWorkspaceQuickStep } from './changeWestWorkspaceQuickStep';
import { ZEPHYR_BUILD_CONFIG_WEST_ARGS_SETTING_KEY, ZEPHYR_PROJECT_BOARD_SETTING_KEY, ZEPHYR_PROJECT_EXTRA_WEST_ARGS_SETTING_KEY, ZEPHYR_PROJECT_SDK_SETTING_KEY, ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY, ZEPHYR_WORKBENCH_BUILD_PRISTINE_SETTING_KEY, ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY, ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY } from './constants';
import { getRunner, ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME } from './debugUtils';
import { executeTask } from './execUtils';
import { importProjectQuickStep } from './importProjectQuickStep';
import { checkEnvFile, checkHomebrew, checkHostTools, cleanupDownloadDir, createLocalVenv, createLocalVenvSPDX, download, forceInstallHostTools, installHostDebugTools, installVenv, runInstallHostTools, setDefaultSettings, verifyHostTools } from './installUtils';
import { generateWestManifest } from './manifestUtils';
import { CreateWestWorkspacePanel } from './panels/CreateWestWorkspacePanel';
import { CreateZephyrAppPanel } from './panels/CreateZephyrAppPanel';
import { DebugManagerPanel } from './panels/DebugManagerPanel';
import { DebugToolsPanel } from './panels/DebugToolsPanel';
import { ImportZephyrSDKPanel } from './panels/ImportZephyrSDKPanel';
import { SDKManagerPanel } from './panels/SDKManagerPanel';
import { pickApplicationQuickStep } from './pickApplicationQuickStep';
import { pickBuildConfigQuickStep } from './pickBuildConfigQuickStep';
import { WestWorkspaceDataProvider, WestWorkspaceEnvTreeItem, WestWorkspaceEnvValueTreeItem, WestWorkspaceTreeItem } from './providers/WestWorkspaceDataProvider';
import { ZephyrApplicationBoardTreeItem, ZephyrApplicationDataProvider, ZephyrApplicationEnvTreeItem, ZephyrApplicationEnvValueTreeItem, ZephyrApplicationTreeItem, ZephyrApplicationWestWorkspaceTreeItem, ZephyrConfigBoardTreeItem, ZephyrConfigEnvTreeItem, ZephyrConfigEnvValueTreeItem, ZephyrConfigTreeItem } from './providers/ZephyrApplicationProvider';
import { ZephyrHostToolsCommandProvider } from './providers/ZephyrHostToolsCommandProvider';
import { ZephyrOtherResourcesCommandProvider } from './providers/ZephyrOtherResourcesCommandProvider';
import { ZephyrSdkDataProvider, ZephyrSdkTreeItem } from "./providers/ZephyrSdkDataProvider";
import { ZephyrShortcutCommandProvider } from './providers/ZephyrShortcutCommandProvider';
import { extractSDK, generateSdkUrls, registerZephyrSDK, unregisterZephyrSDK } from './sdkUtils';
import { setConfigQuickStep } from './setConfigQuickStep';
import { showPristineQuickPick } from './setupBuildPristineQuickStep';
import { addWorkspaceFolder, convertLegacySettings, convertLegacyTasks, copySampleSync, deleteFolder, fileExists, findConfigTask, findOrCreateTask, getBoardFromIdentifier, getInternalToolsDirRealPath, getListZephyrSDKs, getWestWorkspace, getWestWorkspaces, getWorkspaceFolder, getZephyrProject, getZephyrSDK, isWorkspaceFolder, msleep, removeWorkspaceFolder } from './utils';
import { addConfig, addEnvValue, deleteConfig, removeEnvValue, replaceEnvValue, saveConfigEnv, saveConfigSetting, saveEnv } from './zephyrEnvUtils';
import { getZephyrEnvironment, getZephyrTerminal, runCommandTerminal } from './zephyrTerminalUtils';
import { execCveBinToolCommand, execNtiaCheckerCommand, execSBom2DocCommand } from './SPDXCommands';

let statusBarBuildItem: vscode.StatusBarItem;
let statusBarDebugItem: vscode.StatusBarItem;
let zephyrTaskProvider: vscode.Disposable | undefined;
let zephyrDebugConfigurationProvide: vscode.Disposable | undefined;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	const requiredExtensions = [
		'ms-vscode.cpptools',								// https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools
		'ms-vscode.cpptools-extension-pack',// https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools-extension-pack
		'ms-vscode.vscode-serial-monitor',  // https://marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-serial-monitor
		'ms-vscode.vscode-embedded-tools',  // https://marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-embedded-tools
		'redhat.vscode-yaml',								// https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml
		'trond-snekvik.kconfig-lang',				// https://marketplace.visualstudio.com/items?itemName=trond-snekvik.kconfig-lang
		'trond-snekvik.devicetree',					// https://marketplace.visualstudio.com/items?itemName=trond-snekvik.devicetree
  ];

	zephyrTaskProvider = vscode.tasks.registerTaskProvider(ZephyrTaskProvider.ZephyrType, new ZephyrTaskProvider());
	zephyrDebugConfigurationProvide = vscode.debug.registerDebugConfigurationProvider('cppdbg', new ZephyrDebugConfigurationProvider());

	const workspacePath = (vscode.workspace.workspaceFolders && (vscode.workspace.workspaceFolders.length > 0))
	? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined;

	statusBarBuildItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
	statusBarBuildItem.text = "$(gear) Build";
	statusBarBuildItem.command = "zephyr-workbench.build-app";
	statusBarDebugItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBarDebugItem.text = "$(debug-alt) Debug";
	statusBarDebugItem.command = "zephyr-workbench.debug-app";

	context.subscriptions.push(statusBarBuildItem);
	context.subscriptions.push(statusBarDebugItem);

	const zephyrShortcutProvider = new ZephyrShortcutCommandProvider();
	vscode.window.registerTreeDataProvider('zephyr-workbench-shortcuts', zephyrShortcutProvider);

	const zephyrSdkProvider = new ZephyrSdkDataProvider();
	vscode.window.registerTreeDataProvider('zephyr-workbench-sdk-explorer', zephyrSdkProvider);
	vscode.commands.registerCommand('zephyr-workbench-sdk-explorer.refresh', () => zephyrSdkProvider.refresh());

	const westWorkspaceProvider = new WestWorkspaceDataProvider();
	vscode.window.registerTreeDataProvider('zephyr-workbench-west-workspace', westWorkspaceProvider);
	vscode.commands.registerCommand('zephyr-workbench-west-workspace.refresh', () => westWorkspaceProvider.refresh());

	const zephyrAppProvider = new ZephyrApplicationDataProvider();
	vscode.window.registerTreeDataProvider('zephyr-workbench-app-explorer', zephyrAppProvider);
	vscode.commands.registerCommand('zephyr-workbench-app-explorer.refresh', () => zephyrAppProvider.refresh());

	const zephyrToolsCommandProvider = new ZephyrHostToolsCommandProvider();
	vscode.window.registerTreeDataProvider('zephyr-workbench-tools-explorer', zephyrToolsCommandProvider);

	const zephyrResourcesCommandProvider = new ZephyrOtherResourcesCommandProvider();
	vscode.window.registerTreeDataProvider('zephyr-workbench-other-resources', zephyrResourcesCommandProvider);
	
	vscode.commands.registerCommand('zephyr-workbench.build-app', async () => {
		let currentProject = getCurrentWorkspaceFolder();
		if(currentProject === undefined ) {
			currentProject = await pickApplicationQuickStep(context);
		}

		if(currentProject) {
			vscode.commands.executeCommand("zephyr-workbench-app-explorer.build-app", currentProject);
		}
	});

	vscode.commands.registerCommand('zephyr-workbench.rebuild-app', async () => {
		let currentProject = getCurrentWorkspaceFolder();
		if(currentProject === undefined ) {
			currentProject = await pickApplicationQuickStep(context);
		}

		if(currentProject) {
			vscode.commands.executeCommand("zephyr-workbench-app-explorer.clean.pristine", currentProject);
		}
	});

	vscode.commands.registerCommand('zephyr-workbench.debug-app', async () => {
		let currentProjectFolder = getCurrentWorkspaceFolder();
		if(currentProjectFolder === undefined ) {
			currentProjectFolder = await pickApplicationQuickStep(context);
		}

		if(currentProjectFolder) {
			vscode.commands.executeCommand("zephyr-workbench-app-explorer.debug-app", currentProjectFolder);
		}
	});

	vscode.commands.registerCommand('zephyr-workbench.open-webpage', async (site_url: string) => {
		if(site_url === 'Coming soon') {
			vscode.window.showInformationMessage('Tutorials are coming soon...');
		} else {
			const url = vscode.Uri.parse(site_url);
			vscode.env.openExternal(url);
		}
	});

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-west-workspace.open-wizard', async () => {
			if(await checkHostTools() && await checkEnvFile()) {
				CreateWestWorkspacePanel.render(context.extensionUri);
			} else {
				const installHostToolsItem = 'Install Host Tools';
				const choice = await vscode.window.showErrorMessage("Host tools are missing, please install them first", installHostToolsItem);
				if(choice === installHostToolsItem) {
					vscode.commands.executeCommand('zephyr-workbench.install-host-tools.open-manager');
				}
				return;
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.import-local", async (projectPath) => {
			if(projectPath) {
				CreateWestWorkspacePanel.currentPanel?.dispose();
				if(ZephyrProject.isZephyrProjectPath(projectPath)) {
					await addWorkspaceFolder(projectPath);
				} else {
					vscode.window.showErrorMessage("The folder is not a Zephyr project");
				}
			} else {
				vscode.window.showErrorMessage("The selected location folder is invalid");
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.build-app', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem | vscode.WorkspaceFolder, configName?: string) => {
			await executeConfigTask('West Build', node, configName);

			// After first build, parse toolchain name from .config
			let folder: vscode.WorkspaceFolder | undefined = undefined;
			let boardIdentifier: string = '';
			if(node instanceof ZephyrApplicationTreeItem) {
				if(node.project) {
					folder = node.project.workspaceFolder;
					boardIdentifier = node.project.boardId;
				}
			} else if(node instanceof ZephyrConfigTreeItem) {
				if(node.project) {
					folder = node.project.workspaceFolder;
					boardIdentifier = node.buildConfig.boardIdentifier;
				}
			} else {
				folder = node;
			}

			if(folder) {
				let gccPath: string | undefined = vscode.workspace.getConfiguration('C_Cpp', folder).get('default.compilerPath');
				if(gccPath && gccPath.includes('undefined')) {
					const project = new ZephyrAppProject(folder, folder.uri.fsPath);
					
					// Use-case if build out of APPLICATIONS view, means from WorkspaceFolder 
					// Cannot know board identifier beforehand so detect if after parsing settings.json
					// On non-legacy project, assume first config can be "master"
					if(boardIdentifier.length === 0) {
						if(project.boardId) {
							boardIdentifier = project.boardId;
						} else {
							boardIdentifier = project.configs[0].boardIdentifier;
						}
					}
					await updateCompileSetting(project, boardIdentifier);
				}
			}
		})
		
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.clean.pristine', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem | vscode.WorkspaceFolder, configName?: string) => {
			await executeConfigTask('West Rebuild', node, configName);
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.clean.delete', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {
			let context: any;
			let buildDir: string;
			if(node instanceof ZephyrApplicationTreeItem) {
				if(node.project) {
					context = node.project;
					buildDir = 'build';
				}
			} else if(node instanceof ZephyrConfigTreeItem) {
				if(node.project) {
					context = node.project;
					buildDir = node.buildConfig.relativeBuildDir;
				}
			}
			
			if(node.project) {
				vscode.window.withProgress({
						location: vscode.ProgressLocation.Notification,
						title: "Deleting Zephyr Application build directory",
						cancellable: false,
					}, async () => {
						deleteFolder(path.join(node.project.folderPath, buildDir));
					}
				);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.guiconfig-app', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {
			await executeConfigTask('Gui config', node);
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.menuconfig-app', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {
			await executeConfigTask('Menuconfig', node);
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.hardenconfig-app', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {
			await executeConfigTask('Harden Config', node);
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.run-app', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {
			await executeConfigTask('West Flash', node);
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.debug-app', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem | vscode.WorkspaceFolder) => {
			let workspaceFolder: any = node ;
			let project: ZephyrProject | undefined = undefined;
			let buildConfigName: string | undefined = undefined;
			if(node instanceof ZephyrApplicationTreeItem) {
				if(node.project) {
					project = node.project;
					workspaceFolder = node.project.workspaceFolder;

					if(node.project.configs && node.project.configs.length === 1) {
						buildConfigName = node.project.configs[0].name;
					}
				}
			} else if(node instanceof ZephyrConfigTreeItem) {
				if(node.project && node.buildConfig) {
					project = node.project;
					workspaceFolder = node.project.workspaceFolder;
					buildConfigName = node.buildConfig.name;
				}
			} else {
				project = await getZephyrProject(node.uri.fsPath);
			}

			if(!buildConfigName && project) {
				if(project.configs.length > 1) {
					let activeConfigName = undefined;
					for(let config of project.configs) {
						if(config.active) {
							activeConfigName = config.name;
							break;
						}
					}
					
					if(activeConfigName) {
						buildConfigName = activeConfigName;
					} else {
						vscode.window.showInformationMessage("No active configuration found, please set one as active first.");
						// If multiple build configs exist, ask user to select one
						buildConfigName = await pickBuildConfigQuickStep(project);
					}
				} else if(project.configs.length === 1) {
					// If only one build config exists, use it as default
					buildConfigName = project.configs[0].name;
				} else {
					// For legacy compatibility
					buildConfigName = undefined;
				}
			}
			
			if(workspaceFolder) {
				// Search for existing launch configuration
				const launchConfig = vscode.workspace.getConfiguration('launch', workspaceFolder.uri);
				if(launchConfig) {
					const configurations: vscode.DebugConfiguration[] = launchConfig.get('configurations', []);
					if(configurations) {
						let configName = ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME;
						if(buildConfigName) {
							configName = `${ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME} [${buildConfigName}]`;
						}
						if(configurations.some((config: { name: string }) => (config !== null) && (config.name === configName))) {
							await vscode.debug.startDebugging(workspaceFolder, configName);
							return;
						}
					}
				}
				
				// Open Debug Manager if no launch configuration is found
				vscode.commands.executeCommand('zephyr-workbench.debug-manager', node);
			}

		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.spdx.install-dependencies', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem ) => {
			vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "Create new local environment for SDPX",
				cancellable: false,
			}, async () => {
				await createLocalVenvSPDX(context, node.project.workspaceFolder);
			}
		);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.spdx.analyze.ntia-checker', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem ) => {
			if(node.project) {
				let parentUri;
				if(node instanceof ZephyrApplicationTreeItem) {
					if(node.project) {
						const buildUri = vscode.Uri.file(node.project.configs[0].getBuildDir(node.project));
						parentUri = vscode.Uri.joinPath(buildUri, 'spdx');
					}
				} else if(node instanceof ZephyrConfigTreeItem) {
					if(node.project) {
						const buildUri = vscode.Uri.file(node.buildConfig.getBuildDir(node.project));
						parentUri = vscode.Uri.joinPath(buildUri, 'spdx');
					}
				} 
				if(parentUri && fileExists(parentUri.fsPath)) {
					const spdxFile = await openSPDXDialog(parentUri);
					if(spdxFile) {
						await execNtiaCheckerCommand(spdxFile.fsPath, node.project);
					}
				} else {
					vscode.window.showErrorMessage("No SPDX file to analyze");
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.spdx.analyze.sbom2doc', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem ) => {
			if(node.project) {
				let parentUri;
				if(node instanceof ZephyrApplicationTreeItem) {
					if(node.project) {
						const buildUri = vscode.Uri.file(node.project.configs[0].getBuildDir(node.project));
						parentUri = vscode.Uri.joinPath(buildUri, 'spdx');
						
					}
				} else if(node instanceof ZephyrConfigTreeItem) {
					if(node.project) {
						const buildUri = vscode.Uri.file(node.buildConfig.getBuildDir(node.project));
						parentUri = vscode.Uri.joinPath(buildUri, 'spdx');
					}
				} 
				if(parentUri) {
					const spdxFile = await openSPDXDialog(parentUri);
					if(spdxFile) {
						await execSBom2DocCommand(spdxFile.fsPath, node.project);
					}
				} else {
					vscode.window.showErrorMessage("No SPDX file to analyze");
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.spdx.analyze.cve-bin-tool', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem ) => {
			if(node.project) {
				let parentUri;
				if(node instanceof ZephyrApplicationTreeItem) {
					if(node.project) {
						const buildUri = vscode.Uri.file(node.project.configs[0].getBuildDir(node.project));
						parentUri = vscode.Uri.joinPath(buildUri, 'spdx');
						
					}
				} else if(node instanceof ZephyrConfigTreeItem) {
					if(node.project) {
						const buildUri = vscode.Uri.file(node.buildConfig.getBuildDir(node.project));
						parentUri = vscode.Uri.joinPath(buildUri, 'spdx');
					}
				} 
				if(parentUri) {
					const spdxFile = await openSPDXDialog(parentUri);
					if(spdxFile) {
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
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.spdx.build', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem ) => {
			let buildDir: string;
			let source: any;
			let workspaceFolder: vscode.WorkspaceFolder = node.project.workspaceFolder;
			if(node instanceof ZephyrApplicationTreeItem) {
				if(node.project) {
					buildDir = 'build';
					source = node.project.configs[0];
				}
			} else if(node instanceof ZephyrConfigTreeItem) {
				if(node.project) {
					buildDir = node.buildConfig.relativeBuildDir;
					source = node.buildConfig;
				}
			} 
			
			// Delete build directory before SPDX init
			if(node.project) {
				vscode.window.withProgress({
						location: vscode.ProgressLocation.Notification,
						title: "Deleting Zephyr Application build directory",
						cancellable: false,
					}, async () => {
						deleteFolder(path.join(node.project.folderPath, buildDir));
					}
				);
			}

			try {
				if(source) {
					await executeConfigTask('Init SPDX', node);
					await saveConfigSetting(workspaceFolder, source.name, ZEPHYR_BUILD_CONFIG_WEST_ARGS_SETTING_KEY, appendBuildOutputMeta(source.westArgs));
					msleep(200);
					await executeConfigTask('West Build', node);
					await saveConfigSetting(workspaceFolder, source.name, ZEPHYR_BUILD_CONFIG_WEST_ARGS_SETTING_KEY, source.westArgs);
					msleep(200);
					await executeConfigTask('Generate SPDX', node);
				}
			} catch (error) {
        vscode.window.showErrorMessage(`Error executing tasks: ${error}`);
    	}

			function appendBuildOutputMeta(input: string): string {
				if(input) {
					if(input.includes('CONFIG_BUILD_OUTPUT_META=y')) {
						return input;
					} else if(input.includes('--')) {
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
			if(node.project) {
				removeWorkspaceFolder(node.project.workspaceFolder);
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.delete", async (node: ZephyrApplicationTreeItem) => {
			if(node.project) {
				if(await showConfirmMessage(`Delete ${node.project.folderName} permanently ?`)) {
					vscode.window.withProgress({
							location: vscode.ProgressLocation.Notification,
							title: "Deleting Zephyr Application",
							cancellable: false,
						}, async () => {
							removeWorkspaceFolder(node.project.workspaceFolder);
							deleteFolder(node.project.sourceDir);
						}
					);
				}
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.set-venv", async (node: ZephyrApplicationTreeItem) => {
			vscode.commands.executeCommand('workbench.action.openSettings', `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY}`);
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.create-venv", async (node: ZephyrApplicationTreeItem) => {
			vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: "Create new local environment",
					cancellable: false,
				}, async () => {
					let venvPath = await createLocalVenv(context, node.project.workspaceFolder);
					await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, node.project.workspaceFolder).update(ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY, venvPath, vscode.ConfigurationTarget.WorkspaceFolder);
				}
			);
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.reveal-os', async (node: ZephyrApplicationTreeItem) => {
			if(node.project.workspaceFolder) {
				vscode.commands.executeCommand('revealFileInOS', node.project.workspaceFolder.uri);
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.reveal-explorer', async (node: ZephyrApplicationTreeItem) => {
			if(node.project.workspaceFolder) {
				vscode.commands.executeCommand('revealInExplorer', node.project.workspaceFolder.uri);
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.change-board', async (node: ZephyrApplicationBoardTreeItem | ZephyrApplicationTreeItem | ZephyrConfigTreeItem | ZephyrConfigBoardTreeItem) => {
			if(node.project) {
				const boardId = await changeBoardQuickStep(context, node.project);
				if(boardId) {
					if(node instanceof ZephyrConfigTreeItem) {
						await saveConfigSetting(node.project.workspaceFolder, node.buildConfig.name, ZEPHYR_PROJECT_BOARD_SETTING_KEY, boardId);
					} else if(node instanceof ZephyrConfigBoardTreeItem) {
						await saveConfigSetting(node.project.workspaceFolder, node.config.name, ZEPHYR_PROJECT_BOARD_SETTING_KEY, boardId);
					} else if(node instanceof ZephyrApplicationBoardTreeItem || node instanceof ZephyrApplicationTreeItem) {
						if(node.project.configs && node.project.configs.length === 1) {
							await saveConfigSetting(node.project.workspaceFolder, node.project.configs[0].name, ZEPHYR_PROJECT_BOARD_SETTING_KEY, boardId);
						} else {
							// For legacy compatibility
						// Keep supporting edit board from project
						await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, node.project.workspaceFolder).update(ZEPHYR_PROJECT_BOARD_SETTING_KEY, boardId, vscode.ConfigurationTarget.WorkspaceFolder);
						}
					}
					
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.change-west-workspace', async (node: ZephyrApplicationWestWorkspaceTreeItem | ZephyrApplicationTreeItem) => {
			if(node.project) {
				const westWorkspacePath = await changeWestWorkspaceQuickStep(context, node.project);
				if(westWorkspacePath) {
					await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, node.project.workspaceFolder).update(ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY, westWorkspacePath, vscode.ConfigurationTarget.WorkspaceFolder);
				}
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.change-pristine", async (node: ZephyrApplicationTreeItem) => {
			if(node.project) {
				let workspaceFolder = node.project.workspaceFolder;
				let pristineValue = await showPristineQuickPick();
				await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).update(ZEPHYR_WORKBENCH_BUILD_PRISTINE_SETTING_KEY, pristineValue, vscode.ConfigurationTarget.WorkspaceFolder);
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.open-terminal', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {
			if(node instanceof ZephyrApplicationTreeItem) {
				if(node.project) {
					if(node.project.configs && node.project.configs.length === 1) {
						let terminal: vscode.Terminal = ZephyrProjectBuildConfiguration.getTerminal(node.project, node.project.configs[0]);
						terminal.show();
					} else {
						let terminal: vscode.Terminal = ZephyrProject.getTerminal(node.project);
						terminal.show();
					}		
				}
			} else if(node instanceof ZephyrConfigTreeItem) {
				if(node.buildConfig) {
					let terminal: vscode.Terminal = ZephyrProjectBuildConfiguration.getTerminal(node.project, node.buildConfig);
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
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.memory-analysis.puncover', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem | vscode.WorkspaceFolder) => {
			let folder: any = node ;
			if(node instanceof ZephyrApplicationTreeItem) {
				if(node.project) {
					folder = node.project.workspaceFolder;
				}
			}

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
			if(node.project) {
				let newConfig = new ZephyrProjectBuildConfiguration('');
				let configName = await setConfigQuickStep(newConfig, node.project);
				if(configName) {
					newConfig.active = false;
					newConfig.name = configName;
					let boardId = await changeBoardQuickStep(context, node.project);
					if(boardId) {
						newConfig.boardIdentifier = boardId;
						node.project.addBuildConfiguration(newConfig);
						await addConfig(node.project.workspaceFolder, newConfig);
					}
				}
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.delete-config', async (node: ZephyrConfigTreeItem) => {
			if(node.project.configs.length <= 1) {
				vscode.window.showErrorMessage("One build configuration is required, firstly create a new one before deleting.");
			} else {
				if(node.buildConfig) {
					let confirm = await showConfirmMessage("Are you sure you want to delete this configuration ?");
					if(confirm) {
						await deleteConfig(node.project.workspaceFolder, node.buildConfig);
					}
				}
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.rename-config', async (node: ZephyrConfigTreeItem) => {
			if(node.buildConfig) {
				const oldConfigName = node.buildConfig.name;
				let newConfigName = await setConfigQuickStep(node.buildConfig, node.project);
				if(newConfigName) {
					node.buildConfig.name = newConfigName;
					await saveConfigSetting(node.project.workspaceFolder, oldConfigName, 'name', newConfigName);
				}
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.activate-config', async (node: ZephyrConfigTreeItem) => {
			if(node.buildConfig) {
				node.buildConfig.active = true;
				
				let activeIndex = 0;
				for(let configIndex = 0; configIndex < node.project.configs.length; configIndex++) {
					if(node.project.configs[configIndex].name !== node.buildConfig.name) {
						await saveConfigSetting(node.project.workspaceFolder, node.project.configs[configIndex].name, 'active', '');
					} else {
						let buildDir = path.join('${workspaceFolder}', 'build', node.buildConfig.name);
						await saveConfigSetting(node.project.workspaceFolder, node.buildConfig.name, 'active', 'true');
						await vscode.workspace.getConfiguration('C_Cpp', node.project.workspaceFolder).update('default.compileCommands', path.join(buildDir, 'compile_commands.json'), vscode.ConfigurationTarget.WorkspaceFolder);
						activeIndex = configIndex;
					}
				}
				updateTasks(node.project.workspaceFolder, node.buildConfig.name, activeIndex);
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.deactivate-config', async (node: ZephyrConfigTreeItem) => {
			if(node.buildConfig) {
				node.buildConfig.active = true;
				await saveConfigSetting(node.project.workspaceFolder, node.buildConfig.name, 'active', "");
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-west-workspace.open-terminal', async (node: WestWorkspaceTreeItem) => {
			if(node.westWorkspace) {
				let terminal: vscode.Terminal = WestWorkspace.getTerminal(node.westWorkspace);
				terminal.show();
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-west-workspace.update', async (node: WestWorkspaceTreeItem) => {
			if(node.westWorkspace) {
				await westUpdateCommand(node.westWorkspace.rootUri.fsPath);
				await westBoardsCommand(node.westWorkspace.rootUri.fsPath);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-west-workspace.delete", async (node: WestWorkspaceTreeItem) => {
			if(node.westWorkspace) {
				if(await showConfirmMessage(`Delete ${node.westWorkspace.name} permanently ?`)) {
					vscode.window.withProgress({
							location: vscode.ProgressLocation.Notification,
							title: "Deleting West Workspace",
							cancellable: false,
						}, async () => {
							let workspaceFolder = getWorkspaceFolder(node.westWorkspace.rootUri.fsPath);
							if(workspaceFolder) {
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
		vscode.commands.registerCommand("zephyr-workbench.env.add", async (node: any ) => {
			if(node instanceof WestWorkspaceEnvTreeItem) {
				if(node.westWorkspace) {
					const westWorkspace = node.westWorkspace;
					let value = await changeEnvVarQuickStep(westWorkspace, node.envKey);
					if(value) {
						addEnvValue(westWorkspace.envVars, node.envKey, value);
						let workspaceFolder = getWorkspaceFolder(westWorkspace.rootUri.fsPath);
						if(workspaceFolder) {
							await saveEnv(workspaceFolder, node.envKey, westWorkspace.envVars[node.envKey]);
						}
					}
					westWorkspaceProvider.refresh();
				}
			} else if(node instanceof ZephyrApplicationEnvTreeItem) {
				if(node.project) {
					const project = node.project;
					let value = await changeEnvVarQuickStep(project, node.envKey);
					if(value) {
						addEnvValue(project.envVars, node.envKey, value);
						let workspaceFolder = getWorkspaceFolder(project.folderPath);
						if(workspaceFolder) {
							await saveEnv(workspaceFolder, node.envKey, project.envVars[node.envKey]);
						}
					}
					zephyrAppProvider.refresh();
				}
			} else if(node instanceof ZephyrConfigEnvTreeItem) {
				if(node.config) {
					const project = node.project;
					const config = node.config;
					let value = await changeEnvVarQuickStep(config, node.envKey);
					if(value) {
						addEnvValue(config.envVars, node.envKey, value);
						let workspaceFolder = getWorkspaceFolder(project.folderPath);
						if(workspaceFolder) {
							await saveConfigEnv(workspaceFolder, config.name, node.envKey, config.envVars[node.envKey]);
						}
					}
					zephyrAppProvider.refresh();
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench.env.edit", async (node: any ) => {
			if(node instanceof WestWorkspaceEnvValueTreeItem) {
				if(node.westWorkspace) {
					const westWorkspace = node.westWorkspace;
					let value = await changeEnvVarQuickStep(westWorkspace, node.envKey, node.envValue);
					if(value) {
						replaceEnvValue(westWorkspace.envVars, node.envKey,  node.envValue, value);
						let workspaceFolder = getWorkspaceFolder(westWorkspace.rootUri.fsPath);
						if(workspaceFolder) {
							await saveEnv(workspaceFolder, node.envKey, westWorkspace.envVars[node.envKey]);
						}
					}
					westWorkspaceProvider.refresh();
				}
			} else if(node instanceof ZephyrApplicationEnvValueTreeItem) {
				if(node.project) {
					const project = node.project;
					let value = await changeEnvVarQuickStep(project, node.envKey, node.envValue);
					if(value) {
						replaceEnvValue(project.envVars, node.envKey,  node.envValue, value);
						let workspaceFolder = getWorkspaceFolder(project.folderPath);
						if(workspaceFolder) {
							await saveEnv(workspaceFolder, node.envKey, project.envVars[node.envKey]);
						}
					}
					zephyrAppProvider.refresh();
				}
			} else if(node instanceof ZephyrConfigEnvValueTreeItem) {
				if(node.config) {
					const project = node.project;
					const config = node.config;
					let value = await changeEnvVarQuickStep(config, node.envKey, node.envValue);
					if(value) {
						replaceEnvValue(config.envVars, node.envKey,  node.envValue, value);
						let workspaceFolder = getWorkspaceFolder(project.folderPath);
						if(workspaceFolder) {
							await saveConfigEnv(workspaceFolder, config.name, node.envKey, config.envVars[node.envKey]);
						}
					}
					zephyrAppProvider.refresh();
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench.env.delete", async (node: any ) => {
			if(node instanceof WestWorkspaceEnvValueTreeItem) {
				if(node.westWorkspace) {
					const westWorkspace = node.westWorkspace;
					removeEnvValue(westWorkspace.envVars, node.envKey,  node.envValue);
					let workspaceFolder = getWorkspaceFolder(westWorkspace.rootUri.fsPath);
					if(workspaceFolder) {
						await saveEnv(workspaceFolder, node.envKey, westWorkspace.envVars[node.envKey]);
					}
					westWorkspaceProvider.refresh();
				}
			} else if(node instanceof ZephyrApplicationEnvValueTreeItem) {
				if(node.project) {
					const project = node.project;
					removeEnvValue(project.envVars, node.envKey,  node.envValue);
					let workspaceFolder = getWorkspaceFolder(project.folderPath);
					if(workspaceFolder) {
						await saveEnv(workspaceFolder, node.envKey, project.envVars[node.envKey]);
					}
					zephyrAppProvider.refresh();
				}
			} else if(node instanceof ZephyrConfigEnvValueTreeItem) {
				if(node.config) {
					const project = node.project;
					const config = node.config;
					removeEnvValue(config.envVars, node.envKey,  node.envValue);
					let workspaceFolder = getWorkspaceFolder(project.folderPath);
					if(workspaceFolder) {
						await saveConfigEnv(workspaceFolder, config.name, node.envKey, config.envVars[node.envKey]);
					}
					zephyrAppProvider.refresh();
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench.arg.edit", async (node: any) => {
			if(node.project) {
				const project = node.project;
				let context = node.project;
				if(node.config) {
					context = node.config;
				}

				let value = await changeEnvVarQuickStep(context, 'west arguments', context.westArgs);
				if(value !== undefined) {
					context.westArgs = value;
					let workspaceFolder = getWorkspaceFolder(project.folderPath);
					if(workspaceFolder) {
						if(context === project) {
							await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).update(ZEPHYR_PROJECT_EXTRA_WEST_ARGS_SETTING_KEY, context.westArgs);
						} else {
							await saveConfigSetting(workspaceFolder, context.name, ZEPHYR_BUILD_CONFIG_WEST_ARGS_SETTING_KEY, context.westArgs);
						}
					}
				}
				zephyrAppProvider.refresh();
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench.install-host-tools", async (force = false, skipSdk = false, listToolchains = "") => {
			vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "Installing host tools",
				cancellable: true,
				}, async (progress, token) => {
					SDKManagerPanel.currentPanel?.dispose();
					
					if(!force) {
						await runInstallHostTools(context, skipSdk, listToolchains, progress, token);
					} else {
						await forceInstallHostTools(context, skipSdk, listToolchains, progress, token);
					}
					
					zephyrSdkProvider.refresh();
					zephyrShortcutProvider.refresh();
					zephyrToolsCommandProvider.refresh();
				}
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench.install-host-tools.open-manager", async (force = false) => {
			// FIXME: ByPass SDK Manager for now. Uncomment when ready
			//SDKManagerPanel.render(context.extensionUri, force);

			// TODO: When SDKManagerPanel will be used, remove this line 
			if(process.platform === 'darwin') {
				try {
					const isHomebrewInstalled = await checkHomebrew();
					if (isHomebrewInstalled) {
						console.log('Homebrew is installed.');
					} else {
						vscode.window.showErrorMessage('Homebrew is not installed or not in your PATH. Please install it first.');
						return;
					}
				} catch (error) {
					vscode.window.showErrorMessage('Homebrew is not installed or not in your PATH. Please install it first.');
					return;
				}
			}

			if(force) {
				const choice = await showConfirmMessage("Are you certain you want to reinstall the host tools ?");
				if(choice) {
					vscode.commands.executeCommand('zephyr-workbench.install-host-tools', force, true, "");
				} else {
					return;
				}
			} else {
				vscode.commands.executeCommand('zephyr-workbench.install-host-tools', false, true, "");
			}
			
		})
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
				} catch (error) {

					if (error instanceof Error) {
						if((error as any).cause.startsWith(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)) {
							const openSettingItem = 'Open Setting';
							const choice = await vscode.window.showErrorMessage(`Fail verifying tools...\n${error}`, openSettingItem);
							if(choice === openSettingItem) {
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
		vscode.commands.registerCommand("zephyr-workbench.install-debug-tools", async () => {
			DebugToolsPanel.render(context.extensionUri);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench.debug-manager", async (node: any) => {
			let project = undefined;
			let buildConfig = undefined;
			if(node) {
				if(node.project) {
					project = node.project;
				} 
				if(node.buildConfig) {
					buildConfig = node.buildConfig;
				}
			}
			DebugManagerPanel.render(context.extensionUri, project, buildConfig);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench.debug-manager.debug", async (folder: vscode.WorkspaceFolder, configName: string) => {
			DebugManagerPanel.currentPanel?.dispose();
			await vscode.debug.startDebugging(folder, configName);
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
				for(let tool of listTools) {
					let runner = getRunner(tool.tool);
					
					if(runner && runner.executable) {
						let runnerPath = path.join(getInternalToolsDirRealPath(), runner.name, runner.binDirPath, runner.executable);
						if(fileExists(runnerPath)) {
							runner.serverPath = runnerPath;
							await runner.updateSettings();
						}
					}
					panel.webview.postMessage({ command: 'exec-done', tool: `${tool.tool}` });
				}
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-sdk-explorer.open-wizard", async () => {
			ImportZephyrSDKPanel.render(context.extensionUri);
		})
  );

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-sdk-explorer.import-official-sdk", async (sdkType, sdkVersion, listToolchains, parentPath) => {
			if(sdkType && sdkVersion && parentPath) {
				ImportZephyrSDKPanel.currentPanel?.dispose();
				vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: "Importing Zephyr SDK",
					cancellable: true,
				}, async (progress, token) => {
					let toolchains = listToolchains.split(' ');
					let urls = generateSdkUrls(sdkType, sdkVersion, toolchains);

					try {
						let url = urls[0];
						if(url) {
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
							if(urls.length > 1) {
								for(let i=1; i<urls.length; i++) {
									progress.report({
										message: `Download ${urls[i]}`,
									});
									let downloadedFileUri = await download(urls[i], parentPath, context, progress, token);
									progress.report({
										message: `Extracting ${downloadedFileUri}`,
									});
									await extractSDK(downloadedFileUri.fsPath, zephyrSDKPath, progress, token);
								}
							}

							progress.report({
								message: `Importing SDK done`,
								increment: 60,
							});
							
							// Register the SDK into settings
							if(zephyrSDKPath) {
								await registerZephyrSDK(zephyrSDKPath);
								await cleanupDownloadDir(context);
							}
						}
					} catch(e: any) {
						if(e.code === 'ERR_STREAM_PREMATURE_CLOSE') {
							vscode.window.showInformationMessage("Download cancelled");
						} else if(e.code === 'TAR_BAD_ARCHIVE') {
							vscode.window.showErrorMessage("Extracting SDK failed");
						} else {
							vscode.window.showErrorMessage("Download failed: " + e);
						}
					}		
					progress.report({message:'Importing SDK done', increment: 100});
					zephyrSdkProvider.refresh();
				});
			} else {
				vscode.window.showErrorMessage('Missing information to download SDK');
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-sdk-explorer.import-remote-sdk", async (remotePath, parentPath) => {
			if(remotePath && parentPath) {
				ImportZephyrSDKPanel.currentPanel?.dispose();
				vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: "Importing Zephyr SDK",
					cancellable: true,
				}, async (progress, token) => {
					try {
						if(remotePath && parentPath) {
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
							if(zephyrSDKPath) {
								await registerZephyrSDK(zephyrSDKPath);
								await cleanupDownloadDir(context);
							}
						}
					} catch(e: any) {
						if(e.code === 'ERR_STREAM_PREMATURE_CLOSE') {
							vscode.window.showInformationMessage("Download cancelled");
						} else if(e.code === 'TAR_BAD_ARCHIVE') {
							vscode.window.showErrorMessage("Extracting SDK failed");
						} else {
							vscode.window.showErrorMessage("Download failed: " + e);
						}
					}		
					progress.report({message:'Importing SDK done', increment: 100});
					zephyrSdkProvider.refresh();
				});
			} else {
				vscode.window.showErrorMessage('Missing information to download SDK');
			}
		})
	);
			

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-sdk-explorer.import-local-sdk", async (sdkPath) => {
			if(sdkPath) {
				ImportZephyrSDKPanel.currentPanel?.dispose();
				if(ZephyrSDK.isSDKPath(sdkPath)) {
					await registerZephyrSDK(sdkPath);
					zephyrSdkProvider.refresh();
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
		vscode.commands.registerCommand("zephyr-workbench-sdk-explorer.remove-sdk", async (node: ZephyrSdkTreeItem) => {
			if(node.sdk) {
				if(await showConfirmMessage(`Remove ${node.sdk.name} from workspace ?`)) {
					await unregisterZephyrSDK(node.sdk.rootUri.fsPath);
					zephyrSdkProvider.refresh();
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-sdk-explorer.delete", async (node: ZephyrSdkTreeItem) => {
			if(node.sdk) {
				if(await showConfirmMessage(`Delete ${node.sdk.name} permanently ?`)) {
					vscode.window.withProgress({
						location: vscode.ProgressLocation.Notification,
						title: "Deleting Zephyr SDK",
						cancellable: false,
						}, async () => {
							await unregisterZephyrSDK(node.sdk.rootUri.fsPath);
							deleteFolder(node.sdk.rootUri.fsPath);
						}
					);
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.open-wizard", async () => {
			if(getWestWorkspaces().length === 0) {
				const initWorkspaceItem = 'Initialize Workspace';
				const choice = await vscode.window.showErrorMessage("No west workspace found. Please initialize a workspace first.", initWorkspaceItem);
				if(choice === initWorkspaceItem) {
					vscode.commands.executeCommand('zephyr-workbench-west-workspace.open-wizard');
				}
				return;
			} 
			if((await getListZephyrSDKs()).length === 0) {
				const importSDKItem = 'Import SDK';
				const choice = await vscode.window.showErrorMessage("No Zephyr SDK found. Please import a SDK first.", importSDKItem);
				if(choice === importSDKItem) {
					vscode.commands.executeCommand('zephyr-workbench-sdk-explorer.open-wizard');
				}
				return;
			} 

			CreateZephyrAppPanel.render(context.extensionUri);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.import-app-wizard", async () => {
			if(getWestWorkspaces().length === 0) {
				const initWorkspaceItem = 'Initialize Workspace';
				const choice = await vscode.window.showErrorMessage("No west workspace found. Please initialize a workspace first.", initWorkspaceItem);
				if(choice === initWorkspaceItem) {
					vscode.commands.executeCommand('zephyr-workbench-west-workspace.open-wizard');
				}
				return;
			} 
			if((await getListZephyrSDKs()).length === 0) {
				const importSDKItem = 'Import SDK';
				const choice = await vscode.window.showErrorMessage("No Zephyr SDK found. Please import a SDK first.", importSDKItem);
				if(choice === importSDKItem) {
					vscode.commands.executeCommand('zephyr-workbench-sdk-explorer.open-wizard');
				}
				return;
			} 
			importProjectQuickStep(context);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.create-app", async (westWorkspace, zephyrSample, zephyrBoard, projectLoc = '', projectName = '', zephyrSDK, pristineValue = 'auto') => {
			if(!westWorkspace) {
				vscode.window.showErrorMessage('Missing west workspace, please select a west workspace');
				return;
			}

			if(!zephyrSDK) {
				vscode.window.showErrorMessage('Missing Zephyr SDK, a SDK is required to provide toolchain to your project');
				return;
			}

			if(!projectName || projectName.length === 0) {
				vscode.window.showErrorMessage('The project name is empty or invalid');
				return;
			}

			if(!zephyrBoard) {
				vscode.window.showErrorMessage('Missing target board');
				return;
			}
			
			if(!zephyrSample) {
				vscode.window.showErrorMessage('Missing selected sample, it serves as base for your project');
				return;
			}

			if(!fileExists(projectLoc)) {
				vscode.window.showErrorMessage(`Project destination location "${projectLoc}" does not exists`);
				return;
			}
			
			vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
								title: "Creating new application...",
								cancellable: false,
				}, async (progress, token) => {
					let projLoc: string;
					if(projectLoc.length === 0) {
						projLoc = zephyrSample.rootDir.fsPath;
					} else {
						let projectPath = path.join(projectLoc, projectName);
						if(fileExists(projectPath)) {
							vscode.window.showErrorMessage(`The folder [${projectPath}] already exists. Please change the project name or its location.`);
							return;
						}
						projLoc = copySampleSync(zephyrSample.rootDir.fsPath, projectPath);
					}
					await addWorkspaceFolder(projLoc);

					let workspaceFolder = getWorkspaceFolder(projLoc);
					if(workspaceFolder) {
						await setDefaultProjectSettings(workspaceFolder, westWorkspace, zephyrBoard, zephyrSDK);
						await createTasksJson(workspaceFolder);
						await createExtensionsJson(workspaceFolder);
						await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).update(ZEPHYR_WORKBENCH_BUILD_PRISTINE_SETTING_KEY, pristineValue, vscode.ConfigurationTarget.WorkspaceFolder);
						CreateZephyrAppPanel.currentPanel?.dispose();
						
						vscode.window.showInformationMessage(`New Application '${workspaceFolder.name}' created !`);
					}
				}
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.import-app", async (projectLoc, westWorkspace, zephyrBoard, zephyrSDK) => {
			if(!fileExists(projectLoc)) {
				vscode.window.showInformationMessage(`Project '${projectLoc}' not found !`);
				return;
			}
			
			await addWorkspaceFolder(projectLoc);

			let workspaceFolder = getWorkspaceFolder(projectLoc);
			if (workspaceFolder && westWorkspace && zephyrBoard && zephyrSDK) {
        await setDefaultProjectSettings(workspaceFolder, westWorkspace, zephyrBoard, zephyrSDK);
        await createTasksJson(workspaceFolder);
        await createExtensionsJson(workspaceFolder);
				vscode.window.showInformationMessage(`Creating Application '${workspaceFolder.name}' done`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-module-explorer.create-module", async () => {
			// if(workspacePath) {
			// 	CreateZephyrModulePanel.render(context.extensionUri);
			// }
			//await installZephyrSdk(context);
    })
  );

	context.subscriptions.push(vscode.window.registerTerminalProfileProvider('zephyr-workbench.terminal', {
		provideTerminalProfile(token: vscode.CancellationToken): vscode.ProviderResult<vscode.TerminalProfile> {
			let opts: vscode.TerminalOptions = {
				name: "Zephyr BuildSystem Terminal",
				shellPath: "bash",
				env: getZephyrEnvironment(),
			};
			return new vscode.TerminalProfile(opts);
		}
	}));

	context.subscriptions.push(
		vscode.commands.registerCommand("west.init", async (srcUrl, srcRev, workspaceDestPath, manifestPath) => {
			if(workspaceDestPath && !isWorkspaceFolder(workspaceDestPath)) {
				vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: "Initializing west workspace",
					cancellable: false,
				}, async (progress, token) => {
					try {
						await westInitCommand(srcUrl, srcRev, workspaceDestPath, manifestPath);
						await westUpdateCommand(workspaceDestPath);
						await westBoardsCommand(workspaceDestPath);
						CreateWestWorkspacePanel.currentPanel?.dispose();
						await addWorkspaceFolder(workspaceDestPath);
						
						// Update settings.json to avoid CMake automatic scan after importing west workspace
						const workspaceFolder = getWorkspaceFolder(workspaceDestPath);
						await vscode.workspace.getConfiguration('cmake', workspaceFolder).update('enableAutomaticKitScan', false, vscode.ConfigurationTarget.WorkspaceFolder);
						westWorkspaceProvider.refresh();
					} catch(e) {
						if (e instanceof Error) {
							if((e as any).cause.startsWith(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)) {
								const openSettingItem = 'Open Setting';
								const choice = await vscode.window.showErrorMessage(`Fail to execute west init command...\n${e}`, openSettingItem);
								if(choice === openSettingItem) {
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
			if(workspaceDestPath && !isWorkspaceFolder(workspaceDestPath)) {
				CreateWestWorkspacePanel.currentPanel?.dispose();
				if(WestWorkspace.isWestWorkspacePath(workspaceDestPath)) {
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
		vscode.commands.registerCommand("zephyr-workbench-west-workspace.import-from-template", async (remotePath, remoteBranch, workspacePath, templateHal) => {
			if(remotePath && remoteBranch && workspacePath && templateHal ) {
				// Generate west.xml from template
				let manifestFile = generateWestManifest(context, remotePath, remoteBranch, workspacePath, templateHal);
				// Run west init to the newly create manifest
				vscode.commands.executeCommand("west.init", '', '', workspacePath, manifestFile);
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
		vscode.window.onDidChangeActiveTextEditor(updateStatusBar)
	);

	/* Listeners on workspace changes */
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders((event: vscode.WorkspaceFoldersChangeEvent) => {
			zephyrAppProvider.refresh();
			//zephyrModuleProvider.refresh();
			westWorkspaceProvider.refresh();
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(updateStatusBar)
	);

	/* Listeners on setttings changes */
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async (event) => {
			if (event.affectsConfiguration('tasks')) {
				zephyrAppProvider.refresh();
			}

			if(event.affectsConfiguration(ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY)) {
				zephyrSdkProvider.refresh();
			}

			if(event.affectsConfiguration(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY)) {
				zephyrShortcutProvider.refresh();
				zephyrToolsCommandProvider.refresh();
			}

			if(event.affectsConfiguration(`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_BOARD_SETTING_KEY}`) || 
				 event.affectsConfiguration(`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY}`) ||
				 event.affectsConfiguration(`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_SDK_SETTING_KEY}`) || 
				 event.affectsConfiguration(`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.build.configurations`)) {
				zephyrAppProvider.refresh();
			}
		})
	);

	setDefaultSettings();

	// For legacy compatibility
	// Upgrade project structure and settings
	{
		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Checking projects...",
			cancellable: false,
		}, async (progress, token) => {
			try {
				await convertLegacyProjects();
			} catch(e) {
				
			}	
		});

		async function convertLegacyProjects(): Promise<void> {
			if(vscode.workspace.workspaceFolders) {
				for(let workspaceFolder of vscode.workspace.workspaceFolders) {
					if(await ZephyrAppProject.isZephyrProjectWorkspaceFolder(workspaceFolder)) {
						const appProject = new ZephyrAppProject(workspaceFolder, workspaceFolder.uri.fsPath);
						if(appProject.configs.length === 0) {
							await convertLegacySettings(appProject);
						}
						await convertLegacyTasks(workspaceFolder);
					}
				}
			}
		}
	}
}

function getCurrentWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
	const editor = vscode.window.activeTextEditor;
	if(editor) {
			const resource = editor.document.uri;
			const folder = vscode.workspace.getWorkspaceFolder(resource);
			return folder;
	}
	return undefined;
}

async function updateStatusBar() {
	const currentFolder = getCurrentWorkspaceFolder();
	if(currentFolder && await ZephyrAppProject.isZephyrProjectWorkspaceFolder(currentFolder)) {
		statusBarBuildItem.tooltip = `Zephyr: Build ${currentFolder.name}`;
		statusBarDebugItem.tooltip = `Zephyr: Debug ${currentFolder.name}`;
		statusBarBuildItem.show();
		statusBarDebugItem.show();
	} else {
		statusBarBuildItem.hide();
		statusBarDebugItem.hide();
	}
}

async function updateCompileSetting(project: ZephyrAppProject, boardIdentifier: string) {
	const zephyrSDK = getZephyrSDK(project.sdkPath);
	const westWorkspace = getWestWorkspace(project.westWorkspacePath);
	const board = await getBoardFromIdentifier(boardIdentifier, westWorkspace);
	
	let socToolchainName = project.getKConfigValue('SOC_TOOLCHAIN_NAME');
	if(socToolchainName) {
		await vscode.workspace.getConfiguration('C_Cpp', project.workspaceFolder).update('default.compilerPath', zephyrSDK.getCompilerPath(board.arch, socToolchainName), vscode.ConfigurationTarget.WorkspaceFolder);
	}
}

export async function showConfirmMessage(message: string): Promise<boolean> {
	const yesItem = 'Yes';
	const noItem = 'No';
	const choice = await vscode.window.showWarningMessage(message, yesItem, noItem);
	return (choice === yesItem) ? true : false;
}

export async function executeConfigTask(taskName: string, node: any, configName?: string): Promise<vscode.TaskExecution[] | undefined> {
	let context: ZephyrProject | undefined = undefined;
	let folder: vscode.WorkspaceFolder | undefined = undefined;
	if(node instanceof ZephyrApplicationTreeItem) {
		if(node.project) {
			context = node.project;
			folder = node.project.workspaceFolder;
		}
	} else if(node instanceof ZephyrConfigTreeItem) {
		if(node.project) {
			context = node.project;
			folder = node.project.workspaceFolder;
			configName = node.buildConfig.name;
		}
	} else {
		context = await getZephyrProject(node.uri.fsPath);
		folder = node;
	}
	
	// Get list of task to execute
	let listTasks: vscode.Task[] = [];
	if(context && folder) {
		// IF: In configuration name is provided execute it
		// ELSE IF : run active if multiple build configurations
		// ELSE IF : run task if only one build configuration
		// ELSE [Legacy] run old build task 
		if(configName) {
			let task = await findConfigTask(taskName, context, configName);
			if(task) {
				listTasks.push(task);
			}
		} else if(context.configs && context.configs.length > 1) {
			for(let config of context.configs) {
				let hasActive = false;
				if(config.active) {
					hasActive = true;
					let task = await findConfigTask(taskName, context, config.name);
					if(task) {
						listTasks.push(task);
					}
				}

				if(!hasActive) {
					vscode.window.showInformationMessage("No active configuration found, please set one as active first.");
				}
			}
		} else if(context.configs && context.configs.length === 1) {
			let task = await findConfigTask(taskName, context, context.configs[0].name);
			if(task) {
				listTasks.push(task);
			}
		} else {
			// For legacy compatibility:
			// If the project settings.json doesn't have any build configuration
			let task = await findOrCreateTask(taskName, folder);
			if(task) {
				listTasks.push(task);
			}
		}
	}
	
	return new Promise<vscode.TaskExecution[] | undefined >(async resolve => {
		// Execute task
		if (listTasks.length > 0) {
			try {
				let tasksExec: vscode.TaskExecution[] = [];
				for(let task of listTasks) {
					tasksExec.push(await executeTask(task));
				}
				resolve(tasksExec);
			} catch (error) {
				vscode.window.showErrorMessage(`Error executing task: ${error}`);
				resolve(undefined);
			}
		} else {
			vscode.window.showErrorMessage(`Cannot find "${taskName}" task.`);
			resolve(undefined);
		}
	});
}

// This method is called when your extension is deactivated
export function deactivate() {
	zephyrTaskProvider?.dispose();
	zephyrDebugConfigurationProvide?.dispose();
}
