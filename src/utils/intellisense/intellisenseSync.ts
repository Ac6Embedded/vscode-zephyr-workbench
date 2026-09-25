// Keeps IntelliSense in step with a build, whoever started it.
//
// These helpers used to be private to extension.ts, which meant only a build
// started from the UI refreshed the compiler path. They live here so the
// Applications view build command and an AI agent's build share one code path,
// and an agent build that creates a build directory leaves cpptools or clangd
// correctly configured.

import * as path from 'path';
import * as vscode from 'vscode';
import { ZephyrApplication } from '../../models/ZephyrApplication';
import type { ZephyrBuildConfig } from '../../models/ZephyrBuildConfig';
import { normalizeZephyrSdkVariant, ZephyrSdkInstallation } from '../../models/ToolchainInstallations';
import { updateCppToolsConfiguration } from '../../providers/ZephyrTaskProvider';
import { getWestWorkspace, getZephyrApplication, isGlobalSdkSettingValue, tryGetZephyrSdkInstallation } from '../utils';
import { ZEPHYR_PROJECT_INTELLISENSE_PROVIDER_SETTING_KEY } from '../../constants';
import { updateApplicationSettings } from '../zephyr/applicationSettings';
import { getBoardFromIdentifier } from '../zephyr/boardDiscovery';
import { resolveGlobalSdkForZephyr } from '../zephyr/globalSdkService';
import { getEffectiveWorkspaceApplicationEntry, resolveWorkspaceApplicationPath } from '../zephyr/workspaceApplications';
import {
	applyCppToolsSuppression,
	clearManagedClangdArtifacts,
	ensureManagedClangdArguments,
	getQueryDriverFallbackGlob,
	getQueryDriverGlobForCompiler,
	restartClangdServer,
	updateClangdConfigFile,
} from './clangdConfig';
import { IntelliSenseProviderId } from './providerAvailability';

// Resolve the SDK installation a per-app 'sdk' setting value stands for: the
// 'global' sentinel resolves (advisory, for display/IntelliSense/compat only)
// to the detected global SDK the build would pick; paths resolve normally.
export function resolveSdkInstallationForSetting(sdkSettingValue: string | undefined, zephyrBasePath?: string): ZephyrSdkInstallation | undefined {
	if (!sdkSettingValue) {
		return undefined;
	}
	if (isGlobalSdkSettingValue(sdkSettingValue)) {
		return resolveGlobalSdkForZephyr(zephyrBasePath);
	}
	return tryGetZephyrSdkInstallation(sdkSettingValue);
}

export function isSelectedIntelliSenseApplication(project: ZephyrApplication): boolean {
	if (!project.isWestWorkspaceApplication) {
		return true;
	}

	const effectiveEntry = getEffectiveWorkspaceApplicationEntry(project.appWorkspaceFolder);
	const effectivePath = effectiveEntry
		? resolveWorkspaceApplicationPath(effectiveEntry, project.appWorkspaceFolder)
		: undefined;
	return !!effectivePath && path.normalize(effectivePath) === path.normalize(project.appRootPath);
}

// Route a resolved compiler path to whichever IntelliSense provider the app
// uses. cpptools keeps its existing c_cpp_properties.json write; clangd merges
// the compiler's query-driver glob (idempotent) and restarts only on change.
export async function applyIntelliSenseCompilerPath(project: ZephyrApplication, compilerPath: string): Promise<void> {
	if (!compilerPath) {
		return;
	}
	if (project.intellisenseProvider === 'clangd') {
		if (await ensureManagedClangdArguments([getQueryDriverGlobForCompiler(compilerPath)])) {
			await restartClangdServer();
		}
		return;
	}
	await updateCppToolsConfiguration(project.appWorkspaceFolder, { compilerPath });
}

export async function updateCompileSetting(project: ZephyrApplication, configName: string, boardIdentifier: string) {
	if (!isSelectedIntelliSenseApplication(project)) {
		return;
	}
	const buildConfig = project.getBuildConfiguration(configName);
	const westWorkspace = getWestWorkspace(project.westWorkspaceRootPath);
	const board = await getBoardFromIdentifier(boardIdentifier, westWorkspace);
	const toolchainVariantId = project.toolchainVariant;
	const zephyrSdkInstallation = resolveSdkInstallationForSetting(project.zephyrSdkPath, westWorkspace.kernelUri.fsPath);
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
				await applyIntelliSenseCompilerPath(project, compilerPath);
			}
		}
	}
}

/**
 * After a build finishes, point IntelliSense at the compiler the build used.
 * This is the post-build step of the Applications view build command, lifted
 * out unchanged so an agent build does exactly the same thing.
 */
export async function syncIntellisenseAfterBuild(
	folder: vscode.WorkspaceFolder, configName: string, boardIdentifier: string,
): Promise<void> {
	const project = await getZephyrApplication(folder.uri.fsPath);
	if (project.intellisenseProvider === 'clangd') {
		// clangd apps do not carry a C_Cpp.default.compilerPath heuristic;
		// re-resolve so the built config's exact compiler joins the
		// query-driver allowlist (idempotent after the first build).
		if (boardIdentifier.length === 0 && project.buildConfigs[0]) {
			boardIdentifier = project.buildConfigs[0].boardIdentifier;
		}
		await updateCompileSetting(project, configName, boardIdentifier);
		return;
	}
	const gccPath: string | undefined = vscode.workspace.getConfiguration('C_Cpp', folder).get('default.compilerPath');
	if (gccPath && gccPath.includes('undefined')) {
		// Use-case if build out of APPLICATIONS view, means from WorkspaceFolder
		// Cannot know board identifier beforehand so detect if after parsing settings.json
		// On non-legacy project, assume first config can be the "master"
		if (boardIdentifier.length === 0) {
			boardIdentifier = project.buildConfigs[0].boardIdentifier;
		}
		await updateCompileSetting(project, configName, boardIdentifier);
	}
}

// The helpers below used to be private to extension.ts. They live here so
// that changing, activating or selecting a build configuration from the
// Applications view or from an agent tool points IntelliSense at the same
// compile_commands.json.

export function isSysbuildEnabled(buildConfig: ZephyrBuildConfig, override?: boolean): boolean {
	return typeof override === 'boolean'
		? override
		: String(buildConfig.sysbuild).toLowerCase() === 'true';
}

export function getBuildConfigCompileCommandsPath(
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

// Query-driver globs that let clangd trust this application's cross-compiler.
// Broad by design (an allowlist): the exact per-compiler glob is merged in by
// updateCompileSetting after the first build resolves SOC_TOOLCHAIN_NAME.
export function collectQueryDriverGlobsFor(project: ZephyrApplication): Array<string | undefined> {
	if (project.toolchainVariant === 'gnuarmemb') {
		return [getQueryDriverGlobForCompiler(project.selectedArmGnuToolchainInstallation?.compilerPath ?? '')];
	}
	if (project.zephyrSdkPath && !project.isGlobalSdk) {
		return [getQueryDriverFallbackGlob(project.zephyrSdkPath)];
	}
	return [];
}

export async function updateBuildConfigCompileCommandsSetting(
	project: ZephyrApplication,
	buildConfig: ZephyrBuildConfig,
	sysbuildOverride?: boolean,
): Promise<void> {
	if (!isSelectedIntelliSenseApplication(project)) {
		return;
	}
	const compileCommandsPath = getBuildConfigCompileCommandsPath(project, buildConfig, sysbuildOverride);
	if (project.intellisenseProvider === 'clangd') {
		await updateClangdConfigFile(project.appWorkspaceFolder, {
			compileCommandsDir: path.dirname(compileCommandsPath),
		});
		await applyCppToolsSuppression(project.appWorkspaceFolder);
		if (await ensureManagedClangdArguments(collectQueryDriverGlobsFor(project))) {
			await restartClangdServer();
		}
		return;
	}
	// cpptools app: reconcile a shared west root that a workbench-managed clangd
	// app configured. Gated on a managed .clangd, so a folder the workbench never
	// configured for clangd (including a user's own C_Cpp settings) is untouched.
	await clearManagedClangdArtifacts(project.appWorkspaceFolder);
	await updateCppToolsConfiguration(project.appWorkspaceFolder, {
		compileCommandsPath,
	});
}

/**
 * Switch the application to another IntelliSense provider, as the Change
 * IntelliSense Provider command does: store the choice, then reconfigure the
 * active build configuration from a freshly read application, so the
 * provider-aware sync sees the new choice. Switching to clangd writes the
 * .clangd file plus the folder-scoped cpptools suppression; switching back
 * removes them and refreshes c_cpp_properties.json. `reload` reads the
 * application again; an agent tool passes one that shows no notification.
 */
export async function setApplicationIntelliSenseProvider(
	project: ZephyrApplication,
	provider: IntelliSenseProviderId,
	reload: (appRootPath: string) => Promise<ZephyrApplication> = getZephyrApplication,
): Promise<void> {
	await updateApplicationSettings(project, {
		[ZEPHYR_PROJECT_INTELLISENSE_PROVIDER_SETTING_KEY]: provider,
	});

	const refreshed = await reload(project.appRootPath);
	const activeConfig = refreshed.buildConfigs.find(config => config.active) ?? refreshed.buildConfigs[0];
	if (activeConfig) {
		await updateBuildConfigCompileCommandsSetting(refreshed, activeConfig);
		if (provider === 'cpptools') {
			await updateCompileSetting(refreshed, activeConfig.name, activeConfig.boardIdentifier);
		}
	}
}
