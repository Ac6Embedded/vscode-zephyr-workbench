// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import path from 'path';
import * as vscode from 'vscode';
import { execWestCommandWithEnv, westBoardsCommand, westDebugCommand, westFlashCommand, westInitCommand, westUpdateCommand } from './WestCommands';
import { WestWorkspace } from './WestWorkspace';
import { ZephyrAppProject } from './ZephyrAppProject';
import { ZephyrProject } from './ZephyrProject';
import { ZephyrSDK } from './ZephyrSDK';
import { ZephyrTaskProvider, createExtensionsJson, createTasksJson, setDefaultProjectSettings } from './ZephyrTaskProvider';
import { changeBoardQuickStep } from './changeBoardQuickStep';
import { changeWestWorkspaceQuickStep } from './changeWestWorkspaceQuickStep';
import { ZEPHYR_PROJECT_BOARD_SETTING_KEY, ZEPHYR_PROJECT_SDK_SETTING_KEY, ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY, ZEPHYR_WORKBENCH_BUILD_PRISTINE_SETTING_KEY, ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY, ZEPHYR_WORKBENCH_PATHTOENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_ACTIVATEPATH_SETTING_KEY } from './constants';
import { importProjectQuickStep } from './importProjectQuickStep';
import { checkEnvFile, checkHostTools, cleanupDownloadDir, createLocalVenv, download, execCommand, forceInstallHostTools, installHostDebugTools, installVenv, runInstallHostTools, setDefaultSettings, verifyHostTools } from './installUtils';
import { CreateWestWorkspacePanel } from './panels/CreateWestWorkspacePanel';
import { CreateZephyrAppPanel } from './panels/CreateZephyrAppPanel';
import { DebugToolsPanel } from './panels/DebugToolsPanel';
import { ImportZephyrSDKPanel } from './panels/ImportZephyrSDKPanel';
import { WestWorkspaceDataProvider, WestWorkspaceTreeItem } from './providers/WestWorkspaceDataProvider';
import { ZephyrApplicationBoardTreeItem, ZephyrApplicationDataProvider, ZephyrApplicationTreeItem, ZephyrApplicationWestWorkspaceTreeItem } from './providers/ZephyrApplicationProvider';
import { ZephyrHostToolsCommandProvider } from './providers/ZephyrHostToolsCommandProvider';
import { ZephyrOtherResourcesCommandProvider } from './providers/ZephyrOtherResourcesCommandProvider';
import { ZephyrSdkDataProvider, ZephyrSdkTreeItem } from "./providers/ZephyrSdkDataProvider";
import { ZephyrShortcutCommandProvider } from './providers/ZephyrShortcutCommandProvider';
import { extractSDK, generateSdkUrls, registerZephyrSDK, unregisterZephyrSDK } from './sdkUtils';
import { addWorkspaceFolder, copyFolder, deleteFolder, fileExists, findTask, getBoardFromId, getConfigValue, getInstallDirRealPath, getInternalToolsDirRealPath, getListZephyrSDKs, getWestWorkspace, getWestWorkspaces, getWorkspaceFolder, getZephyrSDK, isWorkspaceFolder, removeWorkspaceFolder } from './utils';
import { getZephyrEnvironment, getZephyrTerminal, runCommandTerminal } from './zephyrTerminalUtils';
import { showPristineQuickPick } from './setupBuildPristineQuickStep';
import { DebugManagerPanel } from './panels/DebugManagerPanel';
import { getRunner, ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME } from './debugUtils';
import { SDKManagerPanel } from './panels/SDKManagerPanel';
import { generateWestManifest } from './manifestUtils';
import { execCommandWithEnv } from './execUtils';

let statusBarBuildItem: vscode.StatusBarItem;
let statusBarDebugItem: vscode.StatusBarItem;
let zephyrTaskProvider: vscode.Disposable | undefined;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	const requiredExtensions = [
		'ms-vscode.cpptools',								// https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools
		'ms-vscode.cpptools-extension-pack',// https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools-extension-pack
		'ms-vscode.vscode-serial-monitor',  // https://marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-serial-monitor
		'ms-vscode.vscode-embedded-tools',  // https://marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-embedded-tools
		'redhat.vscode-yaml',								// https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml
		'marus25.cortex-debug',							// https://marketplace.visualstudio.com/items?itemName=marus25.cortex-debug
		'trond-snekvik.kconfig-lang',				// https://marketplace.visualstudio.com/items?itemName=trond-snekvik.kconfig-lang
		'trond-snekvik.devicetree',					// https://marketplace.visualstudio.com/items?itemName=trond-snekvik.devicetree
  ];

	zephyrTaskProvider = vscode.tasks.registerTaskProvider(ZephyrTaskProvider.ZephyrType, new ZephyrTaskProvider());

	const workspacePath = (vscode.workspace.workspaceFolders && (vscode.workspace.workspaceFolders.length > 0))
	? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined;

	statusBarBuildItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
	statusBarBuildItem.text = "$(gear) Build";
	statusBarBuildItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  statusBarBuildItem.command = "zephyr-workbench-status-bar.build";
	statusBarDebugItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBarDebugItem.text = "$(debug-alt) Debug";
	statusBarDebugItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  statusBarDebugItem.command = "zephyr-workbench-status-bar.debug";

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

	vscode.commands.registerCommand('zephyr-workbench-status-bar.build', async () => {
		vscode.commands.executeCommand("zephyr-workbench-app-explorer.build-app", getCurrentWorkspaceFolder());
	});

	vscode.commands.registerCommand('zephyr-workbench-status-bar.debug', async () => {
		vscode.commands.executeCommand("zephyr-workbench-app-explorer.debug-app", getCurrentWorkspaceFolder());
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

	vscode.commands.registerCommand('zephyr-workbench-app-explorer.build-app', async (node: ZephyrApplicationTreeItem | vscode.WorkspaceFolder) => {
		let folder: any = node ;
		if(node instanceof ZephyrApplicationTreeItem) {
			if(node.project) {
				folder = node.project.workspaceFolder;
			}
		}

		const westBuildTask = await findTask('West Build', folder);
		if (westBuildTask) {
			try {
				await vscode.tasks.executeTask(westBuildTask);

				// After first build, parse toolchain name from .config
				let gccPath: string | undefined = vscode.workspace.getConfiguration('C_Cpp', folder).get('default.compilerPath');
				if(gccPath && gccPath.includes('undefined')) {
					const project = new ZephyrAppProject(folder, folder.uri.fsPath);
					await updateCompileSetting(project);
				}

			} catch (error) {
				vscode.window.showErrorMessage(`Error executing task: ${error}`);
			}
		} else {
				vscode.window.showErrorMessage('Cannot find Build task.');
		}
	});

	vscode.commands.registerCommand('zephyr-workbench-app-explorer.clean.pristine', async (node: ZephyrApplicationTreeItem) => {
		if(node.project.sourceDir) {
			if(node.project.sourceDir) {
				const westBuildTask = await findTask('Clean Pristine', node.project.workspaceFolder);
				if (westBuildTask) {
					try {
							await vscode.tasks.executeTask(westBuildTask);
					} catch (error) {
							vscode.window.showErrorMessage(`Error executing task: ${error}`);
					}
				} else {
						vscode.window.showErrorMessage('Cannot find Clean task.');
				}
			}
		}
	});

	vscode.commands.registerCommand('zephyr-workbench-app-explorer.clean.delete', async (node: ZephyrApplicationTreeItem) => {
		if(node.project) {
			vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
								title: "Deleting Zephyr Application build directory",
								cancellable: false,
				}, async () => {
					deleteFolder(path.join(node.project.folderPath, 'build'));
				}
			);
		}
	});

	vscode.commands.registerCommand('zephyr-workbench-app-explorer.clean.simple', async (node: ZephyrApplicationTreeItem) => {
		if(node.project.sourceDir) {
			if(node.project.sourceDir) {
				const westBuildTask = await findTask('Clean', node.project.workspaceFolder);
				if (westBuildTask) {
					try {
							await vscode.tasks.executeTask(westBuildTask);
					} catch (error) {
							vscode.window.showErrorMessage(`Error executing task: ${error}`);
					}
				} else {
						vscode.window.showErrorMessage('Cannot find Clean task.');
				}
			}
		}
	});

	vscode.commands.registerCommand('zephyr-workbench-app-explorer.guiconfig-app', async (node: ZephyrApplicationTreeItem) => {
		if(node.project.sourceDir) {
			const guiConfigTask = await findTask('Gui config', node.project.workspaceFolder);
			if (guiConfigTask) {
				try {
						await vscode.tasks.executeTask(guiConfigTask);
				} catch (error) {
						vscode.window.showErrorMessage(`Error executing task: ${error}`);
				}
			} else {
					vscode.window.showErrorMessage('Cannot find Guiconfig task.');
			}
			
		}
	});

	vscode.commands.registerCommand('zephyr-workbench-app-explorer.menuconfig-app', async (node: ZephyrApplicationTreeItem) => {
		if(node.project.sourceDir) {
			const menuconfigTask = await findTask('Menuconfig', node.project.workspaceFolder);
			if (menuconfigTask) {
				try {
						await vscode.tasks.executeTask(menuconfigTask);
				} catch (error) {
						vscode.window.showErrorMessage(`Error executing task: ${error}`);
				}
			} else {
					vscode.window.showErrorMessage('Cannot find Menuconfig task.');
			}
			
		}
	});

	vscode.commands.registerCommand('zephyr-workbench-app-explorer.run-app', async (node: ZephyrApplicationTreeItem) => {
		if(node.project.sourceDir) {
			const westFlashTask = await findTask('West Flash', node.project.workspaceFolder);
			if (westFlashTask) {
				try {
						await vscode.tasks.executeTask(westFlashTask);
				} catch (error) {
						vscode.window.showErrorMessage(`Error executing task: ${error}`);
				}
			} else {
					vscode.window.showErrorMessage('Cannot find flash task.');
			}
		}
	});

	vscode.commands.registerCommand('zephyr-workbench-app-explorer.debug-app', async (node: ZephyrApplicationTreeItem | vscode.WorkspaceFolder) => {
		let workspaceFolder: any = node ;
		if(node instanceof ZephyrApplicationTreeItem) {
			if(node.project) {
				workspaceFolder = node.project.workspaceFolder;
			}
		}
		
		if(workspaceFolder) {
			const launchConfig = vscode.workspace.getConfiguration('launch', workspaceFolder.uri);
			if(launchConfig) {
				const configurations: vscode.DebugConfiguration[] = launchConfig.get('configurations', []);
				if(configurations) {
					if(configurations.some((config: { name: string }) => config.name === ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME)) {
						await vscode.debug.startDebugging(workspaceFolder, ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME);
						return;
					}
				}
			}
			
			const debugManagerItem = 'Open Debug Manager';
			const choice = await vscode.window.showWarningMessage('No debug launch configuration found, please configure the debug session on the Debug Manager', debugManagerItem);
			if(choice === debugManagerItem) {
				vscode.commands.executeCommand('zephyr-workbench.debug-manager');
			}
		}

	});

	vscode.commands.registerCommand('zephyr-workbench-app-explorer.spdx-app', async (node: ZephyrApplicationTreeItem) => {
		if(node.project.sourceDir) {
			const westFlashTask = await findTask('Generate SPDX', node.project.workspaceFolder);
			if (westFlashTask) {
				try {
						await vscode.tasks.executeTask(westFlashTask);
				} catch (error) {
						vscode.window.showErrorMessage(`Error executing task: ${error}`);
				}
			} else {
					vscode.window.showErrorMessage('Cannot find SPDX task.');
			}
		}
	});

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
	});

	vscode.commands.registerCommand("zephyr-workbench-app-explorer.set-venv", async (node: ZephyrApplicationTreeItem) => {
		vscode.commands.executeCommand('workbench.action.openSettings', `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_ACTIVATEPATH_SETTING_KEY}`);
	});

	vscode.commands.registerCommand("zephyr-workbench-app-explorer.create-venv", async (node: ZephyrApplicationTreeItem) => {
		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
				title: "Create new local environment",
				cancellable: false,
			}, async () => {
				let venvPath = await createLocalVenv(context, node.project.workspaceFolder);
				await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, node.project.workspaceFolder).update(ZEPHYR_WORKBENCH_VENV_ACTIVATEPATH_SETTING_KEY, venvPath, vscode.ConfigurationTarget.WorkspaceFolder);
			}
		);
	});

	vscode.commands.registerCommand('zephyr-workbench-app-explorer.reveal-os', async (node: ZephyrApplicationTreeItem) => {
		if(node.project.workspaceFolder) {
			vscode.commands.executeCommand('revealFileInOS', node.project.workspaceFolder.uri);
		}
	});

	vscode.commands.registerCommand('zephyr-workbench-app-explorer.reveal-explorer', async (node: ZephyrApplicationTreeItem) => {
		if(node.project.workspaceFolder) {
			vscode.commands.executeCommand('revealInExplorer', node.project.workspaceFolder.uri);
		}
	});

	vscode.commands.registerCommand('zephyr-workbench-app-explorer.change-board', async (node: ZephyrApplicationBoardTreeItem | ZephyrApplicationTreeItem) => {
		if(node.project) {
			const boardId = await changeBoardQuickStep(context, node.project);
			if(boardId) {
				await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, node.project.workspaceFolder).update(ZEPHYR_PROJECT_BOARD_SETTING_KEY, boardId, vscode.ConfigurationTarget.WorkspaceFolder);
			}
		}
	});

	vscode.commands.registerCommand('zephyr-workbench-app-explorer.change-west-workspace', async (node: ZephyrApplicationWestWorkspaceTreeItem | ZephyrApplicationTreeItem) => {
		if(node.project) {
			const westWorkspacePath = await changeWestWorkspaceQuickStep(context, node.project);
			if(westWorkspacePath) {
				await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, node.project.workspaceFolder).update(ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY, westWorkspacePath, vscode.ConfigurationTarget.WorkspaceFolder);
			}
		}
	});

	vscode.commands.registerCommand("zephyr-workbench-app-explorer.change-pristine", async (node: ZephyrApplicationTreeItem) => {
		if(node.project) {
			let workspaceFolder = node.project.workspaceFolder;
			let pristineValue = await showPristineQuickPick();
			await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).update(ZEPHYR_WORKBENCH_BUILD_PRISTINE_SETTING_KEY, pristineValue, vscode.ConfigurationTarget.WorkspaceFolder);
		}
	});

	vscode.commands.registerCommand('zephyr-workbench-app-explorer.open-terminal', async (node: ZephyrApplicationTreeItem) => {
		if(node.project) {
			let terminal: vscode.Terminal = ZephyrProject.getTerminal(node.project);
			terminal.show();
		}
	});

	vscode.commands.registerCommand('zephyr-workbench-app-explorer.memory-analysis.ram-report', async (node: ZephyrApplicationTreeItem | vscode.WorkspaceFolder) => {
		let folder: any = node ;
		if(node instanceof ZephyrApplicationTreeItem) {
			if(node.project) {
				folder = node.project.workspaceFolder;
			}
		}

		const ramReportTask = await findTask('West RAM Report', folder);
		if (ramReportTask) {
			try {
				await vscode.tasks.executeTask(ramReportTask);
			} catch (error) {
				vscode.window.showErrorMessage(`Error executing task: ${error}`);
			}
		} else {
				vscode.window.showErrorMessage('Cannot find "West RAM Report" task.');
		}
	});

	vscode.commands.registerCommand('zephyr-workbench-app-explorer.memory-analysis.rom-report', async (node: ZephyrApplicationTreeItem | vscode.WorkspaceFolder) => {
		let folder: any = node ;
		if(node instanceof ZephyrApplicationTreeItem) {
			if(node.project) {
				folder = node.project.workspaceFolder;
			}
		}

		const romReportTask = await findTask('West ROM Report', folder);
		if (romReportTask) {
			try {
				await vscode.tasks.executeTask(romReportTask);
			} catch (error) {
				vscode.window.showErrorMessage(`Error executing task: ${error}`);
			}
		} else {
				vscode.window.showErrorMessage('Cannot find "West ROM Report" task.');
		}
	});

	vscode.commands.registerCommand('zephyr-workbench-app-explorer.memory-analysis.puncover', async (node: ZephyrApplicationTreeItem | vscode.WorkspaceFolder) => {
		let folder: any = node ;
		if(node instanceof ZephyrApplicationTreeItem) {
			if(node.project) {
				folder = node.project.workspaceFolder;
			}
		}

		const puncoverTask = await findTask('West Puncover', folder);
		if (puncoverTask) {
			try {
	
				let taskExec = await vscode.tasks.executeTask(puncoverTask);

				const taskStartListener = vscode.tasks.onDidStartTask(async (event) => {
					if (event.execution === taskExec) {
						const stopItem = 'Terminate';
						const choice = await vscode.window.showWarningMessage('Puncover server is running...', stopItem);
						if (choice === stopItem) {
							taskExec.terminate();
							taskStartListener.dispose();
						};
					}
				});


			} catch (error) {
				vscode.window.showErrorMessage(`Error executing task: ${error}`);
			}
		} else {
				vscode.window.showErrorMessage('Cannot find "West Puncover" task.');
		}

		// vscode.window.withProgress({
		// 		location: vscode.ProgressLocation.Notification,
		// 		title: "Running Puncover server",
		// 		cancellable: true,
		// 	}, async (progress, token) => {
		// 		const command = 'west build -t puncover';
		// 		let process = execWestCommandWithEnv(command, folder);

		// 		process.stdout?.on('data', (data) => {
		// 			console.log(`stdout: ${data}`);
		// 		});
				
		// 		process.stderr?.on('data', (data) => {
		// 			console.error(`stderr: ${data}`);
		// 		});
				
		// 		process.on('close', (code) => {
		// 			console.log(`child process exited with code ${code}`);
		// 		});

		// 		token.onCancellationRequested(() => {
		// 			if(process) {
		// 				process.kill();
		// 			}
		// 		});
		// 	}
		// );
	});

	vscode.commands.registerCommand('zephyr-workbench-west-workspace.open-terminal', async (node: WestWorkspaceTreeItem) => {
		if(node.westWorkspace) {
			let terminal: vscode.Terminal = WestWorkspace.getTerminal(node.westWorkspace);
			terminal.show();
		}
	});

	vscode.commands.registerCommand('zephyr-workbench-west-workspace.update', async (node: WestWorkspaceTreeItem) => {
		if(node.westWorkspace) {
			await westUpdateCommand(node.westWorkspace.rootUri.fsPath);
			await westBoardsCommand(node.westWorkspace.rootUri.fsPath);
		}
	});

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
	});


	// const zephyrModuleProvider = new ZephyrModuleDataProvider(workspacePath);
	// vscode.window.registerTreeDataProvider('zephyr-workbench-module-explorer', zephyrModuleProvider);
	// vscode.commands.registerCommand('zephyr-workbench-module-explorer.refresh', () => zephyrModuleProvider.refresh());

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
			vscode.commands.executeCommand('zephyr-workbench.install-host-tools', force, true, "");
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench.reinstall-venv", async (force = false) => {
			vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "Reinstalling Virtual environment",
				cancellable: false,
			}, async (progress, token) => {
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
				}, async (progress, token) => {
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
				}
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench.install-debug-tools", async () => {
			DebugToolsPanel.render(context.extensionUri);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench.debug-manager", async () => {
			DebugManagerPanel.render(context.extensionUri);
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
								cancellable: true,
				}, async (progress, token) => {
					await installHostDebugTools(context, listTools);
					
					for(let tool of listTools) {
						let runner = getRunner(tool);
						if(runner && runner.executable) {
							let runnerPath = path.join(getInternalToolsDirRealPath(), runner.name, runner.binDirPath, runner.executable);
							if(fileExists(runnerPath)) {
								runner.serverPath = runnerPath;
								runner.updateSettings();
							}
						}
						panel.webview.postMessage({ command: 'exec-done', tool: `${tool}` });
					}
				}
			);
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
						projLoc = copyFolder(zephyrSample.rootDir.fsPath, projectPath);
					}
					await addWorkspaceFolder(projLoc);

					let workspaceFolder = getWorkspaceFolder(projLoc);
					if(workspaceFolder) {
						await setDefaultProjectSettings(workspaceFolder, westWorkspace, zephyrBoard, zephyrSDK);
						await createTasksJson(workspaceFolder);
						await createExtensionsJson(workspaceFolder);
						await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).update(ZEPHYR_WORKBENCH_BUILD_PRISTINE_SETTING_KEY, pristineValue, vscode.ConfigurationTarget.WorkspaceFolder);
						CreateZephyrAppPanel.currentPanel?.dispose();
						
						// Note: Force refresh as the first refresh is sometime done before the tasks.json is generated 
						zephyrAppProvider.refresh();
						vscode.window.showInformationMessage(`New Application '${workspaceFolder.name}' created !`);
					}
				}
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.import-app", async (projectLoc, westWorkspace, zephyrBoard, zephyrSDK) => {
			await addWorkspaceFolder(projectLoc);

			let workspaceFolder = getWorkspaceFolder(projectLoc);
			if(workspaceFolder) {
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
					}
				);
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

	context.subscriptions.push(
		vscode.commands.registerCommand("west.flash", async (project) => {
			if(workspacePath) {
				let westWorkspace = getWestWorkspace(project.westWorkspacePath);
				if(westWorkspace !== null) {
					await westFlashCommand(project, westWorkspace);
				} else {
					vscode.window.showErrorMessage('Cannot find west workspace');
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("west.debug", async (project) => {
			if(workspacePath) {
				let westWorkspace = getWestWorkspace(project.westWorkspacePath);
				if(westWorkspace !== null) {
					await westDebugCommand(project, westWorkspace);
				} else {
					vscode.window.showErrorMessage('Cannot find west workspace');
				}
			}
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
			if(event.affectsConfiguration(ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY)) {
				zephyrSdkProvider.refresh();
			}

			if(event.affectsConfiguration(ZEPHYR_WORKBENCH_PATHTOENV_SCRIPT_SETTING_KEY)) {
				zephyrShortcutProvider.refresh();
				zephyrToolsCommandProvider.refresh();
			}

			if(event.affectsConfiguration(`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_BOARD_SETTING_KEY}`) || 
				 event.affectsConfiguration(`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY}`) ||
				 event.affectsConfiguration(`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_SDK_SETTING_KEY}`)) {
				zephyrAppProvider.refresh();
			}
		})
	);

	setDefaultSettings();
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

export async function showConfirmMessage(message: string): Promise<boolean> {
	const yesItem = 'Yes';
	const noItem = 'No';
	const choice = await vscode.window.showWarningMessage(message, yesItem, noItem);
	return (choice === yesItem) ? true : false;
}

// This method is called when your extension is deactivated
export function deactivate() {}

async function updateCompileSetting(project: ZephyrAppProject) {
	const zephyrSDK = getZephyrSDK(project.sdkPath);
	const westWorkspace = getWestWorkspace(project.westWorkspacePath);
	const board = await getBoardFromId(project.boardId, westWorkspace);
	
	let dotConfig = path.join(project.buildDir, 'zephyr', '.config');
	let socToolchainName = getConfigValue(dotConfig, 'SOC_TOOLCHAIN_NAME');
	if(socToolchainName) {
		await vscode.workspace.getConfiguration('C_Cpp', project.workspaceFolder).update('default.compilerPath', zephyrSDK.getCompilerPath(board.arch, socToolchainName), vscode.ConfigurationTarget.WorkspaceFolder);
	}
}

