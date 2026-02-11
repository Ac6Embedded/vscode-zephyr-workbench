// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { westBoardsCommand, westInitCommand, westUpdateCommand, westPackagesInstallCommand, westBuildCommand, execWestCommandWithEnvAsync, westConfigCommand } from './commands/WestCommands';
import { execShellCommandWithEnv, getOutputChannel } from './utils/execUtils';
import { WestWorkspace } from './models/WestWorkspace';
import { ZephyrAppProject } from './models/ZephyrAppProject';
import { ZephyrDebugConfigurationProvider } from './providers/ZephyrDebugConfigurationProvider';
import { ZephyrProject } from './models/ZephyrProject';
import { ZephyrProjectBuildConfiguration } from './models/ZephyrProjectBuildConfiguration';
import { ZephyrSDK, IARToolchain } from './models/ZephyrSDK';
import { checkAndCreateTasksJson, createExtensionsJson, createTasksJson, setDefaultProjectSettings, updateTasks, ZephyrTaskProvider } from './providers/ZephyrTaskProvider';
import { changeBoardQuickStep } from './quicksteps/changeBoardQuickStep';
import { changeEnvVarQuickStep, toggleSysbuild } from './quicksteps/changeEnvVarQuickStep';
import { changeWestWorkspaceQuickStep } from './quicksteps/changeWestWorkspaceQuickStep';
import { ZEPHYR_BUILD_CONFIG_DEFAULT_RUNNER_SETTING_KEY, ZEPHYR_BUILD_CONFIG_SYSBUILD_SETTING_KEY, ZEPHYR_BUILD_CONFIG_WEST_ARGS_SETTING_KEY, ZEPHYR_PROJECT_BOARD_SETTING_KEY, ZEPHYR_PROJECT_SDK_SETTING_KEY, ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY, ZEPHYR_WORKBENCH_BUILD_PRISTINE_SETTING_KEY, ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY, ZEPHYR_PROJECT_IAR_SETTING_KEY, ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY, ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_VENV_ACTIVATE_PATH_SETTING_KEY, ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY } from './constants';
import { getRunner, getRunRunners, getFlashRunners, getStaticFlashRunnerNames, ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME } from './utils/debugUtils';
import { execShellTaskWithEnvAndWait, executeTask, getTerminalDefaultProfile, normalizeSlashesIfPath } from './utils/execUtils';
import { importProjectQuickStep } from './quicksteps/importProjectQuickStep';
import { checkEnvFile, checkHomebrew, checkHostTools, cleanupDownloadDir, createLocalVenv, createLocalVenvSPDX, download, forceInstallHostTools, installHostDebugTools, installVenv, runInstallHostTools, setDefaultSettings, verifyHostTools, installOpenOcdRunnerSilently } from './utils/installUtils';
import { generateWestManifest } from './utils/manifestUtils';
import { CreateWestWorkspacePanel } from './panels/CreateWestWorkspacePanel';
import { CreateZephyrAppPanel } from './panels/CreateZephyrAppPanel';
import { DebugManagerPanel } from './panels/DebugManagerPanel';
import { DebugToolsPanel } from './panels/DebugToolsPanel';
import { HostToolsPanel } from './panels/HostToolsPanel';
import { ImportZephyrSDKPanel } from './panels/ImportZephyrSDKPanel';
import { EclairManagerPanel } from './panels/EclairManagerPanel';
import { changeToolchainQuickStep } from "./quicksteps/changeToolchainQuickStep";
import { pickApplicationQuickStep } from './quicksteps/pickApplicationQuickStep';
import { pickBuildConfigQuickStep } from './quicksteps/pickBuildConfigQuickStep';
import { WestWorkspaceDataProvider, WestWorkspaceEnvTreeItem, WestWorkspaceEnvValueTreeItem, WestWorkspaceTreeItem } from './providers/WestWorkspaceDataProvider';
import { ZephyrApplicationDataProvider, ZephyrApplicationEnvTreeItem, ZephyrApplicationEnvValueTreeItem, ZephyrApplicationTreeItem, ZephyrApplicationWestWorkspaceTreeItem, ZephyrConfigBoardTreeItem, ZephyrConfigDefaultRunnerTreeItem, ZephyrConfigEnvTreeItem, ZephyrConfigEnvValueTreeItem, ZephyrConfigTreeItem } from './providers/ZephyrApplicationProvider';
import { ZephyrHostToolsCommandProvider } from './providers/ZephyrHostToolsCommandProvider';
import { ZephyrOtherResourcesCommandProvider } from './providers/ZephyrOtherResourcesCommandProvider';
import { ZephyrSdkDataProvider, ZephyrSdkTreeItem } from "./providers/ZephyrSdkDataProvider";
import { ZephyrShortcutCommandProvider } from './providers/ZephyrShortcutCommandProvider';
import { extractSDK, generateSdkUrls, registerZephyrSDK, unregisterZephyrSDK, registerIARToolchain, unregisterIARToolchain } from './utils/sdkUtils';
import { setConfigQuickStep } from './quicksteps/setConfigQuickStep';
import { showPristineQuickPick } from './quicksteps/setupBuildPristineQuickStep';
import { addWorkspaceFolder, copySampleSync, deleteFolder, fileExists, findConfigTask, getBoardFromIdentifier, getInternalToolsDirRealPath, getListZephyrSDKs, getWestWorkspace, getWestWorkspaces, getWorkspaceFolder, getZephyrProject, getZephyrSDK, isWorkspaceFolder, msleep, normalizePath, removeWorkspaceFolder, checkZinstallerVersion } from './utils/utils';
import { addConfig, addEnvValue, deleteConfig, removeEnvValue, replaceEnvValue, saveConfigEnv, saveConfigSetting, saveEnv } from './utils/zephyrEnvUtils';
import { getZephyrEnvironment, getZephyrTerminal, runCommandTerminal } from './utils/zephyrTerminalUtils';
import { execCveBinToolCommand, execNtiaCheckerCommand, execSBom2DocCommand } from './commands/SPDXCommands';
import { exec } from 'child_process';
import { syncAutoDetectEnv } from './utils/autoDetectSyncUtils';
import { initDtsIntegration } from './utils/dtsIntegration';

let statusBarBuildItem: vscode.StatusBarItem;
let statusBarDebugItem: vscode.StatusBarItem;
let zephyrTaskProvider: vscode.Disposable | undefined;
let zephyrDebugConfigurationProvide: vscode.Disposable | undefined;

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

	context.subscriptions.push(statusBarBuildItem);
	context.subscriptions.push(statusBarDebugItem);

	// Setup Tree view providers
	const zephyrShortcutProvider = new ZephyrShortcutCommandProvider();
	vscode.window.registerTreeDataProvider('zephyr-workbench-shortcuts', zephyrShortcutProvider);

	const zephyrSdkProvider = new ZephyrSdkDataProvider();
	vscode.window.registerTreeDataProvider('zephyr-workbench-sdk-explorer', zephyrSdkProvider);

	const westWorkspaceProvider = new WestWorkspaceDataProvider();
	vscode.window.registerTreeDataProvider('zephyr-workbench-west-workspace', westWorkspaceProvider);

	const zephyrAppProvider = new ZephyrApplicationDataProvider();
	vscode.window.registerTreeDataProvider('zephyr-workbench-app-explorer', zephyrAppProvider);

	const zephyrToolsCommandProvider = new ZephyrHostToolsCommandProvider();
	vscode.window.registerTreeDataProvider('zephyr-workbench-tools-explorer', zephyrToolsCommandProvider);

	const zephyrResourcesCommandProvider = new ZephyrOtherResourcesCommandProvider();
	vscode.window.registerTreeDataProvider('zephyr-workbench-other-resources', zephyrResourcesCommandProvider);

	// Initialize DTS-LSP integration: creates contexts on .overlay/.dts opens
	initDtsIntegration(context);

	// Register commands
	// TODO: Could be refactored / Optimized
	vscode.commands.registerCommand('zephyr-workbench-sdk-explorer.refresh', () => zephyrSdkProvider.refresh());
	vscode.commands.registerCommand('zephyr-workbench-west-workspace.refresh', () => westWorkspaceProvider.refresh());
	vscode.commands.registerCommand('zephyr-workbench-app-explorer.refresh', () => zephyrAppProvider.refresh());

	vscode.commands.registerCommand('zephyr-workbench.build-app', async () => {
		let currentProject = getCurrentWorkspaceFolder();
		if (currentProject === undefined) {
			currentProject = await pickApplicationQuickStep(context);
		}

		if (currentProject) {
			vscode.commands.executeCommand("zephyr-workbench-app-explorer.build-app", currentProject);
		}
	});

	vscode.commands.registerCommand('zephyr-workbench.rebuild-app', async () => {
		let currentProject = getCurrentWorkspaceFolder();
		if (currentProject === undefined) {
			currentProject = await pickApplicationQuickStep(context);
		}

		if (currentProject) {
			vscode.commands.executeCommand("zephyr-workbench-app-explorer.clean.pristine", currentProject);
		}
	});

	vscode.commands.registerCommand('zephyr-workbench.debug-app', async () => {
		let currentProjectFolder = getCurrentWorkspaceFolder();
		if (currentProjectFolder === undefined) {
			currentProjectFolder = await pickApplicationQuickStep(context);
		}

		if (currentProjectFolder) {
			vscode.commands.executeCommand("zephyr-workbench-app-explorer.debug-app", currentProjectFolder);
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
		vscode.commands.registerCommand('zephyr-workbench.eclair-manager.open', async (node?: any) => {
			const { workspaceFolder, settingsRoot } = resolveWorkspaceFolderForEclair(node);
			EclairManagerPanel.render(context.extensionUri, workspaceFolder, settingsRoot);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.spdx.analyze.dt-doctor', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {
			if (!node?.project) return;
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
				if (ZephyrProject.isZephyrProjectPath(projectPath)) {
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
				} else {
					vscode.window.showErrorMessage("The folder is not a Zephyr project");
				}
			} else {
				vscode.window.showErrorMessage("The selected location folder is invalid");
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.build-app', async (node: ZephyrConfigTreeItem | vscode.WorkspaceFolder | vscode.Uri, configName: string) => {
			const profile = getTerminalDefaultProfile();

			if (!profile) {
				await executeConfigTask('West Build', node, configName);
			}

			if (node instanceof ZephyrApplicationTreeItem && profile) {
				const westWorkspace = getWestWorkspace(node.project.westWorkspacePath);
				westBuildCommand(node.project, westWorkspace);
			}

			// After first build, parse toolchain name from .config
			let folder: vscode.WorkspaceFolder | undefined = undefined;
			let boardIdentifier: string = '';
			if (node instanceof ZephyrConfigTreeItem) {
				if (profile) {
					const westWorkspace = getWestWorkspace(node.project.westWorkspacePath);
					westBuildCommand(node.project, westWorkspace);
				}
				if (node.project) {
					folder = node.project.workspaceFolder;
					boardIdentifier = node.buildConfig.boardIdentifier;
				}
			} else if ((node as vscode.WorkspaceFolder).uri) {
				// It's a WorkspaceFolder
				if (profile) {
					const project = await getZephyrProject((node as vscode.WorkspaceFolder).uri.fsPath);
					westBuildCommand(project, getWestWorkspace(project.westWorkspacePath));
				}
				folder = node as vscode.WorkspaceFolder;
			} else if ((node as vscode.Uri).fsPath) {
				// It's a Uri from right-click in Explorer
				if (profile) {
					const project = await getZephyrProject((node as vscode.Uri).fsPath);
					const westWorkspace = getWestWorkspace(project.westWorkspacePath);
					westBuildCommand(project, westWorkspace);
				}
				folder = vscode.workspace.getWorkspaceFolder(node as vscode.Uri) || undefined;
			}

			if (folder) {
				let gccPath: string | undefined = vscode.workspace.getConfiguration('C_Cpp', folder).get('default.compilerPath');
				if (gccPath && gccPath.includes('undefined')) {
					const project = new ZephyrAppProject(folder, folder.uri.fsPath);

					// Use-case if build out of APPLICATIONS view, means from WorkspaceFolder 
					// Cannot know board identifier beforehand so detect if after parsing settings.json
					// On non-legacy project, assume first config can be the "master"
					if (boardIdentifier.length === 0) {
						boardIdentifier = project.configs[0].boardIdentifier;
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
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.clean.pristine', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem | vscode.WorkspaceFolder | vscode.Uri, configName?: string) => {
			const profile = getTerminalDefaultProfile();

			if (profile) {
				if (node instanceof ZephyrApplicationTreeItem) {
					westBuildCommand(node.project, getWestWorkspace(node.project.westWorkspacePath));
				}
				else if ((node as vscode.WorkspaceFolder).uri) {
					const project = await getZephyrProject((node as vscode.WorkspaceFolder).uri.fsPath);
					const westWorkspace = getWestWorkspace(project.westWorkspacePath);
					westBuildCommand(project, westWorkspace);
				}
				else if ((node as vscode.Uri).fsPath) {
					const project = await getZephyrProject((node as vscode.Uri).fsPath);
					const westWorkspace = getWestWorkspace(project.westWorkspacePath);
					westBuildCommand(project, westWorkspace);
				}
			}
			else {
				await executeConfigTask('West Rebuild', node, configName);
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
					deleteFolder(path.join(node.project.folderPath, buildDir));
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
				const westWorkspace = getWestWorkspace(node.project.westWorkspacePath);
				westConfigCommand(node.project, westWorkspace, "guiconfig");
			}
			else if (node instanceof ZephyrApplicationTreeItem && profile) {
				const westWorkspace = getWestWorkspace(node.project.westWorkspacePath);
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
				const westWorkspace = getWestWorkspace(node.project.westWorkspacePath);
				westConfigCommand(node.project, westWorkspace, "menuconfig");
			}
			else if (node instanceof ZephyrApplicationTreeItem && profile) {
				const westWorkspace = getWestWorkspace(node.project.westWorkspacePath);
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
				const westWorkspace = getWestWorkspace(node.project.westWorkspacePath);
				westConfigCommand(node.project, westWorkspace, "hardenconfig");
			}
			else if (node instanceof ZephyrApplicationTreeItem && profile) {
				const westWorkspace = getWestWorkspace(node.project.westWorkspacePath);
				westConfigCommand(node.project, westWorkspace, "hardenconfig");
			}
		})
	);
	context.subscriptions.push(
    vscode.commands.registerCommand('zephyr-workbench-app-explorer.set-default-runner', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem | ZephyrConfigDefaultRunnerTreeItem) => {
			let project: ZephyrProject | undefined;
			let targetConfig: ZephyrProjectBuildConfiguration | undefined;

			if (node instanceof ZephyrApplicationTreeItem) {
				project = node.project;
				// For single-config apps, use that config; for multi, ask which active? else pick
				if (project.configs.length === 1) {
					targetConfig = project.configs[0];
				} else if (project.configs.length > 1) {
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

    // Compute pick list from west flash -H, marking those available in runners.yaml as compatible
    // Only use the label (white text). Avoid detail/description to prevent a second grey line.
    let items: vscode.QuickPickItem[] = [];
    try {
      // Show busy progress while west builds and fetches flash runners
      const info = await vscode.window.withProgress<{ all: string[]; available: string[]; def?: string; output: string }>(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Collecting flash runners (this may take a while)…',
          cancellable: false,
        },
        async () => {
          return await getFlashRunners(project as ZephyrAppProject, targetConfig);
        }
      );
      const all: string[] = info.all;
      const compatible: string[] = info.available;
      const defRunner: string | undefined = info.def; // default runner from runners.yaml
      // Sort compatible first, then alphabetical
      const sorted = all.slice().sort((a: string, b: string) => {
        const ac = compatible.includes(a) ? 0 : 1;
        const bc = compatible.includes(b) ? 0 : 1;
        return ac - bc || a.localeCompare(b);
      });
      // If west reports a default runner, put it first
      const ordered = defRunner && sorted.includes(defRunner)
        ? [defRunner, ...sorted.filter(n => n !== defRunner)]
        : sorted;
      items = ordered.map((name: string) => ({
        label: name + (compatible.includes(name) ? ' (compatible)' : ''),
        picked: name === targetConfig?.defaultRunner,
      }));
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : 'Unknown error while collecting flash runners.';
      vscode.window.showWarningMessage(`Zephyr Workbench: Using fallback flash runner list. ${msg}`);
      const names = getStaticFlashRunnerNames();
      items = names.map((name: string) => ({
        label: name,
        picked: name === targetConfig?.defaultRunner,
      }));
    }
			const selection = await vscode.window.showQuickPick(items, { placeHolder: 'Select default runner' });
			if (!selection) { return; }
			const chosenRunner = (selection.label || '').replace(' (compatible)', '');

			await saveConfigSetting(project.workspaceFolder, targetConfig.name, ZEPHYR_BUILD_CONFIG_DEFAULT_RUNNER_SETTING_KEY, chosenRunner);
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
      let project: ZephyrProject | undefined;
      let targetConfig: ZephyrProjectBuildConfiguration | undefined;

      if (node instanceof ZephyrApplicationTreeItem) {
        project = node.project;
        if (project.configs.length === 1) {
          targetConfig = project.configs[0];
        } else if (project.configs.length > 1) {
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

      await saveConfigSetting(project.workspaceFolder, targetConfig.name, ZEPHYR_BUILD_CONFIG_DEFAULT_RUNNER_SETTING_KEY, "");
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
			node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem | vscode.WorkspaceFolder | vscode.Uri
		) => {
			let workspaceFolder: vscode.WorkspaceFolder | undefined;
			let project: ZephyrProject | undefined;
			let buildConfigName: string | undefined;

			if (node instanceof ZephyrApplicationTreeItem) {
				if (node.project) {
					project = node.project;
					workspaceFolder = node.project.workspaceFolder;

					if (project.configs.length === 1) {
						buildConfigName = project.configs[0].name;
					}
				}
			} else if (node instanceof ZephyrConfigTreeItem) {
				if (node.project && node.buildConfig) {
					project = node.project;
					workspaceFolder = node.project.workspaceFolder;
					buildConfigName = node.buildConfig.name;
				}
			} else if ((node as vscode.WorkspaceFolder).uri) {
				workspaceFolder = node as vscode.WorkspaceFolder;
				project = await getZephyrProject(workspaceFolder.uri.fsPath);
			} else if ((node as vscode.Uri).fsPath) {
				workspaceFolder = vscode.workspace.getWorkspaceFolder(node as vscode.Uri) || undefined;
				if (workspaceFolder) {
					project = await getZephyrProject(workspaceFolder.uri.fsPath);
				}
			}

			if (!project || !workspaceFolder) {
				vscode.window.showErrorMessage("Could not determine the Zephyr project or workspace folder.");
				return;
			}

			if (!buildConfigName) {
				if (project.configs.length > 1) {
					const activeConfig = project.configs.find(config => config.active);
					if (activeConfig) {
						buildConfigName = activeConfig.name;
					} else {
						vscode.window.showInformationMessage("No active configuration found, please set one as active first.");
						buildConfigName = await pickBuildConfigQuickStep(project);
					}
				} else if (project.configs.length === 1) {
					buildConfigName = project.configs[0].name;
				}
			}

			if (workspaceFolder) {
				const launchConfig = vscode.workspace.getConfiguration('launch', workspaceFolder.uri);
				const configurations: vscode.DebugConfiguration[] = launchConfig.get('configurations', []);

				let configName = ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME;
				if (buildConfigName) {
					configName = `${ZEPHYR_WORKBENCH_DEBUG_CONFIG_NAME} [${buildConfigName}]`;
				}

				const found = configurations?.some((config: { name: string }) => config && config.name === configName);

				if (found) {
					await vscode.debug.startDebugging(workspaceFolder, configName);
				} else {
					// Fallback: open Debug Manager if config is not found
					vscode.commands.executeCommand('zephyr-workbench.debug-manager', node);
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
				title: "Create new local environment for SDPX",
				cancellable: false,
			}, async () => {
				await createLocalVenvSPDX(context, node.project.workspaceFolder);
			}
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.spdx.analyze.ntia-checker', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {
			if (node.project) {
				let parentUri;
				if (node instanceof ZephyrApplicationTreeItem) {
					if (node.project) {
						const buildUri = vscode.Uri.file(node.project.configs[0].getBuildDir(node.project));
						parentUri = vscode.Uri.joinPath(buildUri, 'spdx');
					}
				} else if (node instanceof ZephyrConfigTreeItem) {
					if (node.project) {
						const buildUri = vscode.Uri.file(node.buildConfig.getBuildDir(node.project));
						parentUri = vscode.Uri.joinPath(buildUri, 'spdx');
					}
				}
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
				let parentUri;
				if (node instanceof ZephyrApplicationTreeItem) {
					if (node.project) {
						const buildUri = vscode.Uri.file(node.project.configs[0].getBuildDir(node.project));
						parentUri = vscode.Uri.joinPath(buildUri, 'spdx');

					}
				} else if (node instanceof ZephyrConfigTreeItem) {
					if (node.project) {
						const buildUri = vscode.Uri.file(node.buildConfig.getBuildDir(node.project));
						parentUri = vscode.Uri.joinPath(buildUri, 'spdx');
					}
				}
				if (parentUri) {
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
				let parentUri;
				if (node instanceof ZephyrApplicationTreeItem) {
					if (node.project) {
						const buildUri = vscode.Uri.file(node.project.configs[0].getBuildDir(node.project));
						parentUri = vscode.Uri.joinPath(buildUri, 'spdx');

					}
				} else if (node instanceof ZephyrConfigTreeItem) {
					if (node.project) {
						const buildUri = vscode.Uri.file(node.buildConfig.getBuildDir(node.project));
						parentUri = vscode.Uri.joinPath(buildUri, 'spdx');
					}
				}
				if (parentUri) {
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
			let buildDir: string;
			let source: any;
			let workspaceFolder: vscode.WorkspaceFolder = node.project.workspaceFolder;
			const profile = getTerminalDefaultProfile();
			if (node instanceof ZephyrApplicationTreeItem) {
				if (node.project) {
					buildDir = 'build';
					source = node.project.configs[0];
				}
			} else if (node instanceof ZephyrConfigTreeItem) {
				if (node.project) {
					buildDir = node.buildConfig.relativeBuildDir;
					source = node.buildConfig;
				}
			}

			// Delete build directory before SPDX init
			if (node.project) {
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
				if (source && !profile) {
					await executeConfigTask('Init SPDX', node);
					await saveConfigSetting(workspaceFolder, source.name, ZEPHYR_BUILD_CONFIG_WEST_ARGS_SETTING_KEY, appendBuildOutputMeta(source.westArgs));
					msleep(200);
					await executeConfigTask('West Build', node);
					await saveConfigSetting(workspaceFolder, source.name, ZEPHYR_BUILD_CONFIG_WEST_ARGS_SETTING_KEY, source.westArgs);
					msleep(200);
					await executeConfigTask('Generate SPDX', node);
				}
				else if (source && profile) {
					const westWorkspace = getWestWorkspace(node.project.westWorkspacePath);
					const buildDir = vscode.Uri.file(node.project.configs[0].getBuildDir(node.project)).fsPath;
					await execShellTaskWithEnvAndWait('SPDX init',`west spdx --init --build-dir "${buildDir}"`, { cwd: westWorkspace.rootUri.fsPath });
					await saveConfigSetting(workspaceFolder, source.name, ZEPHYR_BUILD_CONFIG_WEST_ARGS_SETTING_KEY, appendBuildOutputMeta(source.westArgs));
					const extraArgs = appendBuildOutputMeta(source.westArgs);
					await westBuildCommand(node.project, westWorkspace, extraArgs);
					await saveConfigSetting(workspaceFolder, source.name, ZEPHYR_BUILD_CONFIG_WEST_ARGS_SETTING_KEY, source.westArgs);
					await execShellTaskWithEnvAndWait('SPDX generate',`west spdx --build-dir "${buildDir}"`,{ cwd: westWorkspace.rootUri.fsPath });
				} 
			} catch (error) {
				vscode.window.showErrorMessage(`Error executing tasks: ${error}`);
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
				removeWorkspaceFolder(node.project.workspaceFolder);
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.delete", async (node: ZephyrApplicationTreeItem) => {
			if (node.project) {
				if (await showConfirmMessage(`Delete ${node.project.folderName} permanently ?`)) {
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
			vscode.commands.executeCommand('workbench.action.openSettings', `${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY}`);
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
				await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, node.project.workspaceFolder).update(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY, venvPath, vscode.ConfigurationTarget.WorkspaceFolder);
			}
			);
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.reveal-os', async (node: ZephyrApplicationTreeItem) => {
			if (node.project.workspaceFolder) {
				vscode.commands.executeCommand('revealFileInOS', node.project.workspaceFolder.uri);
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.reveal-explorer', async (node: ZephyrApplicationTreeItem) => {
			if (node.project.workspaceFolder) {
				vscode.commands.executeCommand('revealInExplorer', node.project.workspaceFolder.uri);
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
						await saveConfigSetting(node.project.workspaceFolder, node.buildConfig.name, ZEPHYR_PROJECT_BOARD_SETTING_KEY, boardId);
					} else if (node instanceof ZephyrConfigBoardTreeItem) {
						await saveConfigSetting(node.project.workspaceFolder, node.config.name, ZEPHYR_PROJECT_BOARD_SETTING_KEY, boardId);
					} else if (node instanceof ZephyrApplicationTreeItem) {
						if (node.project.configs && node.project.configs.length === 1) {
							await saveConfigSetting(node.project.workspaceFolder, node.project.configs[0].name, ZEPHYR_PROJECT_BOARD_SETTING_KEY, boardId);
						}
					}
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.change-west-workspace', async (node: ZephyrApplicationWestWorkspaceTreeItem | ZephyrApplicationTreeItem) => {
			if (node.project) {
				const westWorkspacePath = await changeWestWorkspaceQuickStep(context, node.project);
				if (westWorkspacePath) {
					await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, node.project.workspaceFolder).update(ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY, westWorkspacePath, vscode.ConfigurationTarget.WorkspaceFolder);
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

				const cfg = vscode.workspace.getConfiguration(
					ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
					node.project.workspaceFolder
				);

				if (pick.tcKind === "zephyr_sdk") {
					await cfg.update(ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY, "zephyr_sdk", vscode.ConfigurationTarget.WorkspaceFolder);
					await cfg.update(ZEPHYR_PROJECT_SDK_SETTING_KEY, pick.sdkPath, vscode.ConfigurationTarget.WorkspaceFolder);
					await cfg.update(ZEPHYR_PROJECT_IAR_SETTING_KEY, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
				} else {
					await cfg.update(ZEPHYR_PROJECT_TOOLCHAIN_SETTING_KEY, "iar", vscode.ConfigurationTarget.WorkspaceFolder);
					await cfg.update(ZEPHYR_PROJECT_IAR_SETTING_KEY, pick.iarPath, vscode.ConfigurationTarget.WorkspaceFolder);
				}
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.change-pristine", async (node: ZephyrApplicationTreeItem) => {
			if (node.project) {
				let workspaceFolder = node.project.workspaceFolder;
				let pristineValue = await showPristineQuickPick();
				await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).update(ZEPHYR_WORKBENCH_BUILD_PRISTINE_SETTING_KEY, pristineValue, vscode.ConfigurationTarget.WorkspaceFolder);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.sysbuild.enable', async (node: any) => {
			if (node instanceof ZephyrConfigTreeItem) {
				await toggleSysbuild(node.project.workspaceFolder, ZEPHYR_BUILD_CONFIG_SYSBUILD_SETTING_KEY, true, node.project, node.buildConfig.name);
			}
			if (node.project) {
				await toggleSysbuild(node.project.workspaceFolder, ZEPHYR_BUILD_CONFIG_SYSBUILD_SETTING_KEY, true, node.project);
			}
			vscode.window.showInformationMessage("Sysbuild enabled.");
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.sysbuild.disable', async (node: any) => {
			if (node instanceof ZephyrConfigTreeItem) {
				await toggleSysbuild(node.project.workspaceFolder, ZEPHYR_BUILD_CONFIG_SYSBUILD_SETTING_KEY, false, node.project, node.buildConfig.name);
			}
			if (node.project) {
				await toggleSysbuild(node.project.workspaceFolder, ZEPHYR_BUILD_CONFIG_SYSBUILD_SETTING_KEY, false, node.project);
			}
			vscode.window.showInformationMessage("Sysbuild disabled.");
		})
	);


	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.open-terminal', async (node: ZephyrApplicationTreeItem | ZephyrConfigTreeItem) => {
			let workspaceFolder: vscode.WorkspaceFolder | undefined;
			let project: ZephyrProject | undefined;
			if (node instanceof ZephyrApplicationTreeItem) {
				if (node.project) {
					if (node.project.configs && node.project.configs.length === 1) {
						let terminal: vscode.Terminal = ZephyrProjectBuildConfiguration.getTerminal(node.project, node.project.configs[0]);
						terminal.show();
					} else {
						let terminal: vscode.Terminal = ZephyrProject.getTerminal(node.project);
						terminal.show();
					}
				}
			} else if (node instanceof ZephyrConfigTreeItem) {
				if (node.buildConfig) {
					let terminal: vscode.Terminal = ZephyrProjectBuildConfiguration.getTerminal(node.project, node.buildConfig);
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
					const westWorkspace = getWestWorkspace(workspaceFolder.uri.fsPath);
					let terminal: vscode.Terminal = WestWorkspace.getTerminal(westWorkspace);
					terminal.show();
				}
				if (workspaceFolder && !isWestWorkspace) {
					project = await getZephyrProject(workspaceFolder.uri.fsPath);
					if (project.configs && project.configs.length === 1) {
						let terminal: vscode.Terminal = ZephyrProjectBuildConfiguration.getTerminal(project, project.configs[0]);
						terminal.show();
					}
					else {
						let terminal: vscode.Terminal = ZephyrProject.getTerminal(project);
						terminal.show();
					}
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
			let folder: any = node;
			if (node instanceof ZephyrApplicationTreeItem) {
				if (node.project) {
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
			if (node.project) {
				let newConfig = new ZephyrProjectBuildConfiguration();
				let configName = await setConfigQuickStep(newConfig, node.project);
				if (configName) {
					newConfig.active = false;
					newConfig.name = configName;
					let boardId = await changeBoardQuickStep(context, node.project);
					if (boardId) {
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
			if (node.project.configs.length <= 1) {
				vscode.window.showErrorMessage("One build configuration is required, firstly create a new one before deleting.");
			} else {
				if (node.buildConfig) {
					let confirm = await showConfirmMessage("Are you sure you want to delete this configuration ?");
					if (confirm) {
						await deleteConfig(node.project.workspaceFolder, node.buildConfig);
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
					await saveConfigSetting(node.project.workspaceFolder, oldConfigName, 'name', newConfigName);
				}
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.activate-config', async (node: ZephyrConfigTreeItem) => {
			if (node.buildConfig) {
				node.buildConfig.active = true;

				let activeIndex = 0;
				for (let configIndex = 0; configIndex < node.project.configs.length; configIndex++) {
					if (node.project.configs[configIndex].name !== node.buildConfig.name) {
						await saveConfigSetting(node.project.workspaceFolder, node.project.configs[configIndex].name, 'active', '');
					} else {
						let buildDir = path.join('${workspaceFolder}', 'build', node.buildConfig.name);
						await saveConfigSetting(node.project.workspaceFolder, node.buildConfig.name, 'active', 'true');
						await vscode.workspace.getConfiguration('C_Cpp', node.project.workspaceFolder).update('default.compileCommands', normalizePath(path.join(buildDir, 'compile_commands.json')), vscode.ConfigurationTarget.WorkspaceFolder);
						activeIndex = configIndex;
					}
				}
				updateTasks(node.project.workspaceFolder, node.buildConfig.name, activeIndex);
			}
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('zephyr-workbench-app-explorer.deactivate-config', async (node: ZephyrConfigTreeItem) => {
			if (node.buildConfig) {
				node.buildConfig.active = true;
				await saveConfigSetting(node.project.workspaceFolder, node.buildConfig.name, 'active', "");
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
				await westUpdateCommand(node.westWorkspace.rootUri.fsPath);
				await westBoardsCommand(node.westWorkspace.rootUri.fsPath);
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
						let workspaceFolder = getWorkspaceFolder(project.folderPath);
						if (workspaceFolder) {
							await saveEnv(workspaceFolder, node.envKey, project.envVars[node.envKey]);
						}
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
						let workspaceFolder = getWorkspaceFolder(project.folderPath);
						if (workspaceFolder) {
							await saveConfigEnv(workspaceFolder, config.name, node.envKey, config.envVars[node.envKey]);
						}
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
						let workspaceFolder = getWorkspaceFolder(project.folderPath);
						if (workspaceFolder) {
							await saveEnv(workspaceFolder, node.envKey, project.envVars[node.envKey]);
						}
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
						let workspaceFolder = getWorkspaceFolder(project.folderPath);
						if (workspaceFolder) {
							await saveConfigEnv(workspaceFolder, config.name, node.envKey, config.envVars[node.envKey]);
						}
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
					let workspaceFolder = getWorkspaceFolder(project.folderPath);
					if (workspaceFolder) {
						await saveEnv(workspaceFolder, node.envKey, project.envVars[node.envKey]);
					}
					zephyrAppProvider.refresh();
				}
			} else if (node instanceof ZephyrConfigEnvValueTreeItem) {
				if (node.config) {
					const project = node.project;
					const config = node.config;
					removeEnvValue(config.envVars, node.envKey, node.envValue);
					let workspaceFolder = getWorkspaceFolder(project.folderPath);
					if (workspaceFolder) {
						await saveConfigEnv(workspaceFolder, config.name, node.envKey, config.envVars[node.envKey]);
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
					let workspaceFolder = getWorkspaceFolder(project.folderPath);
					if (workspaceFolder) {
						if (node.argSetting) {
							await saveConfigSetting(workspaceFolder, context.name, node.argSetting, node.argValue);
						} else {
							await saveConfigEnv(workspaceFolder, context.name, node.argName, node.argValue);
						}
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

                        zephyrSdkProvider.refresh();
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
		vscode.commands.registerCommand("zephyr-workbench-sdk-explorer.import-official-sdk", async (sdkType, sdkVersion, listToolchains, parentPath) => {
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
					let urls = generateSdkUrls(sdkType, sdkVersion, toolchains);

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
								for (let i = 1; i < urls.length; i++) {
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
					zephyrSdkProvider.refresh();
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
					zephyrSdkProvider.refresh();
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
				if (ZephyrSDK.isSDKPath(sdkPath)) {
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

				if (!IARToolchain.isIarPath(iarPath)) {
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

				zephyrSdkProvider.refresh();
				vscode.window.showInformationMessage("IAR toolchain imported.");
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-sdk-explorer.remove-sdk", async (node: ZephyrSdkTreeItem) => {
			if (node.sdk) {
				if (await showConfirmMessage(`Remove ${node.sdk.name} from workspace?`)) {
					if (node.sdk instanceof ZephyrSDK) {
						await unregisterZephyrSDK(node.sdk.rootUri.fsPath);
						zephyrSdkProvider.refresh();
					} else {
						vscode.window.showWarningMessage("Cannot remove IAR Toolchain using this command.");
					}
				}
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-sdk-explorer.delete", async (node: ZephyrSdkTreeItem) => {
			if (!node.sdk) {return;}

			if (await showConfirmMessage(`Delete ${node.sdk.name} permanently?`)) {
				if (node.sdk instanceof ZephyrSDK) {
					const sdkPath = node.sdk.rootUri.fsPath;

					vscode.window.withProgress(
						{
							location: vscode.ProgressLocation.Notification,
							title: "Deleting Zephyr SDK",
							cancellable: false,
						},
						async () => {
							await unregisterZephyrSDK(sdkPath);
							deleteFolder(sdkPath);
							zephyrSdkProvider.refresh();
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
			async (node: ZephyrSdkTreeItem) => {
				if (!node.sdk || !(node.sdk instanceof IARToolchain)) {return;}

				if (await showConfirmMessage(`Remove ${node.sdk.name} from workspace?`)) {
					await unregisterIARToolchain(node.sdk.iarPath);
					zephyrSdkProvider.refresh();
				}
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"zephyr-workbench-sdk-explorer.delete-iar",
			async (node: ZephyrSdkTreeItem) => {
				/* guard‑rails */
				if (!node.sdk || !(node.sdk instanceof IARToolchain)) {
					vscode.window.showWarningMessage("No IAR toolchain selected.");
					return;
				}

				/* confirm with user */
				if (
					!(await showConfirmMessage(`Delete ${node.sdk.name} permanently?`))
				) {
					return;
				}

				const iarPath = node.sdk.iarPath;

				vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Deleting IAR Toolchain",
						cancellable: false,
					},
					async () => {
						await unregisterIARToolchain(iarPath);
						deleteFolder(iarPath);
						zephyrSdkProvider.refresh();
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
			if ((await getListZephyrSDKs()).length === 0) {
				const importSDKItem = 'Import SDK';
				const choice = await vscode.window.showErrorMessage("No Zephyr SDK found. Please import a SDK first.", importSDKItem);
				if (choice === importSDKItem) {
					vscode.commands.executeCommand('zephyr-workbench-sdk-explorer.open-wizard');
				}
				return;
			}

			CreateZephyrAppPanel.render(context.extensionUri);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.import-app-wizard", async () => {
			if (getWestWorkspaces().length === 0) {
				const initWorkspaceItem = 'Initialize Workspace';
				const choice = await vscode.window.showErrorMessage("No west workspace found. Please initialize a workspace first.", initWorkspaceItem);
				if (choice === initWorkspaceItem) {
					vscode.commands.executeCommand('zephyr-workbench-west-workspace.open-wizard');
				}
				return;
			}
			if ((await getListZephyrSDKs()).length === 0) {
				const importSDKItem = 'Import SDK';
				const choice = await vscode.window.showErrorMessage("No Zephyr SDK found. Please import a SDK first.", importSDKItem);
				if (choice === importSDKItem) {
					vscode.commands.executeCommand('zephyr-workbench-sdk-explorer.open-wizard');
				}
				return;
			}
			importProjectQuickStep(context);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.create-app", async (westWorkspace, zephyrSample, zephyrBoard, projectLoc = '', projectName = '', toolchain, pristineValue = 'auto', venvMode = 'global') => {
			if (!westWorkspace) {
				vscode.window.showErrorMessage('Missing west workspace, please select a west workspace');
				return;
			}

			if (!toolchain) {
				vscode.window.showErrorMessage('Missing Zephyr SDK, a SDK is required to provide toolchain to your project');
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
				vscode.window.showErrorMessage('Missing selected sample, it serves as base for your project');
				return;
			}

			if (!fileExists(projectLoc)) {
				vscode.window.showErrorMessage(`Project destination location "${projectLoc}" does not exists`);
				return;
			}

			vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: "Creating new application...",
				cancellable: false,
			}, async (progress, token) => {
				let projLoc: string;
				if (projectLoc.length === 0) {
					projLoc = zephyrSample.rootDir.fsPath;
				} else {
					let projectPath = path.join(projectLoc, projectName);
					if (fileExists(projectPath)) {
						vscode.window.showErrorMessage(`The folder [${projectPath}] already exists. Please change the project name or its location.`);
						return;
					}
					projLoc = copySampleSync(zephyrSample.rootDir.fsPath, projectPath);
				}
				await addWorkspaceFolder(projLoc);

				let workspaceFolder = getWorkspaceFolder(projLoc);
				if (workspaceFolder) {
					await setDefaultProjectSettings(workspaceFolder, westWorkspace, zephyrBoard, toolchain);
					await createTasksJson(workspaceFolder);
					await createExtensionsJson(workspaceFolder);
					await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder).update(ZEPHYR_WORKBENCH_BUILD_PRISTINE_SETTING_KEY, pristineValue, vscode.ConfigurationTarget.WorkspaceFolder);

					// Create a local Python venv if requested
					if (venvMode === 'local') {
						const venvPath = await createLocalVenv(context, workspaceFolder);
						if (venvPath) {
							await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
								.update(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY, venvPath, vscode.ConfigurationTarget.WorkspaceFolder);
						}
					}
					CreateZephyrAppPanel.currentPanel?.dispose();

					vscode.window.showInformationMessage(`New Application '${workspaceFolder.name}' created !`);
				}
			}
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("zephyr-workbench-app-explorer.import-app", async (projectLoc, westWorkspace, zephyrBoard, zephyrSDK, venvMode = 'global') => {
			if (!fileExists(projectLoc)) {
				vscode.window.showInformationMessage(`Project '${projectLoc}' not found !`);
				return;
			}

			await addWorkspaceFolder(projectLoc);

			let workspaceFolder = getWorkspaceFolder(projectLoc);
			if (workspaceFolder && westWorkspace && zephyrBoard && zephyrSDK) {
				await setDefaultProjectSettings(workspaceFolder, westWorkspace, zephyrBoard, zephyrSDK);
				await createTasksJson(workspaceFolder);
				await createExtensionsJson(workspaceFolder);
				// Optionally create a local venv for the imported project
				if (venvMode === 'local') {
					const venvPath = await createLocalVenv(context, workspaceFolder);
					if (venvPath) {
						await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, workspaceFolder)
							.update(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY, venvPath, vscode.ConfigurationTarget.WorkspaceFolder);
					}
				}
				vscode.window.showInformationMessage(`Importing Application '${workspaceFolder.name}' done`);
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
			if (workspaceDestPath && !isWorkspaceFolder(workspaceDestPath)) {
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
					} catch (e) {
						if (e instanceof Error) {
							if ((e as any).cause.startsWith(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)) {
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
		vscode.commands.registerCommand("zephyr-workbench-west-workspace.import-from-template", async (remotePath, remoteBranch, workspacePath, templateHal, templateMode) => {
			if (remotePath && remoteBranch && workspacePath && templateHal) {
				// Determine if mode is 'full' or 'minimal'
				const isFull = templateMode === 'full';
				// Generate west.xml from template
				let manifestFile = generateWestManifest(context, remotePath, remoteBranch, workspacePath, templateHal, isFull);
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

			if (event.affectsConfiguration(ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY)) {
				zephyrSdkProvider.refresh();
			}

			if (event.affectsConfiguration(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY)) {
				zephyrShortcutProvider.refresh();
				zephyrToolsCommandProvider.refresh();
			}

			if (event.affectsConfiguration(`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_BOARD_SETTING_KEY}`) ||
				event.affectsConfiguration(`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_WEST_WORKSPACE_SETTING_KEY}`) ||
				event.affectsConfiguration(`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.${ZEPHYR_PROJECT_SDK_SETTING_KEY}`) ||
				event.affectsConfiguration(`${ZEPHYR_WORKBENCH_SETTING_SECTION_KEY}.build.configurations`)) {
				zephyrAppProvider.refresh();
			}
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
	const currentFolder = getCurrentWorkspaceFolder();
	if (currentFolder && await ZephyrAppProject.isZephyrProjectWorkspaceFolder(currentFolder)) {
		statusBarBuildItem.tooltip = `Zephyr: Build ${currentFolder.name}`;
		statusBarDebugItem.tooltip = `Zephyr: Debug ${currentFolder.name}`;
		statusBarBuildItem.show();
		statusBarDebugItem.show();
	} else {
		statusBarBuildItem.hide();
		statusBarDebugItem.hide();
	}
}

async function updateCompileSetting(project: ZephyrAppProject, configName: string, boardIdentifier: string) {
	const buildConfig = project.getBuildConfiguration(configName);
	const zephyrSDK = getZephyrSDK(project.sdkPath);
	const westWorkspace = getWestWorkspace(project.westWorkspacePath);
	const board = await getBoardFromIdentifier(boardIdentifier, westWorkspace);

	if (buildConfig) {
		let socToolchainName = buildConfig.getKConfigValue(project, 'SOC_TOOLCHAIN_NAME');
		if (socToolchainName) {
			await vscode.workspace.getConfiguration('C_Cpp', project.workspaceFolder).update('default.compilerPath', zephyrSDK.getCompilerPath(board.arch, socToolchainName), vscode.ConfigurationTarget.WorkspaceFolder);
		}
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
	if (node instanceof ZephyrApplicationTreeItem) {
		if (node.project) {
			context = node.project;
			folder = node.project.workspaceFolder;
		}
	} else if (node instanceof ZephyrConfigTreeItem) {
		if (node.project) {
			context = node.project;
			folder = node.project.workspaceFolder;
			configName = node.buildConfig.name;
		}
	} else if (node instanceof vscode.Uri) {
		folder = vscode.workspace.getWorkspaceFolder(node);
		if (folder) {
			context = await getZephyrProject(folder.uri.fsPath);
			configName = undefined;
		}
	}
  else {
    context = await getZephyrProject(node.uri.fsPath);
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
		} else if (context.configs && context.configs.length > 1) {
			let hasActive = false;
			for (let config of context.configs) {
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

		} else if (context.configs && context.configs.length === 1) {
			let task = await findConfigTask(taskName, context, context.configs[0].name);
			if (task) {
				listTasks.push(task);
			}
		}
	}

	return new Promise<vscode.TaskExecution[] | undefined>(async resolve => {
		// These specific commands below are executed directly, they are not saved in tasks.json
		const tasks = ['DT Doctor', 'West ROM Report', 'West RAM Report', 'Gui Config', 'Menu Config', 'Harden Config'];
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

// This method is called when your extension is deactivated
export function deactivate() {
	zephyrTaskProvider?.dispose();
	zephyrDebugConfigurationProvide?.dispose();
}
