import * as path from 'path';
import * as vscode from 'vscode';
import { WestWorkspace } from '../models/WestWorkspace';
import { ZephyrApplication } from '../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../models/ZephyrBuildConfig';
import {
	getEffectiveWorkspaceApplicationEntry,
	isPathWithin as isPathWithinWorkspaceApplication,
	resolveWorkspaceApplicationPath,
} from '../utils/zephyr/workspaceApplications';
import { getNonce } from '../utilities/getNonce';
import {
	readZephyrBuildSummary,
	readZephyrStatFile,
	type ZephyrBuildSummary,
	type ZephyrStatFileContent,
} from '../utils/zephyr/buildSummaryParser';
import { readZephyrMemoryReport, type ZephyrMemoryReport } from '../utils/zephyr/memoryReportParser';
import { readZephyrMemoryTreeReport, type ZephyrMemoryTreeReport } from '../utils/zephyr/memoryTreeParser';
import { readZephyrSysInitReport, type ZephyrSysInitReport } from '../utils/zephyr/sysInitParser';
import { readZephyrDeviceTreeReport, type ZephyrDeviceTreeReport } from '../utils/zephyr/dtsReportParser';
import { readZephyrKconfigReport, type ZephyrKconfigReport } from '../utils/zephyr/kconfigReportParser';

interface DashboardTarget {
	projects: ZephyrApplication[];
	selectedProject?: ZephyrApplication;
	selectedConfig?: ZephyrBuildConfig;
	buildDir?: string;
	elfPath?: string;
	summary?: ZephyrBuildSummary;
	report?: ZephyrSysInitReport;
	memoryReport?: ZephyrMemoryReport;
	memoryError?: string;
	memoryTree?: ZephyrMemoryTreeReport;
	deviceTree?: ZephyrDeviceTreeReport;
	deviceTreeError?: string;
	kconfig?: ZephyrKconfigReport;
	kconfigError?: string;
	elfStat?: ZephyrStatFileContent;
	statPath?: string;
	error?: string;
}

interface DashboardViewModel {
	hasProjects: boolean;
	hasContent: boolean;
	hasReport: boolean;
	hasMemoryReport: boolean;
	hasMemoryTree: boolean;
	hasDeviceTree: boolean;
	hasKconfig: boolean;
	projectLabel: string;
	configLabel: string;
	boardLabel: string;
	buildDir: string;
	elfPath: string;
	statPath: string;
	message: string;
	hint: string;
	summary?: ZephyrBuildSummary;
	report?: ZephyrSysInitReport;
	memoryReport?: ZephyrMemoryReport;
	memoryError?: string;
	memoryTree?: ZephyrMemoryTreeReport;
	deviceTree?: ZephyrDeviceTreeReport;
	deviceTreeError?: string;
	kconfig?: ZephyrKconfigReport;
	kconfigError?: string;
	elfStat?: ZephyrStatFileContent;
}

export class ZephyrDashboardViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	public static readonly viewId = 'zephyr-workbench-dashboard';
	public static readonly panelContainerId = 'zephyr-workbench-dashboard-panel';

	private _view?: vscode.WebviewView;
	private _webviewDisposables: vscode.Disposable[] = [];
	private _revealedProjectPath?: string;
	private _isReady = false;

	public dispose(): void {
		while (this._webviewDisposables.length > 0) {
			this._webviewDisposables.pop()?.dispose();
		}
		this._view = undefined;
		this._isReady = false;
	}

	public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
		this.dispose();
		this._view = webviewView;
		this._isReady = false;

		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this._getHtml(webviewView.webview);

		this._webviewDisposables.push(
			webviewView.webview.onDidReceiveMessage(async (message) => {
				await this._handleMessage(message);
			}),
			webviewView.onDidDispose(() => {
				if (this._view === webviewView) {
					this._view = undefined;
				}
				this._isReady = false;
			}),
			webviewView.onDidChangeVisibility(() => {
				if (webviewView.visible) {
					void this.refresh();
				}
			}),
		);
	}

	public async reveal(node?: unknown): Promise<void> {
		this._setTargetFromNode(node);
		await this._revealView();
		await this.refresh();
	}

	public async refresh(): Promise<void> {
		const target = await this._resolveTarget();

		if (!this._view) {
			return;
		}

		this._view.description = this._getDescription(target);

		if (!this._isReady || !this._view.visible) {
			return;
		}

		await this._view.webview.postMessage({
			command: 'model',
			model: this._createViewModel(target),
		});
	}

	private async _handleMessage(message: any): Promise<void> {
		switch (message?.command) {
			case 'ready':
				this._isReady = true;
				await this.refresh();
				break;
			case 'refresh':
				await this.refresh();
				break;
			case 'openFile':
				await this._openFile(message?.path, message?.line);
				break;
			case 'openExternal':
				await this._openExternal(message?.url);
				break;
			case 'revealSymbol':
				await this._revealSymbol(message?.name);
				break;
			default:
				break;
		}
	}

	private async _revealSymbol(symbolName: unknown): Promise<void> {
		if (typeof symbolName !== 'string' || symbolName.length === 0) {
			return;
		}

		try {
			const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
				'vscode.executeWorkspaceSymbolProvider',
				symbolName,
			);

			const match = symbols?.find(s => s.name === symbolName) ?? symbols?.[0];
			if (!match) {
				void vscode.window.showInformationMessage(`No declaration found for "${symbolName}" in the workspace.`);
				return;
			}

			const document = await vscode.workspace.openTextDocument(match.location.uri);
			await vscode.window.showTextDocument(document, {
				preview: false,
				preserveFocus: false,
				selection: match.location.range,
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			void vscode.window.showWarningMessage(`Unable to reveal symbol: ${reason}`);
		}
	}

	private async _openFile(filePath: unknown, line?: unknown): Promise<void> {
		if (typeof filePath !== 'string' || filePath.length === 0) {
			return;
		}

		const lineNumber = typeof line === 'number' && Number.isInteger(line) && line > 0 ? line : undefined;

		try {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
			const options: vscode.TextDocumentShowOptions = { preview: false, preserveFocus: false };
			if (lineNumber !== undefined) {
				const position = new vscode.Position(lineNumber - 1, 0);
				options.selection = new vscode.Range(position, position);
			}
			await vscode.window.showTextDocument(document, options);
		} catch {
			void vscode.window.showWarningMessage(`Unable to open file: ${filePath}`);
		}
	}

	private async _openExternal(url: unknown): Promise<void> {
		if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
			return;
		}

		try {
			await vscode.env.openExternal(vscode.Uri.parse(url));
		} catch {
			void vscode.window.showWarningMessage(`Unable to open link: ${url}`);
		}
	}

	private _setTargetFromNode(node?: unknown): void {
		if (!node) {
			return;
		}

		let projectPath: string | undefined;

		if ((node as any)?.project?.appWorkspaceFolder?.uri?.fsPath) {
			projectPath = (node as any).project.appRootPath;
		}

		if (!projectPath && (node as vscode.WorkspaceFolder)?.uri?.fsPath) {
			projectPath = (node as vscode.WorkspaceFolder).uri.fsPath;
		}

		if (!projectPath && (node as vscode.Uri)?.fsPath) {
			projectPath = vscode.workspace.getWorkspaceFolder(node as vscode.Uri)?.uri.fsPath;
		}

		if (projectPath) {
			this._revealedProjectPath = projectPath;
		}
	}

	private async _revealView(): Promise<void> {
		const commands = [
			`workbench.view.extension.${ZephyrDashboardViewProvider.panelContainerId}`,
			`${ZephyrDashboardViewProvider.viewId}.focus`,
			'workbench.action.focusPanel',
		];

		for (const command of commands) {
			try {
				await vscode.commands.executeCommand(command);
			} catch {
				// Best-effort reveal because command availability differs by layout.
			}
		}
	}

	private async _getProjects(): Promise<ZephyrApplication[]> {
		return ZephyrApplication.getApplications(vscode.workspace.workspaceFolders ?? []);
	}

	private async _resolveTarget(): Promise<DashboardTarget> {
		const projects = await this._getProjects();
		const selectedProject = this._selectProject(projects);
		const selectedConfig = this._selectConfig(selectedProject);

		if (!selectedProject || !selectedConfig) {
			return {
				projects,
				selectedProject,
				selectedConfig,
			};
		}

		const buildDir = selectedConfig.getBuildDir(selectedProject);
		const elfPath = selectedConfig.getBuildArtifactPath(selectedProject, 'zephyr', 'zephyr.elf');
		const binPath = selectedConfig.getBuildArtifactPath(selectedProject, 'zephyr', 'zephyr.bin');
		const hexPath = selectedConfig.getBuildArtifactPath(selectedProject, 'zephyr', 'zephyr.hex');
		const mapPath = selectedConfig.getBuildArtifactPath(selectedProject, 'zephyr', 'zephyr.map');
		const dotConfigPath = selectedConfig.getBuildArtifactPath(selectedProject, 'zephyr', '.config');
		const cmakeCachePath = selectedConfig.getBuildArtifactPath(selectedProject, 'CMakeCache.txt');
		const buildInfoPath = selectedConfig.getBuildArtifactPath(selectedProject, 'build_info.yml');
		const metaPath = selectedConfig.getBuildArtifactPath(selectedProject, 'zephyr', 'zephyr.meta');
		const statPath = selectedConfig.getBuildArtifactPath(selectedProject, 'zephyr', 'zephyr.stat');
		const dtsPath = selectedConfig.getBuildArtifactPath(selectedProject, 'zephyr', 'zephyr.dts');
		const traceJsonPath = selectedConfig.getBuildArtifactPath(selectedProject, 'zephyr', '.config-trace.json');
		const devicetreeHeaderPath = selectedConfig.getBuildArtifactPath(
			selectedProject,
			'zephyr',
			'include',
			'generated',
			'zephyr',
			'devicetree_generated.h',
		);
		const summary = readZephyrBuildSummary({
			buildDir,
			elfPath,
			binPath,
			hexPath,
			mapPath,
			dotConfigPath,
			cmakeCachePath,
			buildInfoPath,
			metaPath,
			statPath,
		});

		// The device tree, Kconfig, and ELF stats views only need on-disk
		// artifacts, so resolve them up front and expose them even when the ELF
		// is missing (a partially built tree can still show these tabs).
		let deviceTree: ZephyrDeviceTreeReport | undefined;
		let deviceTreeError: string | undefined;
		if (dtsPath) {
			try {
				deviceTree = readZephyrDeviceTreeReport({
					dtsPath,
					westWorkspaceRoot: selectedProject.westWorkspaceRootPath,
					appRootPath: selectedProject.appRootPath,
				});
			} catch (error) {
				deviceTreeError = error instanceof Error ? error.message : String(error);
			}
		}

		let kconfig: ZephyrKconfigReport | undefined;
		let kconfigError: string | undefined;
		try {
			kconfig = readZephyrKconfigReport({
				traceJsonPath,
				dotConfigPath,
				zephyrBase: summary?.target?.zephyrBase,
				westWorkspaceRoot: selectedProject.westWorkspaceRootPath,
			});
		} catch (error) {
			kconfigError = error instanceof Error ? error.message : String(error);
		}

		const elfStat = readZephyrStatFile(statPath);

		if (!elfPath) {
			return {
				projects,
				selectedProject,
				selectedConfig,
				buildDir,
				summary,
				deviceTree,
				deviceTreeError,
				kconfig,
				kconfigError,
				elfStat,
				statPath,
				error: 'No zephyr.elf was found for the selected build configuration.',
			};
		}

		let memoryReport: ZephyrMemoryReport | undefined;
		let memoryError: string | undefined;
		try {
			memoryReport = readZephyrMemoryReport(elfPath);
		} catch (error) {
			memoryError = error instanceof Error ? error.message : String(error);
		}

		// Source-path grouped tree (like Zephyr's size_report plot), built in
		// process from the ELF's DWARF debug info.
		let memoryTree: ZephyrMemoryTreeReport | undefined;
		try {
			memoryTree = readZephyrMemoryTreeReport({ elfPath, zephyrBase: summary?.target?.zephyrBase });
		} catch {
			memoryTree = undefined;
		}

		try {
			const report = readZephyrSysInitReport({
				buildDir,
				elfPath,
				devicetreeHeaderPath,
			});

			return {
				projects,
				selectedProject,
				selectedConfig,
				buildDir,
				elfPath,
				summary,
				report,
				memoryReport,
				memoryError,
				memoryTree,
				deviceTree,
				deviceTreeError,
				kconfig,
				kconfigError,
				elfStat,
				statPath,
			};
		} catch (error) {
			return {
				projects,
				selectedProject,
				selectedConfig,
				buildDir,
				elfPath,
				summary,
				memoryReport,
				memoryError,
				memoryTree,
				deviceTree,
				deviceTreeError,
				kconfig,
				kconfigError,
				elfStat,
				statPath,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private _selectProject(projects: ZephyrApplication[]): ZephyrApplication | undefined {
		if (projects.length === 0) {
			this._revealedProjectPath = undefined;
			return undefined;
		}

		const editor = vscode.window.activeTextEditor;
		if (editor) {
			const activeEditorFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
			if (!activeEditorFolder) {
				return undefined;
			}

			const activeProject = projects.find(project => isPathWithinWorkspaceApplication(project.appRootPath, editor.document.uri.fsPath));
			if (activeProject) {
				return activeProject;
			}

			// File is somewhere inside a west workspace but outside any app folder
			// (e.g. shared modules, workspace root). Fall back to that workspace's
			// selected application so the dashboard tracks the user's last
			// explicit selection instead of going blank.
			if (WestWorkspace.isWestWorkspaceFolder(activeEditorFolder)) {
				const selectedEntry = getEffectiveWorkspaceApplicationEntry(activeEditorFolder);
				const selectedPath = selectedEntry
					? resolveWorkspaceApplicationPath(selectedEntry, activeEditorFolder)
					: undefined;
				if (selectedPath) {
					const normalizedSelectedPath = path.normalize(selectedPath);
					const selectedProject = projects.find(project => path.normalize(project.appRootPath) === normalizedSelectedPath);
					if (selectedProject) {
						return selectedProject;
					}
				}
			}

			return undefined;
		}

		if (this._revealedProjectPath) {
			const revealedProject = projects.find(project => project.appRootPath === this._revealedProjectPath);
			if (revealedProject) {
				return revealedProject;
			}
			this._revealedProjectPath = undefined;
		}

		return undefined;
	}

	private _selectConfig(project?: ZephyrApplication): ZephyrBuildConfig | undefined {
		if (!project || project.buildConfigs.length === 0) {
			return undefined;
		}

		return project.buildConfigs.find(config => config.active) ?? project.buildConfigs[0];
	}

	private _getDescription(target: DashboardTarget): string | undefined {
		if (!target.selectedProject) {
			return undefined;
		}

		if (!target.selectedConfig) {
			return target.selectedProject.appName;
		}

		return `${target.selectedProject.appName} / ${target.selectedConfig.name}`;
	}

	private _createViewModel(target: DashboardTarget): DashboardViewModel {
		let message = '';
		let hint = '';

		if (target.projects.length === 0) {
			message = 'No Zephyr application found.';
			hint = 'Open a file from a Zephyr application or add one to the workspace.';
		} else if (!target.selectedProject) {
			message = 'No active Zephyr application.';
			hint = 'Open a file from a Zephyr application to populate the dashboard.';
		} else if (!target.selectedConfig) {
			message = 'No build configuration found.';
			hint = 'Create or import a build configuration first.';
		} else if (target.report) {
			message = `${target.report.totalEntries} init calls parsed from zephyr.elf`;
			hint = '';
		} else if (target.error) {
			message = 'Unable to read sys-init data.';
			hint = target.error;
		} else {
			message = 'No sys-init data available.';
			hint = 'Build the active configuration so zephyr.elf exists.';
		}

		return {
			hasProjects: target.projects.length > 0,
			hasContent:
				!!target.summary ||
				!!target.report ||
				!!target.memoryReport ||
				!!target.deviceTree ||
				!!target.kconfig ||
				!!target.elfStat,
			hasReport: !!target.report,
			hasMemoryReport: !!target.memoryReport,
			hasMemoryTree: !!(target.memoryTree && (target.memoryTree.ram || target.memoryTree.rom)),
			hasDeviceTree: !!target.deviceTree,
			hasKconfig: !!target.kconfig,
			projectLabel: target.selectedProject?.appName ?? '',
			configLabel: target.selectedConfig?.name ?? '',
			boardLabel: target.selectedConfig?.boardIdentifier ?? '',
			buildDir: target.buildDir ?? '',
			elfPath: target.elfPath ?? '',
			statPath: target.statPath ?? '',
			message,
			hint,
			summary: target.summary,
			report: target.report,
			memoryReport: target.memoryReport,
			memoryError: target.memoryError,
			memoryTree: target.memoryTree,
			deviceTree: target.deviceTree,
			deviceTreeError: target.deviceTreeError,
			kconfig: target.kconfig,
			kconfigError: target.kconfigError,
			elfStat: target.elfStat,
		};
	}

	private _getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();

		return /* html */`
<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<title>Workbench Dashboard</title>
	<style>
		:root {
			color-scheme: light dark;
			--shell-border: color-mix(in srgb, var(--vscode-panel-border, #3f3f46) 75%, transparent);
			--shell-muted: var(--vscode-descriptionForeground);
			--shell-surface: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 97%, var(--vscode-sideBar-background, #252526));
			--shell-surface-strong: color-mix(in srgb, var(--vscode-editor-background, #1e1e1e) 88%, var(--vscode-sideBar-background, #252526));
			--shell-accent: var(--vscode-textLink-foreground, #4da3ff);
			--shell-chip-device: color-mix(in srgb, var(--vscode-terminal-ansiGreen, #3fb950) 16%, transparent);
			--shell-chip-system: color-mix(in srgb, var(--vscode-terminal-ansiBlue, #58a6ff) 16%, transparent);
			--shell-chip-level: color-mix(in srgb, var(--vscode-terminal-ansiYellow, #d29922) 14%, transparent);
			--shell-row-hover: color-mix(in srgb, var(--shell-accent) 7%, transparent);
		}

		* {
			box-sizing: border-box;
		}

		html, body {
			min-height: 100%;
			margin: 0;
			overflow: auto;
			background: var(--vscode-editor-background, #1e1e1e);
			color: var(--vscode-foreground);
			font-family: var(--vscode-font-family);
		}

		body {
			padding: 6px;
		}

		.shell {
			display: grid;
			gap: 6px;
			align-content: start;
			min-height: 100%;
		}

		.panel {
			min-width: 0;
			border: 1px solid var(--shell-border);
			border-radius: 8px;
			background: color-mix(in srgb, var(--shell-surface) 98%, transparent);
		}

		.toolbar {
			padding: 8px 10px;
			display: grid;
			gap: 6px;
		}

		.toolbar-stack {
			display: grid;
			gap: 8px;
		}

		.toolbar-info {
			display: grid;
			gap: 6px;
		}

		.toolbar-info-row {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
			min-width: 0;
		}

		.title-row {
			display: flex;
			align-items: center;
			gap: 8px;
			flex-wrap: wrap;
			min-width: 0;
		}

		.title {
			font-size: 13px;
			font-weight: 700;
		}

		.meta-row,
		.metric-row {
			display: flex;
			align-items: center;
			gap: 6px;
			flex-wrap: wrap;
			min-width: 0;
		}

		.tag {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			padding: 0 8px;
			height: 24px;
			border-radius: 999px;
			border: 1px solid color-mix(in srgb, var(--shell-border) 85%, transparent);
			background: color-mix(in srgb, var(--shell-surface-strong) 96%, transparent);
			font-size: 10px;
			min-width: 0;
			max-width: 100%;
		}

		.tag-label {
			color: var(--shell-muted);
			text-transform: uppercase;
			letter-spacing: 0.06em;
		}

		.tag > span:last-child {
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.metric {
			display: inline-flex;
			align-items: center;
			padding: 0 8px;
			height: 24px;
			border-radius: 999px;
			background: color-mix(in srgb, var(--shell-accent) 12%, transparent);
			font-size: 10px;
			font-weight: 700;
		}

		.toolbar-bottom {
			display: grid;
			grid-template-columns: minmax(0, 1fr);
			gap: 8px;
			align-items: center;
			min-width: 0;
		}

		.tab-row {
			display: flex;
			align-items: center;
			gap: 6px;
			flex-wrap: wrap;
			padding-bottom: 2px;
			border-bottom: 1px solid color-mix(in srgb, var(--shell-border) 70%, transparent);
		}

		.tab {
			position: relative;
			border: 1px solid transparent;
			background: transparent;
			color: var(--shell-muted);
			border-radius: 6px 6px 0 0;
			padding: 0 12px;
			height: 28px;
			font: inherit;
			font-size: 10px;
			font-weight: 700;
			letter-spacing: 0.04em;
			text-transform: uppercase;
			cursor: pointer;
			margin-bottom: -3px;
		}

		.tab.active {
			color: var(--vscode-foreground);
			border-color: color-mix(in srgb, var(--shell-accent) 32%, var(--shell-border));
			border-bottom-color: var(--shell-surface);
			background: color-mix(in srgb, var(--shell-accent) 10%, var(--shell-surface));
		}

		.tab.active::after {
			content: "";
			position: absolute;
			left: 0;
			right: 0;
			bottom: -1px;
			height: 1px;
			background: var(--shell-surface);
		}

		.tab:hover {
			color: var(--vscode-foreground);
		}

		.search {
			width: 100%;
			min-width: 0;
			height: 30px;
			border-radius: 6px;
			border: 1px solid var(--shell-border);
			background: color-mix(in srgb, var(--shell-surface-strong) 90%, transparent);
			color: var(--vscode-foreground);
			padding: 0 10px;
			font: inherit;
		}

		.status-row {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 10px;
			min-width: 0;
		}

		.summary {
			font-size: 11px;
			color: var(--shell-muted);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			text-align: right;
			min-width: 120px;
		}

		.report-panel {
			display: grid;
			gap: 6px;
			align-content: start;
		}

		.summary-grid {
			display: grid;
			gap: 6px;
			grid-template-columns: minmax(0, 1fr);
		}

		.summary-card {
			display: grid;
			grid-template-columns: 140px minmax(0, 1fr);
			gap: 12px;
			align-items: start;
			padding: 10px;
		}

		.summary-card-title {
			font-size: 11px;
			font-weight: 700;
			text-transform: uppercase;
			letter-spacing: 0.06em;
			color: var(--shell-muted);
			margin-top: 2px;
		}

		.summary-card-content {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			min-width: 0;
		}

		.summary-stat {
			display: inline-flex;
			align-items: baseline;
			gap: 6px;
			min-width: 0;
			max-width: 100%;
			padding: 6px 8px;
			border-radius: 6px;
			border: 1px solid color-mix(in srgb, var(--shell-border) 78%, transparent);
			background: color-mix(in srgb, var(--shell-surface-strong) 96%, transparent);
			font-size: 11px;
		}

		.summary-stat-label {
			color: var(--shell-muted);
			font-size: 10px;
			font-weight: 700;
			letter-spacing: 0.04em;
			text-transform: uppercase;
			white-space: nowrap;
		}

		.summary-stat-value {
			min-width: 0;
			word-break: break-word;
			font-weight: 600;
		}

		.summary-stat-sources {
			align-items: stretch;
			flex-direction: column;
			gap: 6px;
		}

		.summary-stat-sources .summary-stat-label {
			margin-bottom: -1px;
		}

		.summary-source-list {
			display: grid;
			gap: 4px;
			min-width: 0;
		}

		.summary-source-link {
			display: inline-flex;
			align-items: center;
			min-width: 0;
			max-width: 100%;
			padding: 0;
			border: 0;
			background: transparent;
			color: var(--shell-accent);
			font: inherit;
			font-size: 11px;
			font-weight: 600;
			text-align: left;
			cursor: pointer;
		}

		.summary-source-link:hover {
			text-decoration: underline;
		}

		.summary-source-link:focus-visible {
			outline: 1px solid var(--shell-accent);
			outline-offset: 2px;
			border-radius: 3px;
		}

		.symbol-link {
			padding: 0;
			border: 0;
			background: transparent;
			color: var(--shell-accent);
			font: inherit;
			font-family: var(--vscode-editor-font-family, Consolas, monospace);
			font-size: 11px;
			text-align: left;
			cursor: pointer;
			min-width: 0;
			max-width: 100%;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.symbol-link:hover {
			text-decoration: underline;
		}

		.symbol-link:focus-visible {
			outline: 1px solid var(--shell-accent);
			outline-offset: 2px;
			border-radius: 3px;
		}

		.summary-stat-missing {
			background: color-mix(in srgb, var(--shell-border) 20%, transparent);
			border-color: color-mix(in srgb, var(--shell-border) 72%, transparent);
			color: var(--shell-muted);
		}

		.chip-off {
			background: color-mix(in srgb, var(--shell-border) 35%, transparent);
			border-color: color-mix(in srgb, var(--shell-border) 80%, transparent);
			color: var(--shell-muted);
		}

		.level-card {
			overflow: hidden;
		}

		.level-summary {
			list-style: none;
			cursor: pointer;
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 10px;
			padding: 8px 10px;
			user-select: none;
		}

		.level-summary::-webkit-details-marker {
			display: none;
		}

		.level-heading {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			min-width: 0;
			font-size: 11px;
			font-weight: 700;
			letter-spacing: 0.04em;
		}

		.level-chevron {
			color: var(--shell-muted);
			transition: transform 120ms ease;
		}

		.level-card[open] .level-chevron {
			transform: rotate(90deg);
		}

		.table-wrap {
			border-top: 1px solid color-mix(in srgb, var(--shell-border) 70%, transparent);
			overflow-x: auto;
			overflow-y: visible;
		}

		table {
			width: max-content;
			min-width: 100%;
			border-collapse: collapse;
			font-size: 11px;
		}

		th,
		td {
			padding: 5px 8px;
			text-align: left;
			vertical-align: top;
			border-bottom: 1px solid color-mix(in srgb, var(--shell-border) 60%, transparent);
		}

		th {
			position: sticky;
			top: 0;
			background: color-mix(in srgb, var(--shell-surface-strong) 99%, transparent);
			z-index: 2;
			font-size: 10px;
			text-transform: uppercase;
			letter-spacing: 0.06em;
			color: var(--shell-muted);
			white-space: nowrap;
		}

		code {
			font-family: var(--vscode-editor-font-family, Consolas, monospace);
			font-size: 11px;
		}

		tbody tr.data-row:hover td {
			background: var(--shell-row-hover);
		}

		.group-count {
			font-size: 10px;
			font-weight: 600;
			color: var(--shell-muted);
			white-space: nowrap;
		}

		.call-cell,
		.device-cell {
			min-width: 0;
		}

		.call-main {
			display: flex;
			align-items: center;
			gap: 6px;
			flex-wrap: wrap;
			min-width: 0;
		}

		.call-sub {
			color: var(--shell-muted);
			font-size: 10px;
			margin-top: 2px;
			line-height: 1.3;
		}

		.chip {
			display: inline-flex;
			align-items: center;
			padding: 0 6px;
			height: 18px;
			border-radius: 999px;
			font-size: 10px;
			font-weight: 700;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			border: 1px solid transparent;
		}

		.chip-device {
			background: var(--shell-chip-device);
			border-color: color-mix(in srgb, var(--vscode-terminal-ansiGreen, #3fb950) 40%, transparent);
		}

		.chip-system {
			background: var(--shell-chip-system);
			border-color: color-mix(in srgb, var(--vscode-terminal-ansiBlue, #58a6ff) 40%, transparent);
		}

		.chip-level {
			background: var(--shell-chip-level);
			border-color: color-mix(in srgb, var(--vscode-terminal-ansiYellow, #d29922) 40%, transparent);
		}

		.dim {
			color: var(--shell-muted);
		}

		.empty {
			padding: 12px 14px;
			font-size: 12px;
		}

		.empty-title {
			font-weight: 700;
			margin-bottom: 4px;
		}

		.hidden {
			display: none !important;
		}

		/* Memory category palette. Keyed to terminal ansi tokens so it adapts to
		   both light and dark themes; symbol shades derive from the section hue
		   mixed against the editor background. */
		:root {
			--mem-text: var(--vscode-terminal-ansiBlue, #58a6ff);
			--mem-rodata: var(--vscode-terminal-ansiCyan, #39c5cf);
			--mem-data: var(--vscode-terminal-ansiYellow, #d29922);
			--mem-bss: var(--vscode-terminal-ansiMagenta, #bc8cff);
			--mem-tls: var(--vscode-terminal-ansiGreen, #3fb950);
			--mem-other: color-mix(in srgb, var(--vscode-foreground) 32%, transparent);
			--mem-free: color-mix(in srgb, var(--shell-border) 30%, transparent);
			--mem-over: var(--vscode-terminal-ansiRed, #f85149);
		}

		.cat-text { --cat: var(--mem-text); }
		.cat-rodata { --cat: var(--mem-rodata); }
		.cat-data { --cat: var(--mem-data); }
		.cat-bss { --cat: var(--mem-bss); }
		.cat-tls { --cat: var(--mem-tls); }
		.cat-other { --cat: var(--mem-other); }

		.usage-block {
			flex: 1 1 100%;
			display: grid;
			gap: 10px;
			min-width: 0;
			margin-top: 2px;
		}

		.usage-row {
			display: grid;
			gap: 4px;
			min-width: 0;
		}

		.usage-head {
			display: flex;
			align-items: baseline;
			justify-content: space-between;
			gap: 8px;
			font-size: 10px;
			font-weight: 700;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			color: var(--shell-muted);
		}

		.usage-pct { font-variant-numeric: tabular-nums; }
		.usage-pct.usage-over { color: var(--mem-over); }

		.usage-bar {
			display: flex;
			gap: 2px;
			height: 14px;
			border-radius: 4px;
			overflow: hidden;
			background: var(--mem-free);
		}

		.usage-seg { background: var(--cat, var(--mem-other)); min-width: 0; }

		.usage-legend {
			display: flex;
			flex-wrap: wrap;
			gap: 4px 12px;
			font-size: 10px;
			color: var(--shell-muted);
		}

		.usage-legend-item {
			display: inline-flex;
			align-items: center;
			gap: 5px;
			min-width: 0;
		}

		.swatch {
			width: 9px;
			height: 9px;
			border-radius: 2px;
			flex: 0 0 auto;
			background: var(--cat, var(--mem-other));
		}

		.usage-note {
			font-size: 10px;
			color: var(--shell-muted);
			font-style: italic;
		}

		/* Memory plot */
		.plot-layout {
			display: grid;
			grid-template-columns: minmax(0, 1fr) clamp(180px, 24%, 250px);
			gap: 8px;
			align-items: stretch;
		}

		.plot-chart {
			padding: 6px;
			display: grid;
			gap: 6px;
			justify-items: center;
			align-content: start;
		}

		.plot-svg {
			width: 100%;
			height: auto;
			max-height: 82vh;
			min-height: 420px;
			display: block;
		}

		.plot-crumbs {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 4px;
			width: 100%;
			font-size: 11px;
		}

		.crumb {
			border: 0;
			background: transparent;
			color: var(--shell-accent);
			font: inherit;
			font-size: 11px;
			padding: 1px 3px;
			border-radius: 4px;
			cursor: pointer;
			max-width: 160px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.crumb:hover { text-decoration: underline; }
		.crumb-active { color: var(--vscode-foreground); font-weight: 700; padding: 1px 3px; }
		.crumb-sep { color: var(--shell-muted); }

		.plot-arc {
			stroke: var(--vscode-editor-background);
			stroke-width: 1.5px;
			stroke-linejoin: round;
			cursor: pointer;
		}

		.plot-center-hint { font-size: 7px; fill: var(--shell-muted); pointer-events: none; }

		.plot-side {
			padding: 10px;
			display: grid;
			gap: 10px;
			align-content: start;
		}

		.subtoggle-row {
			display: inline-flex;
			gap: 4px;
			padding: 2px;
			border-radius: 8px;
			border: 1px solid var(--shell-border);
			background: color-mix(in srgb, var(--shell-surface-strong) 90%, transparent);
			width: fit-content;
		}

		.subtoggle {
			border: 0;
			background: transparent;
			color: var(--shell-muted);
			font: inherit;
			font-size: 10px;
			font-weight: 700;
			letter-spacing: 0.04em;
			text-transform: uppercase;
			padding: 4px 12px;
			border-radius: 6px;
			cursor: pointer;
		}

		.subtoggle.active {
			background: color-mix(in srgb, var(--shell-accent) 16%, var(--shell-surface));
			color: var(--vscode-foreground);
		}

		.arc {
			stroke: none;
			cursor: pointer;
			transition: opacity 120ms ease;
		}

		.arc:hover, .arc.arc-hot { filter: brightness(1.12); }
		.arc.arc-dim { opacity: 0.22; }

		.plot-center-total { font-size: 13px; font-weight: 700; fill: var(--vscode-foreground); pointer-events: none; }
		.plot-center-label { font-size: 8px; fill: var(--shell-muted); text-transform: uppercase; letter-spacing: 0.06em; pointer-events: none; }
		.plot-hole { fill: transparent; cursor: pointer; }

		/* Curved arc name labels: a background-colored stroke drawn under the fill
		   gives a halo so names stay legible on any wedge color. */
		.arc-label {
			fill: var(--vscode-foreground);
			stroke: var(--vscode-editor-background);
			stroke-width: 0.85px;
			stroke-linejoin: round;
			paint-order: stroke;
			pointer-events: none;
			font-family: var(--vscode-font-family);
			font-weight: 600;
		}

		.lbl-sec { font-size: 6px; }
		.lbl-sym { font-size: 5px; }

		.plot-details {
			display: grid;
			gap: 6px;
			font-size: 11px;
			min-height: 40px;
		}

		.plot-details-name {
			font-family: var(--vscode-editor-font-family, Consolas, monospace);
			font-weight: 600;
			word-break: break-word;
		}

		.plot-details-grid {
			display: grid;
			grid-template-columns: auto 1fr;
			gap: 2px 10px;
			color: var(--shell-muted);
		}

		.plot-details-grid b { color: var(--vscode-foreground); font-weight: 600; }

		.plot-action {
			justify-self: start;
			border: 1px solid var(--shell-border);
			background: color-mix(in srgb, var(--shell-accent) 10%, transparent);
			color: var(--shell-accent);
			font: inherit;
			font-size: 11px;
			padding: 3px 10px;
			border-radius: 6px;
			cursor: pointer;
		}

		.plot-action:hover { text-decoration: underline; }

		.chart-tip {
			position: fixed;
			z-index: 50;
			pointer-events: none;
			max-width: 280px;
			padding: 5px 8px;
			border-radius: 6px;
			border: 1px solid var(--shell-border);
			background: var(--shell-surface-strong);
			box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
			font-size: 11px;
			line-height: 1.35;
		}

		.chart-tip-value { font-weight: 700; }
		.chart-tip-label {
			color: var(--shell-muted);
			word-break: break-word;
			font-family: var(--vscode-editor-font-family, Consolas, monospace);
		}

		/* Device tree + Kconfig tables */
		.node-name {
			font-family: var(--vscode-editor-font-family, Consolas, monospace);
			padding-left: calc(var(--depth, 0) * 12px);
			word-break: break-word;
		}

		tr.row-disabled td { color: var(--shell-muted); }
		tr.row-disabled { opacity: 0.72; }

		.label-chip {
			display: inline-block;
			margin: 0 4px 2px 0;
			font-family: var(--vscode-editor-font-family, Consolas, monospace);
			font-size: 10px;
		}

		.kv-badge {
			display: inline-flex;
			align-items: center;
			padding: 0 6px;
			height: 17px;
			border-radius: 999px;
			font-size: 9px;
			font-weight: 700;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			border: 1px solid transparent;
		}

		.kv-default { background: color-mix(in srgb, var(--shell-border) 32%, transparent); border-color: color-mix(in srgb, var(--shell-border) 70%, transparent); color: var(--shell-muted); }
		.kv-assign { background: color-mix(in srgb, var(--shell-accent) 16%, transparent); border-color: color-mix(in srgb, var(--shell-accent) 40%, transparent); }
		.kv-select { background: var(--shell-chip-system); border-color: color-mix(in srgb, var(--vscode-terminal-ansiBlue, #58a6ff) 40%, transparent); }
		.kv-imply { background: var(--shell-chip-level); border-color: color-mix(in srgb, var(--vscode-terminal-ansiYellow, #d29922) 40%, transparent); }

		.kconfig-name {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			font-family: var(--vscode-editor-font-family, Consolas, monospace);
			word-break: break-word;
		}

		.hidden-tag { font-size: 9px; color: var(--shell-muted); text-transform: uppercase; letter-spacing: 0.05em; }
		.doc-link { color: var(--shell-accent); text-decoration: none; font-size: 11px; cursor: pointer; }
		.doc-link:hover { text-decoration: underline; }

		.tab-note {
			padding: 6px 10px;
			font-size: 11px;
			color: var(--shell-muted);
			display: flex;
			align-items: center;
			gap: 8px;
			flex-wrap: wrap;
		}

		.raw-text {
			margin: 0;
			padding: 10px;
			font-family: var(--vscode-editor-font-family, Consolas, monospace);
			font-size: 11px;
			line-height: 1.45;
			white-space: pre;
			overflow: auto;
			max-height: 62vh;
		}

		.raw-text mark {
			background: color-mix(in srgb, var(--shell-accent) 40%, transparent);
			color: inherit;
			border-radius: 2px;
		}

		@media (max-width: 800px) {
			.toolbar-info-row,
			.toolbar-bottom {
				grid-template-columns: 1fr;
			}

			.summary-card {
				grid-template-columns: 1fr;
				gap: 8px;
			}

			.plot-layout {
				grid-template-columns: 1fr;
			}

			.status-row {
				flex-direction: column;
				align-items: stretch;
				gap: 6px;
			}

			.summary {
				min-width: 0;
				text-align: left;
			}
		}
	</style>
</head>
<body>
	<div class="shell">
		<section class="panel toolbar">
			<div class="toolbar-stack">
				<div id="tabRow" class="tab-row">
					<button class="tab" type="button" data-tab="summary">Summary</button>
					<button class="tab" type="button" data-tab="sys-init">Sys Init</button>
					<button class="tab" type="button" data-tab="ram">RAM</button>
					<button class="tab" type="button" data-tab="rom">ROM</button>
					<button class="tab" type="button" data-tab="memory-plot">Memory Plot</button>
					<button class="tab" type="button" data-tab="kconfig">Kconfig</button>
					<button class="tab" type="button" data-tab="devicetree">Device Tree</button>
					<button class="tab" type="button" data-tab="elf-stats">ELF Stats</button>
				</div>
				<div class="toolbar-info">
					<div class="toolbar-info-row">
						<div class="title-row">
							<div id="tabTitle" class="title">Summary</div>
							<div class="meta-row">
								<span id="projectTag" class="tag hidden"><span class="tag-label">App</span><span id="projectValue"></span></span>
								<span id="configTag" class="tag hidden"><span class="tag-label">Cfg</span><span id="configValue"></span></span>
								<span id="boardTag" class="tag hidden"><span class="tag-label">Board</span><span id="boardValue"></span></span>
							</div>
						</div>
						<div class="metric-row">
							<span id="entriesMetric" class="metric hidden"></span>
							<span id="devicesMetric" class="metric hidden"></span>
							<span id="mappedMetric" class="metric hidden"></span>
						</div>
					</div>
					<div class="toolbar-bottom">
						<div class="status-row">
							<input id="searchInput" class="search" type="text" placeholder="Search function, symbol, device path, ordinal">
							<div id="summary" class="summary"></div>
						</div>
					</div>
				</div>
			</div>
		</section>

		<section id="emptyPanel" class="panel empty hidden">
			<div id="emptyTitle" class="empty-title"></div>
			<div id="emptyHint" class="dim"></div>
		</section>

		<section id="reportPanel" class="report-panel hidden"></section>
	</div>

	<div id="chartTip" class="chart-tip hidden"></div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		let currentModel = undefined;
		let currentState = vscode.getState() || {};

		const projectTag = document.getElementById('projectTag');
		const projectValue = document.getElementById('projectValue');
		const configTag = document.getElementById('configTag');
		const configValue = document.getElementById('configValue');
		const boardTag = document.getElementById('boardTag');
		const boardValue = document.getElementById('boardValue');
		const entriesMetric = document.getElementById('entriesMetric');
		const devicesMetric = document.getElementById('devicesMetric');
		const mappedMetric = document.getElementById('mappedMetric');
		const tabRow = document.getElementById('tabRow');
		const tabTitle = document.getElementById('tabTitle');
		const summary = document.getElementById('summary');
		const searchInput = document.getElementById('searchInput');
		const toolbarBottom = document.querySelector('.toolbar-bottom');
		const emptyPanel = document.getElementById('emptyPanel');
		const emptyTitle = document.getElementById('emptyTitle');
		const emptyHint = document.getElementById('emptyHint');
		const reportPanel = document.getElementById('reportPanel');
		const tabs = Array.from(document.querySelectorAll('[data-tab]'));

		function updateState(patch) {
			currentState = { ...currentState, ...patch };
			vscode.setState(currentState);
		}

		function escapeHtml(value) {
			return String(value)
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')
				.replace(/'/g, '&#39;');
		}

		function setTag(element, valueElement, value) {
			valueElement.textContent = value || '';
			element.classList.toggle('hidden', !value);
		}

		function setMetric(element, label, value, visible) {
			element.textContent = visible ? label + ': ' + value : '';
			element.classList.toggle('hidden', !visible);
		}

		function formatBytes(bytes) {
			if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
				return '0 B';
			}

			const units = ['B', 'KB', 'MB', 'GB'];
			let value = bytes;
			let unitIndex = 0;
			while (value >= 1024 && unitIndex < units.length - 1) {
				value /= 1024;
				unitIndex += 1;
			}

			const precision = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
			return value.toFixed(precision) + ' ' + units[unitIndex];
		}

		function formatDateTime(timestamp) {
			if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
				return 'Unknown';
			}

			return new Date(timestamp).toLocaleString();
		}

		function shortRevision(value) {
			if (typeof value !== 'string' || value.length === 0) {
				return '';
			}

			return value.length > 8 ? value.slice(0, 8) : value;
		}

		function getCapacity(summaryData, candidates) {
			if (!summaryData?.memoryCapacities) {
				return undefined;
			}

			const names = candidates.map(name => name.toUpperCase());
			return summaryData.memoryCapacities.find(region => names.includes(String(region.name).toUpperCase()));
		}

		function getUsedBytes(bucketKey) {
			const bucket = currentModel?.memoryReport?.[bucketKey];
			return typeof bucket?.totalBytes === 'number' ? bucket.totalBytes : undefined;
		}

		function formatUsage(usedBytes, totalBytes) {
			const hasUsed = typeof usedBytes === 'number' && Number.isFinite(usedBytes);
			const hasTotal = typeof totalBytes === 'number' && Number.isFinite(totalBytes) && totalBytes > 0;

			if (!hasUsed && !hasTotal) {
				return undefined;
			}

			if (hasUsed && hasTotal) {
				return formatBytes(usedBytes) + ' / ' + formatBytes(totalBytes) + ' (' + ((usedBytes * 100) / totalBytes).toFixed(1) + '%)';
			}

			return hasUsed ? formatBytes(usedBytes) : formatBytes(totalBytes);
		}

		function renderStat(label, value, extraClass) {
			const hasValue = value !== undefined && value !== null && value !== '';
			const classes = ['summary-stat'];
			if (!hasValue) {
				classes.push('summary-stat-missing');
			}
			if (extraClass) {
				classes.push(extraClass);
			}

			return '<div class="' + classes.join(' ') + '">' +
				'<span class="summary-stat-label">' + escapeHtml(label) + '</span>' +
				'<span class="summary-stat-value">' + escapeHtml(hasValue ? value : 'Unknown') + '</span>' +
			'</div>';
		}

		function renderSourceStat(label, files) {
			const items = Array.isArray(files)
				? files.filter(file => file && typeof file.label === 'string' && file.label.length > 0)
				: [];
			const body = items.length > 0
				? '<div class="summary-source-list">' + items.map(file => {
					const safeLabel = escapeHtml(file.label);
					if (typeof file.path === 'string' && file.path.length > 0) {
						return '<button class="summary-source-link" type="button" data-open-file="true" data-file-path="' + escapeHtml(file.path) + '">' +
							safeLabel +
						'</button>';
					}

					return '<span class="summary-stat-value">' + safeLabel + '</span>';
				}).join('') + '</div>'
				: '<span class="summary-stat-value">None</span>';

			return '<div class="summary-stat summary-stat-sources">' +
				'<span class="summary-stat-label">' + escapeHtml(label) + '</span>' +
				body +
			'</div>';
		}

		function renderSummaryRow(title, statsHtml) {
			return '<section class="panel summary-card">' +
				'<div class="summary-card-title">' + escapeHtml(title) + '</div>' +
				'<div class="summary-card-content">' + statsHtml + '</div>' +
			'</section>';
		}

		function formatBoardValue(summaryData) {
			const target = summaryData?.target ?? {};
			const boardValue = currentModel?.boardLabel
				|| target.boardTarget
				|| [target.boardName, target.boardQualifiers].filter(Boolean).join('/');
			if (!boardValue) {
				return undefined;
			}

			if (target.boardRevision) {
				return boardValue + ' rev ' + target.boardRevision;
			}

			return boardValue;
		}

		function formatSocValue(target) {
			const parts = [target?.socPartNumber, target?.socFamily].filter(Boolean);
			return parts.length > 0 ? parts.join(' | ') : undefined;
		}

		function formatCpuValue(target) {
			const parts = [target?.cpu, target?.arch].filter(Boolean);
			return parts.length > 0 ? parts.join(' | ') : undefined;
		}

		function formatZephyrValue(target) {
			const parts = [target?.zephyrVersion, shortRevision(target?.zephyrRevision)].filter(Boolean);
			return parts.length > 0 ? parts.join(' | ') : undefined;
		}

		function formatDirtyValue(isDirty) {
			if (isDirty === true) {
				return 'Dirty';
			}
			if (isDirty === false) {
				return 'Clean';
			}
			return undefined;
		}

		function formatXipValue(enabled) {
			if (enabled === true) {
				return 'Enabled';
			}
			if (enabled === false) {
				return 'Disabled';
			}
			return undefined;
		}

		function formatArtifactValue(artifact) {
			if (!artifact?.present) {
				return 'Missing';
			}

			return typeof artifact.sizeBytes === 'number'
				? 'Present | ' + formatBytes(artifact.sizeBytes)
				: 'Present';
		}

		function renderMetrics() {
			const activeTab = getActiveTab();
			const summaryData = currentModel?.summary;
			const report = currentModel?.report;
			const romCapacity = getCapacity(summaryData, ['FLASH', 'ROM']);
			const ramCapacity = getCapacity(summaryData, ['RAM', 'SRAM']);
			const romBucket = currentModel?.memoryReport?.rom;
			const ramBucket = currentModel?.memoryReport?.ram;
			const romUsed = getUsedBytes('rom');
			const ramUsed = getUsedBytes('ram');

			if (activeTab === 'sys-init' && report) {
				setMetric(entriesMetric, 'Calls', report.totalEntries, true);
				setMetric(devicesMetric, 'Devices', report.totalDeviceEntries, true);
				setMetric(mappedMetric, 'Mapped', report.mappedDevicePaths, true);
				return;
			}

			if (activeTab === 'ram') {
				setMetric(entriesMetric, 'Used', formatBytes(ramUsed), typeof ramUsed === 'number');
				setMetric(devicesMetric, 'Capacity', formatBytes(ramCapacity?.totalBytes), typeof ramCapacity?.totalBytes === 'number');
				setMetric(mappedMetric, 'Sections', ramBucket?.sections.length ?? 0, !!ramBucket);
				return;
			}

			if (activeTab === 'rom') {
				setMetric(entriesMetric, 'Used', formatBytes(romUsed), typeof romUsed === 'number');
				setMetric(devicesMetric, 'Capacity', formatBytes(romCapacity?.totalBytes), typeof romCapacity?.totalBytes === 'number');
				setMetric(mappedMetric, 'Sections', romBucket?.sections.length ?? 0, !!romBucket);
				return;
			}

			if (activeTab === 'memory-plot') {
				const bucketKey = getPlotBucket();
				const tree = currentModel?.memoryTree?.[bucketKey];
				const capacity = bucketKey === 'rom' ? romCapacity : ramCapacity;
				setMetric(entriesMetric, bucketKey.toUpperCase() + ' Used', formatBytes(tree?.total), typeof tree?.total === 'number');
				setMetric(devicesMetric, 'Capacity', formatBytes(capacity?.totalBytes), typeof capacity?.totalBytes === 'number');
				setMetric(mappedMetric, 'Groups', tree?.root?.children?.length ?? 0, !!tree?.root);
				return;
			}

			if (activeTab === 'kconfig') {
				const kconfig = currentModel?.kconfig;
				setMetric(entriesMetric, 'Symbols', kconfig?.totalCount ?? 0, !!kconfig);
				setMetric(devicesMetric, 'Set', kconfig?.setCount ?? 0, !!kconfig);
				setMetric(mappedMetric, 'Hidden', kconfig?.hiddenCount ?? 0, !!kconfig && kconfig.source === 'trace');
				return;
			}

			if (activeTab === 'devicetree') {
				const dt = currentModel?.deviceTree;
				setMetric(entriesMetric, 'Nodes', dt?.totalNodes ?? 0, !!dt);
				setMetric(devicesMetric, 'Okay', dt?.okayCount ?? 0, !!dt);
				setMetric(mappedMetric, 'Disabled', dt?.disabledCount ?? 0, !!dt);
				return;
			}

			if (activeTab === 'elf-stats') {
				const elfStat = currentModel?.elfStat;
				setMetric(entriesMetric, 'Size', formatBytes(elfStat?.sizeBytes), typeof elfStat?.sizeBytes === 'number');
				setMetric(devicesMetric, '', '', false);
				setMetric(mappedMetric, '', '', false);
				return;
			}

			setMetric(entriesMetric, 'Bin', formatBytes(summaryData?.image?.binSizeBytes), typeof summaryData?.image?.binSizeBytes === 'number');
			setMetric(devicesMetric, 'Flash', formatBytes(romUsed), typeof romUsed === 'number');
			setMetric(mappedMetric, 'RAM', formatBytes(ramUsed), typeof ramUsed === 'number');
		}

		const TAB_LABELS = {
			'summary': 'Summary',
			'sys-init': 'Sys Init',
			'ram': 'RAM',
			'rom': 'ROM',
			'memory-plot': 'Memory Plot',
			'kconfig': 'Kconfig',
			'devicetree': 'Device Tree',
			'elf-stats': 'ELF Stats',
		};

		const SEARCH_PLACEHOLDERS = {
			'sys-init': 'Search function, symbol, device path, ordinal',
			'ram': 'Search symbol, section, address',
			'rom': 'Search symbol, section, address',
			'memory-plot': 'Search symbol, section, address',
			'kconfig': 'Search name, value, type, source, origin',
			'devicetree': 'Search node, label, compatible, status',
			'elf-stats': 'Search stat output lines',
		};

		function getActiveTab() {
			const tab = typeof currentState.activeTab === 'string' ? currentState.activeTab : 'summary';
			return Object.prototype.hasOwnProperty.call(TAB_LABELS, tab) ? tab : 'summary';
		}

		function getActiveTabLabel() {
			return TAB_LABELS[getActiveTab()] || 'Summary';
		}

		function syncTabs() {
			const activeTab = getActiveTab();
			for (const tab of tabs) {
				tab.classList.toggle('active', tab.getAttribute('data-tab') === activeTab);
			}

			tabTitle.textContent = getActiveTabLabel();
			const showSearch = isSearchableTab(activeTab);
			toolbarBottom.classList.toggle('hidden', !showSearch);
			if (showSearch) {
				searchInput.placeholder = SEARCH_PLACEHOLDERS[activeTab] || 'Search';
			} else {
				summary.textContent = '';
			}
		}

		function isSearchableTab(tab) {
			return tab === 'sys-init' || tab === 'ram' || tab === 'rom'
				|| tab === 'memory-plot' || tab === 'kconfig' || tab === 'devicetree' || tab === 'elf-stats';
		}

		function hasDataForTab(tab, model) {
			if (tab === 'sys-init') {
				return !!model?.hasReport;
			}
			if (tab === 'ram' || tab === 'rom') {
				return !!model?.hasMemoryReport;
			}
			if (tab === 'memory-plot') {
				return !!model?.hasMemoryTree;
			}
			if (tab === 'kconfig') {
				return !!model?.hasKconfig;
			}
			if (tab === 'devicetree') {
				return !!model?.hasDeviceTree;
			}
			if (tab === 'elf-stats') {
				return !!model?.elfStat;
			}
			return true;
		}

		function renderPlaceholderTab(title, body) {
			summary.textContent = '';
			reportPanel.innerHTML =
				'<section class="panel empty">' +
					'<div class="empty-title">' + escapeHtml(title) + '</div>' +
					'<div class="dim">' + escapeHtml(body) + '</div>' +
				'</section>';
		}

		function renderSummary() {
			const summaryData = currentModel?.summary;
			if (!summaryData) {
				renderPlaceholderTab('Summary', 'Build the active configuration to populate the summary.');
				return;
			}

			const target = summaryData.target ?? {};
			const toolchain = summaryData.toolchain ?? {};
			const sources = summaryData.sources ?? {};
			const image = summaryData.image ?? {};
			const romCapacity = getCapacity(summaryData, ['FLASH', 'ROM']);
			const ramCapacity = getCapacity(summaryData, ['RAM', 'SRAM']);
			const artifactStats = summaryData.artifacts.map(artifact =>
				renderStat(artifact.label, formatArtifactValue(artifact), artifact.present ? '' : 'summary-stat-missing')
			).join('');

			reportPanel.innerHTML =
				'<div class="summary-grid">' +
					renderSummaryRow('Target', [
						renderStat('App', target.applicationName || currentModel?.projectLabel),
						renderStat('Board', formatBoardValue(summaryData)),
						renderStat('SoC', formatSocValue(target)),
						renderStat('CPU', formatCpuValue(target)),
						renderStat('Zephyr', formatZephyrValue(target)),
						renderStat('Workspace', formatDirtyValue(target.workspaceDirty)),
					].join('')) +
					renderSummaryRow('Memory', [
						renderStat('Flash', formatUsage(currentModel?.memoryReport?.rom?.totalBytes, romCapacity?.totalBytes)),
						renderStat('RAM', formatUsage(currentModel?.memoryReport?.ram?.totalBytes, ramCapacity?.totalBytes)),
						renderUsageBars(summaryData, romCapacity, ramCapacity),
					].join('')) +
					renderSummaryRow('Image', [
						renderStat('Bin Size', typeof image.binSizeBytes === 'number' ? formatBytes(image.binSizeBytes) : undefined),
						renderStat('Text (Code)', typeof image.textBytes === 'number' ? formatBytes(image.textBytes) : undefined),
						renderStat('Read-Only Data', typeof image.rodataBytes === 'number' ? formatBytes(image.rodataBytes) : undefined),
						renderStat('Read/Write Data', typeof image.dataBytes === 'number' ? formatBytes(image.dataBytes) : undefined),
						renderStat('BSS (Zero Init)', typeof image.bssBytes === 'number' ? formatBytes(image.bssBytes) : undefined),
					].join('')) +
					renderSummaryRow('Toolchain', [
						renderStat('Toolchain', toolchain.variant || toolchain.name),
						renderStat('SDK', toolchain.sdkName || toolchain.sdkVersion),
						renderStat('Generator', toolchain.generator),
						renderStat('West', toolchain.westVersion),
						renderStat('XIP', formatXipValue(toolchain.xip)),
						renderStat('Built', formatDateTime(summaryData.lastBuildTimeMs)),
					].join('')) +
					renderSummaryRow('Sources', [
						renderSourceStat('Kconfig', sources.kconfigUserFiles),
						renderSourceStat('DTS', sources.dtsUserFiles),
						renderSourceStat('Kconfig Base', sources.kconfigDefaultFiles),
						renderSourceStat('DTS Base', sources.dtsDefaultFiles),
					].join('')) +
					renderSummaryRow('Artifacts', artifactStats) +
				'</div>';
		}

		// ---- Shared chart + text helpers -------------------------------------

		const MEM_CATEGORIES = ['text', 'rodata', 'data', 'bss', 'tls', 'other'];
		const chartTip = document.getElementById('chartTip');

		function catClass(category) {
			return MEM_CATEGORIES.includes(category) ? 'cat-' + category : 'cat-other';
		}

		function categorySegments(bucket) {
			const totals = {};
			for (const section of bucket?.sections || []) {
				const key = MEM_CATEGORIES.includes(section.category) ? section.category : 'other';
				totals[key] = (totals[key] || 0) + section.size;
			}
			return MEM_CATEGORIES
				.map(category => ({ category, bytes: totals[category] || 0 }))
				.filter(segment => segment.bytes > 0);
		}

		function formatPct(value) {
			if (!Number.isFinite(value)) {
				return '0%';
			}
			return (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + '%';
		}

		function tipAttrs(value, label) {
			return ' data-tip-value="' + escapeHtml(value) + '" data-tip-label="' + escapeHtml(label) + '"';
		}

		function positionTip(clientX, clientY) {
			const rect = chartTip.getBoundingClientRect();
			let x = clientX + 14;
			let y = clientY + 16;
			if (x + rect.width > window.innerWidth - 8) {
				x = clientX - rect.width - 14;
			}
			if (y + rect.height > window.innerHeight - 8) {
				y = clientY - rect.height - 16;
			}
			chartTip.style.left = Math.max(4, x) + 'px';
			chartTip.style.top = Math.max(4, y) + 'px';
		}

		function showTip(target, clientX, clientY) {
			chartTip.textContent = '';
			const valueEl = document.createElement('div');
			valueEl.className = 'chart-tip-value';
			valueEl.textContent = target.getAttribute('data-tip-value') || '';
			const labelEl = document.createElement('div');
			labelEl.className = 'chart-tip-label';
			labelEl.textContent = target.getAttribute('data-tip-label') || '';
			chartTip.appendChild(valueEl);
			chartTip.appendChild(labelEl);
			chartTip.classList.remove('hidden');
			positionTip(clientX, clientY);
		}

		function hideTip() {
			chartTip.classList.add('hidden');
		}

		function renderFilteredPre(text, query, truncated) {
			const notice = truncated
				? '<div class="tab-note">File preview truncated (only the first part is shown).</div>'
				: '';

			if (!query) {
				return notice + '<pre class="raw-text">' + escapeHtml(text) + '</pre>';
			}

			const lines = String(text).split(/\\r?\\n/);
			let matched = 0;
			const body = lines.filter(line => line.toLowerCase().includes(query)).map(line => {
				matched += 1;
				const index = line.toLowerCase().indexOf(query);
				const before = escapeHtml(line.slice(0, index));
				const hit = escapeHtml(line.slice(index, index + query.length));
				const after = escapeHtml(line.slice(index + query.length));
				return before + '<mark>' + hit + '</mark>' + after;
			}).join('\\n');

			summary.textContent = matched + ' of ' + lines.length + ' lines';
			return notice + '<pre class="raw-text">' + (body || '') + '</pre>';
		}

		// ---- Summary usage bars ---------------------------------------------

		function renderUsageBars(summaryData, romCapacity, ramCapacity) {
			const memoryReport = currentModel?.memoryReport;
			if (!memoryReport) {
				return '';
			}

			const rows = [
				renderUsageRow('FLASH', memoryReport.rom, romCapacity),
				renderUsageRow('RAM', memoryReport.ram, ramCapacity),
			].filter(Boolean);

			if (rows.length === 0) {
				return '';
			}

			const xipNote = memoryReport.xip
				? '<div class="usage-note">XIP enabled: initialized data occupies both FLASH (load) and RAM (runtime).</div>'
				: '';

			return '<div class="usage-block">' + rows.join('') + xipNote + '</div>';
		}

		function renderUsageRow(label, bucket, capacity) {
			if (!bucket || !(bucket.totalBytes > 0)) {
				return '';
			}

			const segments = categorySegments(bucket);
			const used = bucket.totalBytes;
			const capacityBytes = typeof capacity?.totalBytes === 'number' && capacity.totalBytes > 0
				? capacity.totalBytes
				: undefined;

			let denom = capacityBytes;
			let pctText;
			let over = false;
			if (!capacityBytes) {
				denom = used;
				pctText = 'capacity unknown';
			} else if (used > capacityBytes) {
				denom = used;
				over = true;
				pctText = formatPct((used * 100) / capacityBytes) + ' (over capacity)';
			} else {
				pctText = formatPct((used * 100) / capacityBytes) + ' used';
			}

			const segHtml = segments.map(segment => {
				const width = denom > 0 ? (segment.bytes * 100) / denom : 0;
				const value = capitalize(segment.category) + ': ' + formatBytes(segment.bytes);
				const labelText = capacityBytes ? formatPct((segment.bytes * 100) / capacityBytes) + ' of ' + label : formatPct((segment.bytes * 100) / used);
				return '<span class="usage-seg ' + catClass(segment.category) + '" style="width:' + width.toFixed(3) + '%"' + tipAttrs(value, labelText) + '></span>';
			}).join('');

			const legend = segments.map(segment =>
				'<span class="usage-legend-item"><span class="swatch ' + catClass(segment.category) + '"></span>' +
				capitalize(segment.category) + ' ' + escapeHtml(formatBytes(segment.bytes)) + '</span>'
			).join('');

			const freeBytes = capacityBytes ? Math.max(0, capacityBytes - used) : undefined;
			const freeLegend = freeBytes !== undefined
				? '<span class="usage-legend-item"><span class="swatch" style="background:var(--mem-free)"></span>Free ' + escapeHtml(formatBytes(freeBytes)) + '</span>'
				: '';

			return '<div class="usage-row">' +
				'<div class="usage-head"><span>' + escapeHtml(label) + '</span><span class="usage-pct' + (over ? ' usage-over' : '') + '">' + escapeHtml(pctText) + '</span></div>' +
				'<div class="usage-bar">' + segHtml + '</div>' +
				'<div class="usage-legend">' + legend + freeLegend + '</div>' +
			'</div>';
		}

		function capitalize(value) {
			return String(value).charAt(0).toUpperCase() + String(value).slice(1);
		}

		// ---- Memory plot: zoomable multi-level sunburst ---------------------
		// Grouped by source path (Zephyr base / other paths / no-paths), the same
		// way Zephyr's size_report plot is. Clicking a wedge re-roots the chart
		// with an animated angle/radius transition; the center returns one level.

		const PLOT_CX = 220;
		const PLOT_CY = 220;
		const PLOT_HOLE = 60;
		const PLOT_OUTER = 206;
		const PLOT_MAX_RINGS = 4;
		const PLOT_MIN_ARC = 0.0032; // fraction of the full circle below which an arc is dropped

		const PLOT_HUES = [210, 24, 145, 275, 340, 48, 190, 305, 95, 235, 12, 170];

		let plotModelCache = { key: '', model: null };
		let plotAnimId = 0;
		let plotRingCur = (PLOT_OUTER - PLOT_HOLE) / PLOT_MAX_RINGS;

		function getPlotBucket() {
			return currentState.plotBucket === 'rom' ? 'rom' : 'ram';
		}

		function getPlotFocusPath(bucket) {
			const focus = currentState.plotFocus;
			const value = focus && typeof focus === 'object' ? focus[bucket] : undefined;
			return typeof value === 'string' ? value : '';
		}

		function setPlotFocusPath(bucket, pathId) {
			const focus = currentState.plotFocus && typeof currentState.plotFocus === 'object' ? { ...currentState.plotFocus } : {};
			if (pathId) {
				focus[bucket] = pathId;
			} else {
				delete focus[bucket];
			}
			updateState({ plotFocus: focus });
		}

		function polar(cx, cy, r, angle) {
			return [cx + r * Math.cos(angle - Math.PI / 2), cy + r * Math.sin(angle - Math.PI / 2)];
		}

		function donutArcPath(r0, r1, a0, a1) {
			let sweep = a1 - a0;
			if (sweep > Math.PI * 2 - 0.0005) {
				sweep = Math.PI * 2 - 0.0005;
			}
			const end = a0 + sweep;
			const large = sweep > Math.PI ? 1 : 0;
			const [xa, ya] = polar(PLOT_CX, PLOT_CY, r1, a0);
			const [xb, yb] = polar(PLOT_CX, PLOT_CY, r1, end);
			const [xc, yc] = polar(PLOT_CX, PLOT_CY, r0, end);
			const [xd, yd] = polar(PLOT_CX, PLOT_CY, r0, a0);
			return 'M' + xa.toFixed(2) + ' ' + ya.toFixed(2) +
				'A' + r1.toFixed(1) + ' ' + r1.toFixed(1) + ' 0 ' + large + ' 1 ' + xb.toFixed(2) + ' ' + yb.toFixed(2) +
				'L' + xc.toFixed(2) + ' ' + yc.toFixed(2) +
				'A' + r0.toFixed(1) + ' ' + r0.toFixed(1) + ' 0 ' + large + ' 0 ' + xd.toFixed(2) + ' ' + yd.toFixed(2) + 'Z';
		}

		// Build (and cache) the flat node model with a base [0,1] partition layout
		// and per-node colors. Layout is focus-independent; focusing just rescales.
		function getPlotModel(bucketKey) {
			const tree = currentModel?.memoryTree?.[bucketKey];
			if (!tree || !tree.root) {
				return null;
			}
			const key = bucketKey + ':' + tree.total + ':' + (tree.root.children ? tree.root.children.length : 0);
			if (plotModelCache.key === key && plotModelCache.model) {
				return plotModelCache.model;
			}

			const nodes = [];
			const byPath = {};

			// Same hue for a whole top-level group (so folders read as a family).
			// Sibling index is the dominant lightness channel (its step cycle makes
			// every adjacent pair differ), with a small wrapping depth cue on top;
			// this keeps neighbors distinct without washing out at deep levels.
			const SIBLING_STEPS = [0, 12, -9, 6, -14, 18, -4, 9];
			function hslColor(hue, depth, sib) {
				const depthTerm = ((depth - 1) % 2) * 8;
				const light = Math.max(32, Math.min(80, 46 + depthTerm + SIBLING_STEPS[sib % SIBLING_STEPS.length]));
				return 'hsl(' + hue + ' 58% ' + light + '%)';
			}

			function walk(node, parent, depth, x0, x1, hue, sib) {
				const pathId = parent ? parent.pathId + '/' + node.name : node.name;
				const neutral = node.name.charAt(0) === '(';
				const rec = {
					name: node.name,
					size: node.size,
					depth,
					x0,
					x1,
					pathId,
					parent,
					hasChildren: !!(node.children && node.children.length),
					address: node.address,
					section: node.section,
					color: depth === 0 ? 'transparent' : (neutral ? 'hsl(0 0% 52%)' : hslColor(hue, depth, sib)),
				};
				nodes.push(rec);
				byPath[pathId] = rec;

				const children = node.children || [];
				const span = x1 - x0;
				const denom = node.size || 1;
				let cursor = x0;
				let idx = 0;
				for (const child of children) {
					const w = span * (child.size / denom);
					const childHue = depth === 0 ? PLOT_HUES[idx % PLOT_HUES.length] : hue;
					walk(child, rec, depth + 1, cursor, cursor + w, childHue, idx);
					cursor += w;
					idx += 1;
				}
				return rec;
			}

			const root = walk(tree.root, null, 0, 0, 1, 0, 0);
			const model = { root, nodes, byPath, total: tree.total, bucket: bucketKey };
			plotModelCache = { key, model };
			return model;
		}

		function resolveFocus(model, bucketKey) {
			const path = getPlotFocusPath(bucketKey);
			return (path && model.byPath[path]) || model.root;
		}

		// Returns how many ring levels the focused subtree actually needs (capped),
		// so ring thickness can stretch the rings out to the same outer radius no
		// matter how deep the focus is: the plot always fills the same space.
		function computeTargets(model, focus) {
			const k = focus.x1 > focus.x0 ? 1 / (focus.x1 - focus.x0) : 1;
			let ringsShown = 1;
			for (const n of model.nodes) {
				n.tx0 = Math.max(0, Math.min(1, (n.x0 - focus.x0) * k));
				n.tx1 = Math.max(0, Math.min(1, (n.x1 - focus.x0) * k));
				n.tdepth = n.depth - focus.depth;
				if (n.tx1 - n.tx0 > 0.0006 && n.tdepth >= 1 && n.tdepth <= PLOT_MAX_RINGS && n.tdepth > ringsShown) {
					ringsShown = n.tdepth;
				}
			}
			return ringsShown;
		}

		function buildPlotFrame(model, withLabels, ring) {
			const uid = { n: 0 };
			let arcs = '';
			let defs = '';
			let labels = '';
			const query = (searchInput.value || '').trim().toLowerCase();

			for (const n of model.nodes) {
				const width = n.cx1 - n.cx0;
				if (n.cdepth < 0.5 || n.cdepth > PLOT_MAX_RINGS + 0.5 || width < PLOT_MIN_ARC) {
					continue;
				}
				const r0 = PLOT_HOLE + (n.cdepth - 1) * ring;
				const r1 = r0 + ring - 1.5;
				const a0 = n.cx0 * Math.PI * 2;
				const a1 = n.cx1 * Math.PI * 2;
				const dim = query && !n.name.toLowerCase().includes(query) ? ' arc-dim' : '';
				arcs += '<path class="arc plot-arc' + dim + '" d="' + donutArcPath(r0, r1, a0, a1) + '"' +
					' style="fill:' + n.color + '" data-path="' + escapeHtml(n.pathId) + '"' +
					tipAttrs(n.name + ' (' + formatBytes(n.size) + ', ' + formatPct((n.size * 100) / model.total) + ')', n.pathId) + '></path>';

				if (withLabels) {
					const rMid = (r0 + r1) / 2;
					const lab = arcLabel(rMid, a0, a1, n.name, uid);
					if (lab) {
						defs += lab.def;
						labels += lab.label;
					}
				}
			}

			return '<defs>' + defs + '</defs>' + arcs + labels;
		}

		function arcLabel(rMid, a0, a1, rawText, uid) {
			const span = a1 - a0;
			const fontSize = Math.max(9, Math.min(14, rMid / 13));
			const maxChars = Math.floor((rMid * span) / (fontSize * 0.56));
			if (maxChars < 3) {
				return null;
			}
			let text = String(rawText);
			if (text.length > maxChars) {
				if (maxChars < 5) {
					return null;
				}
				text = text.slice(0, maxChars - 1) + '\\u2026';
			}
			const midAngle = (a0 + a1) / 2;
			const flip = midAngle > Math.PI / 2 && midAngle < Math.PI * 1.5;
			const start = polar(PLOT_CX, PLOT_CY, rMid, flip ? a1 : a0);
			const end = polar(PLOT_CX, PLOT_CY, rMid, flip ? a0 : a1);
			const large = span > Math.PI ? 1 : 0;
			const sweep = flip ? 0 : 1;
			const id = 'pl' + (uid.n++);
			const d = 'M' + start[0].toFixed(2) + ' ' + start[1].toFixed(2) +
				'A' + rMid.toFixed(1) + ' ' + rMid.toFixed(1) + ' 0 ' + large + ' ' + sweep + ' ' + end[0].toFixed(2) + ' ' + end[1].toFixed(2);
			return {
				def: '<path id="' + id + '" d="' + d + '" fill="none"></path>',
				label: '<text class="arc-label" dominant-baseline="central" style="font-size:' + fontSize.toFixed(1) + 'px">' +
					'<textPath href="#' + id + '" startOffset="50%" text-anchor="middle">' + escapeHtml(text) + '</textPath></text>',
			};
		}

		function centerMarkup(model, focus) {
			const label = focus.depth === 0 ? getPlotBucket().toUpperCase() + ' by source' : ellipsizeText(focus.name, 18);
			const up = focus.depth > 0 ? ' data-plot-up="1"' : '';
			return '<circle class="plot-hole" cx="' + PLOT_CX + '" cy="' + PLOT_CY + '" r="' + (PLOT_HOLE - 1) + '"' + up + '></circle>' +
				'<text class="plot-center-total" x="' + PLOT_CX + '" y="' + (PLOT_CY - 3) + '" text-anchor="middle">' + escapeHtml(formatBytes(focus.size)) + '</text>' +
				'<text class="plot-center-label" x="' + PLOT_CX + '" y="' + (PLOT_CY + 11) + '" text-anchor="middle">' + escapeHtml(label) + '</text>' +
				(focus.depth > 0 ? '<text class="plot-center-hint" x="' + PLOT_CX + '" y="' + (PLOT_CY + 22) + '" text-anchor="middle">click to go up</text>' : '');
		}

		function ellipsizeText(value, max) {
			const text = String(value);
			return text.length > max ? text.slice(0, max - 1) + '\\u2026' : text;
		}

		function drawPlot(model, focus, animate) {
			const svg = document.getElementById('plotSvg');
			if (!svg) {
				return;
			}
			const ringsShown = computeTargets(model, focus);
			const ringTarget = (PLOT_OUTER - PLOT_HOLE) / ringsShown;

			if (plotAnimId) {
				cancelAnimationFrame(plotAnimId);
				plotAnimId = 0;
			}

			const center = centerMarkup(model, focus);

			if (!animate) {
				for (const n of model.nodes) {
					n.cx0 = n.tx0;
					n.cx1 = n.tx1;
					n.cdepth = n.tdepth;
				}
				plotRingCur = ringTarget;
				svg.innerHTML = buildPlotFrame(model, true, ringTarget) + center;
				return;
			}

			for (const n of model.nodes) {
				n.fx0 = n.cx0 === undefined ? n.tx0 : n.cx0;
				n.fx1 = n.cx1 === undefined ? n.tx1 : n.cx1;
				n.fdepth = n.cdepth === undefined ? n.tdepth : n.cdepth;
			}
			const ringFrom = plotRingCur;
			const start = performance.now();
			const duration = 420;
			function frame(now) {
				let t = Math.min(1, (now - start) / duration);
				const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
				for (const n of model.nodes) {
					n.cx0 = n.fx0 + (n.tx0 - n.fx0) * e;
					n.cx1 = n.fx1 + (n.tx1 - n.fx1) * e;
					n.cdepth = n.fdepth + (n.tdepth - n.fdepth) * e;
				}
				const ring = ringFrom + (ringTarget - ringFrom) * e;
				plotRingCur = ring;
				svg.innerHTML = buildPlotFrame(model, t >= 1, ring) + center;
				if (t < 1) {
					plotAnimId = requestAnimationFrame(frame);
				} else {
					plotAnimId = 0;
				}
			}
			plotAnimId = requestAnimationFrame(frame);
		}

		function renderBreadcrumb(focus) {
			const chain = [];
			let node = focus;
			while (node) {
				chain.unshift(node);
				node = node.parent;
			}
			return chain.map((n, i) => {
				const label = i === 0 ? getPlotBucket().toUpperCase() : n.name;
				if (n === focus) {
					return '<span class="crumb crumb-active">' + escapeHtml(label) + '</span>';
				}
				return '<button class="crumb" type="button" data-plot-goto="' + escapeHtml(n.pathId) + '">' + escapeHtml(label) + '</button>';
			}).join('<span class="crumb-sep">\\u203a</span>');
		}

		function renderMemoryPlot() {
			const bucketKey = getPlotBucket();

			if (currentModel?.memoryError) {
				renderPlaceholderTab('Memory Plot', currentModel.memoryError);
				return;
			}

			const model = getPlotModel(bucketKey);
			if (!model) {
				renderPlaceholderTab('Memory Plot', currentModel?.hint || 'Build the active configuration to populate memory data.');
				return;
			}

			const focus = resolveFocus(model, bucketKey);
			const memoryReport = currentModel?.memoryReport;

			const bucketSwitch =
				'<div class="subtoggle-row">' +
					'<button class="subtoggle ' + (bucketKey === 'ram' ? 'active' : '') + '" type="button" data-plot-bucket="ram">RAM</button>' +
					'<button class="subtoggle ' + (bucketKey === 'rom' ? 'active' : '') + '" type="button" data-plot-bucket="rom">ROM</button>' +
				'</div>';

			const xipNote = (memoryReport && memoryReport.xip && bucketKey === 'rom')
				? '<div class="usage-note">XIP enabled: initialized data is stored in FLASH and copied to RAM at startup.</div>'
				: '';

			reportPanel.innerHTML =
				'<div class="plot-layout">' +
					'<section class="panel plot-chart">' +
						'<div id="plotCrumbs" class="plot-crumbs">' + renderBreadcrumb(focus) + '</div>' +
						'<svg id="plotSvg" class="plot-svg" viewBox="0 0 440 440" role="img" aria-label="' + bucketKey.toUpperCase() + ' memory usage by source"></svg>' +
					'</section>' +
					'<section class="panel plot-side">' +
						bucketSwitch +
						'<div id="plotDetails" class="plot-details"></div>' +
						xipNote +
						'<div class="usage-note">Click a wedge to zoom in. Click the center to go up.</div>' +
					'</section>' +
				'</div>';

			drawPlot(model, focus, false);
			showPlotDetails(model, focus);
			summary.textContent = formatBytes(model.total) + ' ' + bucketKey.toUpperCase() + ' by source path';
		}

		function focusPlot(pathId, animate) {
			const bucketKey = getPlotBucket();
			const model = getPlotModel(bucketKey);
			if (!model) {
				return;
			}
			const node = (pathId && model.byPath[pathId]) || model.root;
			setPlotFocusPath(bucketKey, node === model.root ? '' : node.pathId);
			const crumbs = document.getElementById('plotCrumbs');
			if (crumbs) {
				crumbs.innerHTML = renderBreadcrumb(node);
			}
			drawPlot(model, node, animate);
			showPlotDetails(model, node);
		}

		function showPlotDetails(model, node) {
			const host = document.getElementById('plotDetails');
			if (!host) {
				return;
			}
			const pct = model.total > 0 ? (node.size * 100) / model.total : 0;
			let extra = '';
			if (!node.hasChildren && node.address !== undefined) {
				extra =
					'<span>Section</span><b>' + escapeHtml(node.section || '') + '</b>' +
					'<span>Address</span><b><code>0x' + (node.address >>> 0).toString(16) + '</code></b>';
			} else if (node.hasChildren) {
				extra = '<span>Items</span><b>' + countChildren(model, node) + '</b>';
			}
			const action = (!node.hasChildren && node.address !== undefined)
				? '<button class="plot-action" type="button" data-reveal-symbol="true" data-symbol-name="' + escapeHtml(node.name) + '">Go to declaration</button>'
				: (node.depth > 0 ? '<button class="plot-action" type="button" data-plot-goto="' + escapeHtml(node.pathId) + '">Zoom here</button>' : '');

			host.innerHTML =
				'<div class="plot-details-name">' + escapeHtml(node.depth === 0 ? getPlotBucket().toUpperCase() + ' total' : node.name) + '</div>' +
				'<div class="plot-details-grid">' +
					'<span>Size</span><b>' + escapeHtml(formatBytes(node.size)) + '</b>' +
					'<span>Of ' + getPlotBucket().toUpperCase() + '</span><b>' + formatPct(pct) + '</b>' +
					extra +
				'</div>' + action;
		}

		function countChildren(model, node) {
			let count = 0;
			for (const n of model.nodes) {
				if (n.parent === node) {
					count += 1;
				}
			}
			return count;
		}

		// ---- Kconfig --------------------------------------------------------

		function kconfigMatches(symbol, query) {
			if (!query) {
				return true;
			}
			const fields = [symbol.name, symbol.value, symbol.type, symbol.source, symbol.locDisplay];
			return fields.some(field => field && String(field).toLowerCase().includes(query));
		}

		function kconfigSourceBadge(source) {
			if (source === 'default') {
				return '<span class="kv-badge kv-default">default</span>';
			}
			if (source === 'assign') {
				return '<span class="kv-badge kv-assign">assigned</span>';
			}
			if (source === 'select') {
				return '<span class="kv-badge kv-select">selected</span>';
			}
			if (source === 'imply') {
				return '<span class="kv-badge kv-imply">implied</span>';
			}
			return '';
		}

		function renderKconfig() {
			const kconfig = currentModel?.kconfig;
			if (!kconfig) {
				renderPlaceholderTab('Kconfig', currentModel?.kconfigError || 'Build the active configuration so .config exists.');
				return;
			}

			const query = (searchInput.value || '').trim().toLowerCase();
			const rows = [];
			let matched = 0;

			for (const symbol of kconfig.symbols) {
				if (!kconfigMatches(symbol, query)) {
					continue;
				}
				matched += 1;

				const docLink = symbol.docHref
					? '<a class="doc-link" title="Open Kconfig documentation" data-open-external="true" data-url="' + escapeHtml(symbol.docHref) + '">&#9432;</a>'
					: '';
				const hiddenTag = symbol.visible === false ? '<span class="hidden-tag">hidden</span>' : '';
				const nameCell = '<span class="kconfig-name">' + escapeHtml(symbol.name) + hiddenTag + docLink + '</span>';

				const valueCell = symbol.isSet
					? '<code>' + escapeHtml(symbol.value === undefined ? '' : symbol.value) + '</code>'
					: '<span class="dim"><em>Not set</em></span>';

				let originCell = '<span class="dim">-</span>';
				if (symbol.locPath) {
					originCell = '<button class="summary-source-link" type="button" data-open-file="true" data-file-path="' + escapeHtml(symbol.locPath) + '"' +
						(symbol.locLine ? ' data-file-line="' + symbol.locLine + '"' : '') + '>' + escapeHtml(symbol.locDisplay || symbol.locPath) + '</button>';
				} else if (symbol.locDisplay === '(implicit)') {
					originCell = '<span class="dim"><em>(implicit)</em></span>';
				} else if (symbol.locDisplay) {
					originCell = '<code>' + escapeHtml(symbol.locDisplay) + '</code>';
				}

				rows.push('<tr class="data-row' + (symbol.isSet ? '' : ' row-disabled') + '">' +
					'<td class="dim">' + escapeHtml(symbol.type || '') + '</td>' +
					'<td>' + nameCell + '</td>' +
					'<td>' + valueCell + '</td>' +
					'<td>' + kconfigSourceBadge(symbol.source) + '</td>' +
					'<td>' + originCell + '</td>' +
				'</tr>');
			}

			const note = kconfig.source === 'config'
				? '<div class="tab-note">Symbol type, source, and value origin need a newer Zephyr (its build writes .config-trace.json).</div>'
				: '';

			const configLink = kconfig.configPath
				? '<div class="tab-note">Configuration: <button class="summary-source-link" type="button" data-open-file="true" data-file-path="' + escapeHtml(kconfig.configPath) + '">' + escapeHtml(kconfig.configPath) + '</button></div>'
				: '';

			if (rows.length === 0) {
				reportPanel.innerHTML = configLink + note +
					'<section class="panel empty"><div class="empty-title">No matching symbols</div><div class="dim">Adjust the search text.</div></section>';
				summary.textContent = '0 of ' + kconfig.totalCount + ' symbols';
				return;
			}

			reportPanel.innerHTML = configLink + note +
				'<section class="panel"><div class="table-wrap"><table>' +
					'<thead><tr><th>Type</th><th>Name</th><th>Value</th><th>Source</th><th>Origin</th></tr></thead>' +
					'<tbody>' + rows.join('') + '</tbody>' +
				'</table></div></section>';

			summary.textContent = query
				? matched + ' of ' + kconfig.totalCount + ' symbols'
				: kconfig.totalCount + ' symbols';
		}

		// ---- Device tree ----------------------------------------------------

		function getDtsView() {
			return currentState.dtsView === 'raw' ? 'raw' : 'nodes';
		}

		function dtsMatches(node, query) {
			if (!query) {
				return true;
			}
			const fields = [node.path, node.name, node.compatible, node.status, (node.labels || []).join(' ')];
			return fields.some(field => field && String(field).toLowerCase().includes(query));
		}

		function statusChip(status) {
			if (status === 'disabled') {
				return '<span class="chip chip-off">disabled</span>';
			}
			if (!status || status === 'okay') {
				return '<span class="chip chip-device">okay</span>';
			}
			return '<span class="chip chip-level">' + escapeHtml(status) + '</span>';
		}

		function renderDeviceTree() {
			const deviceTree = currentModel?.deviceTree;
			if (!deviceTree) {
				renderPlaceholderTab('Device Tree', currentModel?.deviceTreeError || 'Build the active configuration so zephyr.dts exists.');
				return;
			}

			const view = getDtsView();
			const query = (searchInput.value || '').trim().toLowerCase();
			const toggle =
				'<div class="tab-note"><div class="subtoggle-row">' +
					'<button class="subtoggle ' + (view === 'nodes' ? 'active' : '') + '" type="button" data-dts-view="nodes">Nodes</button>' +
					'<button class="subtoggle ' + (view === 'raw' ? 'active' : '') + '" type="button" data-dts-view="raw">Source</button>' +
				'</div></div>';

			if (view === 'raw') {
				reportPanel.innerHTML = toggle +
					'<section class="panel">' + renderFilteredPre(deviceTree.rawText || '', query, deviceTree.rawTruncated) + '</section>';
				if (!query) {
					summary.textContent = deviceTree.totalNodes + ' nodes';
				}
				return;
			}

			const rows = [];
			let matched = 0;
			for (const node of deviceTree.nodes) {
				if (!dtsMatches(node, query)) {
					continue;
				}
				matched += 1;

				const nameHtml = query
					? '<span class="node-name" title="' + escapeHtml(node.path) + '">' + escapeHtml(node.path) + '</span>'
					: '<span class="node-name" style="--depth:' + node.depth + '" title="' + escapeHtml(node.path) + '">' + escapeHtml(node.name) + '</span>';

				const labels = (node.labels || []).length > 0
					? node.labels.map(label => '<code class="label-chip">' + escapeHtml(label) + '</code>').join('')
					: '<span class="dim">-</span>';

				const compatible = node.compatible ? '<code>' + escapeHtml(node.compatible) + '</code>' : '<span class="dim">-</span>';

				const source = node.sourcePath
					? '<button class="summary-source-link" type="button" data-open-file="true" data-file-path="' + escapeHtml(node.sourcePath) + '"' +
						(node.sourceLine ? ' data-file-line="' + node.sourceLine + '"' : '') + '>' + escapeHtml(node.sourceDisplay || '') + '</button>'
					: (node.sourceDisplay ? '<span class="dim">' + escapeHtml(node.sourceDisplay) + '</span>' : '<span class="dim">-</span>');

				rows.push('<tr class="data-row' + (node.status === 'disabled' ? ' row-disabled' : '') + '">' +
					'<td>' + nameHtml + '</td>' +
					'<td>' + labels + '</td>' +
					'<td>' + compatible + '</td>' +
					'<td>' + statusChip(node.status) + '</td>' +
					'<td>' + source + '</td>' +
				'</tr>');
			}

			if (rows.length === 0) {
				reportPanel.innerHTML = toggle +
					'<section class="panel empty"><div class="empty-title">No matching nodes</div><div class="dim">Adjust the search text.</div></section>';
				summary.textContent = '0 of ' + deviceTree.totalNodes + ' nodes';
				return;
			}

			reportPanel.innerHTML = toggle +
				'<section class="panel"><div class="table-wrap"><table>' +
					'<thead><tr><th>Node</th><th>Labels</th><th>Compatible</th><th>Status</th><th>Source</th></tr></thead>' +
					'<tbody>' + rows.join('') + '</tbody>' +
				'</table></div></section>';

			summary.textContent = query
				? matched + ' of ' + deviceTree.totalNodes + ' nodes'
				: deviceTree.totalNodes + ' nodes';
		}

		// ---- ELF stats ------------------------------------------------------

		function renderElfStats() {
			const elfStat = currentModel?.elfStat;
			if (!elfStat) {
				renderPlaceholderTab('ELF Stats', 'No zephyr.stat found: it is generated during the build.');
				return;
			}

			const query = (searchInput.value || '').trim().toLowerCase();
			const header = '<div class="tab-note">File: <button class="summary-source-link" type="button" data-open-file="true" data-file-path="' + escapeHtml(elfStat.path) + '">' + escapeHtml(elfStat.path) + '</button></div>';
			reportPanel.innerHTML = header + '<section class="panel">' + renderFilteredPre(elfStat.text || '', query, elfStat.truncated) + '</section>';
			if (!query) {
				summary.textContent = formatBytes(elfStat.sizeBytes);
			}
		}

		function entryMatches(entry, query) {
			if (!query) {
				return true;
			}

			const fields = [
				entry.level,
				String(entry.priority),
				entry.initObject,
				entry.initFunction,
				entry.argumentSymbol,
				entry.call,
				entry.addressHex,
				entry.kind,
				entry.devicePath || '',
				entry.deviceOrdinal === undefined ? '' : String(entry.deviceOrdinal),
			];

			return fields.some(field => String(field).toLowerCase().includes(query));
		}

		function renderReport() {
			const report = currentModel?.report;
			if (!report) {
				renderPlaceholderTab('Sys Init', currentModel?.hint || 'No sys-init data available for this build.');
				summary.textContent = '';
				return;
			}

			const query = (searchInput.value || '').trim().toLowerCase();
			let visibleEntries = 0;
			const openLevels = currentState.openLevels && typeof currentState.openLevels === 'object'
				? currentState.openLevels
				: {};
			let html = '';

			for (const level of report.levels) {
				const entries = level.entries.filter(entry => entryMatches(entry, query));
				if (entries.length === 0) {
					continue;
				}

				visibleEntries += entries.length;
				const rows = entries.map(entry => {
					const deviceCell = entry.deviceOrdinal === undefined
						? '<span class="dim">-</span>'
						: '<div><code>ord ' + escapeHtml(entry.deviceOrdinal) + '</code></div>' +
							(entry.devicePath ? '<div class="call-sub"><code>' + escapeHtml(entry.devicePath) + '</code></div>' : '');

					return '<tr class="data-row">' +
						'<td><code>' + escapeHtml(entry.priority) + '</code></td>' +
						'<td class="call-cell">' +
							'<div class="call-main">' +
								'<span class="chip ' + (entry.kind === 'device' ? 'chip-device' : 'chip-system') + '">' + escapeHtml(entry.kind) + '</span>' +
								'<code>' + escapeHtml(entry.initFunction) + '</code>' +
							'</div>' +
						'</td>' +
						'<td class="call-cell"><code>' + escapeHtml(entry.initObject) + '</code></td>' +
						'<td class="call-cell">' +
							(entry.argumentSymbol !== 'NULL'
								? '<code>' + escapeHtml(entry.argumentSymbol) + '</code>'
								: '<span class="dim">NULL</span>') +
						'</td>' +
						'<td class="device-cell">' + deviceCell + '</td>' +
						'<td><code>' + escapeHtml(entry.addressHex) + '</code></td>' +
					'</tr>';
				}).join('');

				const isOpen = query ? true : openLevels[level.level] !== false;
				html += '<details class="panel level-card" data-level="' + escapeHtml(level.level) + '"' + (isOpen ? ' open' : '') + '>' +
					'<summary class="level-summary">' +
						'<span class="level-heading">' +
							'<span class="level-chevron">&#9656;</span>' +
							'<span>' + escapeHtml(level.level) + '</span>' +
						'</span>' +
						'<span class="group-count">' + escapeHtml(entries.length) + ' call' + (entries.length === 1 ? '' : 's') + '</span>' +
					'</summary>' +
					'<div class="table-wrap">' +
						'<table>' +
							'<thead>' +
								'<tr>' +
									'<th>#</th>' +
									'<th>Handler</th>' +
									'<th>Init Object</th>' +
									'<th>Argument</th>' +
									'<th>Device</th>' +
									'<th>Addr</th>' +
								'</tr>' +
							'</thead>' +
							'<tbody>' + rows + '</tbody>' +
						'</table>' +
					'</div>' +
				'</details>';
			}

			if (visibleEntries === 0) {
				summary.textContent = '0 shown';
				html = '<section class="empty">' +
					'<div class="empty-title">No matching sys-init entries</div>' +
					'<div class="dim">Adjust the search text.</div>' +
				'</section>';
				reportPanel.innerHTML = html;
				return;
			}

			summary.textContent = query
				? visibleEntries + ' of ' + report.totalEntries + ' shown'
				: report.totalEntries + ' shown';
			reportPanel.innerHTML = html;
		}

		function renderMemory(bucketKey) {
			const memoryReport = currentModel?.memoryReport;
			const bucketLabel = bucketKey === 'rom' ? 'ROM' : 'RAM';

			if (currentModel?.memoryError) {
				summary.textContent = '';
				renderPlaceholderTab(bucketLabel, currentModel.memoryError);
				return;
			}

			if (!memoryReport) {
				summary.textContent = '';
				renderPlaceholderTab(bucketLabel, currentModel?.hint || 'Build the active configuration to populate memory data.');
				return;
			}

			const bucket = memoryReport[bucketKey];
			if (!bucket || bucket.sections.length === 0) {
				summary.textContent = '';
				renderPlaceholderTab(bucketLabel, 'No ' + bucketLabel + ' sections found in the ELF.');
				return;
			}

			const query = (searchInput.value || '').trim().toLowerCase();
			const openSections = (currentState.openMemorySections && currentState.openMemorySections[bucketKey]) || {};
			let visibleSymbols = 0;
			let totalSymbols = 0;
			let html = '';

			for (const section of bucket.sections) {
				totalSymbols += section.symbols.length;

				const sectionMatches = !query
					|| section.name.toLowerCase().includes(query)
					|| String(section.category).toLowerCase().includes(query);

				const filteredSymbols = sectionMatches
					? section.symbols
					: section.symbols.filter(sym =>
						sym.name.toLowerCase().includes(query)
						|| sym.sectionName.toLowerCase().includes(query)
						|| sym.addressHex.toLowerCase().includes(query)
					);

				if (!sectionMatches && filteredSymbols.length === 0) {
					continue;
				}

				visibleSymbols += filteredSymbols.length;

				const percent = bucket.totalBytes > 0 ? (section.size * 100 / bucket.totalBytes) : 0;
				const unknownBytes = Math.max(0, section.size - section.symbolsBytes);

				const rows = filteredSymbols.map(sym => {
					const symPercent = section.size > 0 ? (sym.size * 100 / section.size) : 0;
					const safeName = escapeHtml(sym.name);
					return '<tr class="data-row">' +
						'<td class="call-cell">' +
							'<div class="call-main"><button class="symbol-link" type="button" data-reveal-symbol="true" data-symbol-name="' + safeName + '" title="Go to declaration">' + safeName + '</button></div>' +
							(sym.sectionName !== section.name ? '<div class="call-sub"><code>' + escapeHtml(sym.sectionName) + '</code></div>' : '') +
						'</td>' +
						'<td><code>' + escapeHtml(sym.addressHex) + '</code></td>' +
						'<td>' + escapeHtml(formatBytes(sym.size)) + '</td>' +
						'<td class="dim">' + symPercent.toFixed(2) + '%</td>' +
					'</tr>';
				}).join('');

				const unknownRow = (unknownBytes > 0 && !query)
					? '<tr class="data-row">' +
						'<td class="call-cell dim"><em>(unattributed / padding)</em></td>' +
						'<td class="dim">-</td>' +
						'<td>' + escapeHtml(formatBytes(unknownBytes)) + '</td>' +
						'<td class="dim">' + (section.size > 0 ? (unknownBytes * 100 / section.size).toFixed(2) : '0.00') + '%</td>' +
					'</tr>'
					: '';

				const isOpen = query ? true : openSections[section.name] !== false;
				html += '<details class="panel level-card" data-memory-bucket="' + escapeHtml(bucketKey) + '" data-memory-section="' + escapeHtml(section.name) + '"' + (isOpen ? ' open' : '') + '>' +
					'<summary class="level-summary">' +
						'<span class="level-heading">' +
							'<span class="level-chevron">&#9656;</span>' +
							'<span><code>' + escapeHtml(section.name) + '</code></span>' +
							'<span class="chip chip-level">' + escapeHtml(section.category) + '</span>' +
						'</span>' +
						'<span class="group-count">' +
							escapeHtml(formatBytes(section.size)) + ' &middot; ' + percent.toFixed(1) + '% &middot; ' +
							(query ? filteredSymbols.length + '/' + section.symbols.length : section.symbols.length) + ' sym' +
						'</span>' +
					'</summary>' +
					'<div class="table-wrap">' +
						'<table>' +
							'<thead><tr><th>Symbol</th><th>Addr</th><th>Size</th><th>%</th></tr></thead>' +
							'<tbody>' + rows + unknownRow + '</tbody>' +
						'</table>' +
					'</div>' +
				'</details>';
			}

			if (html === '') {
				reportPanel.innerHTML = '<section class="panel empty">' +
					'<div class="empty-title">No matching symbols</div>' +
					'<div class="dim">Adjust the search text.</div>' +
				'</section>';
				summary.textContent = '0 shown';
				return;
			}

			summary.textContent = query
				? visibleSymbols + ' of ' + totalSymbols + ' symbols \u00b7 ' + formatBytes(bucket.totalBytes)
				: totalSymbols + ' symbols \u00b7 ' + formatBytes(bucket.totalBytes);
			reportPanel.innerHTML = html;
		}

		function renderActiveTab() {
			const activeTab = getActiveTab();

			if (activeTab === 'sys-init') {
				renderReport();
				return;
			}

			if (activeTab === 'summary') {
				renderSummary();
				return;
			}

			if (activeTab === 'ram' || activeTab === 'rom') {
				renderMemory(activeTab);
				return;
			}

			if (activeTab === 'memory-plot') {
				renderMemoryPlot();
				return;
			}

			if (activeTab === 'kconfig') {
				renderKconfig();
				return;
			}

			if (activeTab === 'devicetree') {
				renderDeviceTree();
				return;
			}

			if (activeTab === 'elf-stats') {
				renderElfStats();
				return;
			}

			renderPlaceholderTab(getActiveTabLabel(), '');
		}

		function renderModel(model) {
			currentModel = model;
			plotModelCache = { key: '', model: null };
			if (plotAnimId) {
				cancelAnimationFrame(plotAnimId);
				plotAnimId = 0;
			}
			hideTip();
			setTag(projectTag, projectValue, model.projectLabel);
			setTag(configTag, configValue, model.configLabel);
			setTag(boardTag, boardValue, model.boardLabel);

			syncTabs();
			renderMetrics();
			const activeTab = getActiveTab();
			searchInput.disabled = !isSearchableTab(activeTab) || !hasDataForTab(activeTab, model);

			emptyPanel.classList.toggle('hidden', model.hasContent);
			reportPanel.classList.toggle('hidden', !model.hasContent);

			if (!model.hasContent) {
				summary.textContent = '';
				emptyTitle.textContent = model.message || 'No data';
				emptyHint.textContent = model.hint || '';
				reportPanel.innerHTML = '';
				return;
			}

			const savedSearch = typeof currentState.searchText === 'string' ? currentState.searchText : '';
			if (searchInput.value !== savedSearch) {
				searchInput.value = savedSearch;
			}

			renderActiveTab();
		}

		let searchTimer;
		searchInput.addEventListener('input', () => {
			updateState({ searchText: searchInput.value });
			clearTimeout(searchTimer);
			searchTimer = setTimeout(renderActiveTab, 70);
		});

		tabRow.addEventListener('click', (event) => {
			const target = event.target;
			if (!target || !target.matches('[data-tab]')) {
				return;
			}

			const activeTab = target.getAttribute('data-tab');
			if (!activeTab || activeTab === getActiveTab()) {
				return;
			}

			updateState({ activeTab });
			syncTabs();
			renderMetrics();

			if (currentModel?.hasContent) {
				const nextTab = getActiveTab();
				searchInput.disabled = !isSearchableTab(nextTab) || !hasDataForTab(nextTab, currentModel);
				renderActiveTab();
			}
		});

		reportPanel.addEventListener('click', (event) => {
			const target = event.target;
			if (!target || typeof target.closest !== 'function') {
				return;
			}

			const symbolTrigger = target.closest('[data-reveal-symbol="true"]');
			if (symbolTrigger) {
				const symbolName = symbolTrigger.getAttribute('data-symbol-name');
				if (symbolName) {
					vscode.postMessage({ command: 'revealSymbol', name: symbolName });
				}
				return;
			}

			const bucketBtn = target.closest('[data-plot-bucket]');
			if (bucketBtn) {
				const nextBucket = bucketBtn.getAttribute('data-plot-bucket');
				if (nextBucket && nextBucket !== getPlotBucket()) {
					updateState({ plotBucket: nextBucket });
					renderMetrics();
					renderMemoryPlot();
				}
				return;
			}

			const gotoBtn = target.closest('[data-plot-goto]');
			if (gotoBtn) {
				focusPlot(gotoBtn.getAttribute('data-plot-goto') || '', true);
				return;
			}

			const upHole = target.closest('[data-plot-up]');
			if (upHole) {
				const model = getPlotModel(getPlotBucket());
				const focus = model ? resolveFocus(model, getPlotBucket()) : null;
				focusPlot(focus && focus.parent ? focus.parent.pathId : '', true);
				return;
			}

			const arc = target.closest('[data-path]');
			if (arc) {
				const model = getPlotModel(getPlotBucket());
				const node = model ? model.byPath[arc.getAttribute('data-path')] : undefined;
				if (node) {
					if (node.hasChildren) {
						focusPlot(node.pathId, true);
					} else if (model) {
						showPlotDetails(model, node);
					}
				}
				return;
			}

			const dtsBtn = target.closest('[data-dts-view]');
			if (dtsBtn) {
				const view = dtsBtn.getAttribute('data-dts-view');
				if (view && view !== getDtsView()) {
					updateState({ dtsView: view });
					renderDeviceTree();
				}
				return;
			}

			const extTrigger = target.closest('[data-open-external="true"]');
			if (extTrigger) {
				const url = extTrigger.getAttribute('data-url');
				if (url) {
					vscode.postMessage({ command: 'openExternal', url: url });
				}
				return;
			}

			const trigger = target.closest('[data-open-file="true"]');
			if (!trigger) {
				return;
			}

			const filePath = trigger.getAttribute('data-file-path');
			if (!filePath) {
				return;
			}

			const lineAttr = trigger.getAttribute('data-file-line');
			const line = lineAttr ? Number(lineAttr) : undefined;
			vscode.postMessage({ command: 'openFile', path: filePath, line: line });
		});

		reportPanel.addEventListener('pointermove', (event) => {
			const target = event.target && typeof event.target.closest === 'function'
				? event.target.closest('[data-tip-value]')
				: null;
			if (!target) {
				hideTip();
				return;
			}
			showTip(target, event.clientX, event.clientY);

			// Hovering a wedge previews its details in the side panel.
			const arc = target.closest ? target.closest('[data-path]') : null;
			if (arc && getActiveTab() === 'memory-plot') {
				const model = getPlotModel(getPlotBucket());
				const node = model ? model.byPath[arc.getAttribute('data-path')] : undefined;
				if (model && node) {
					showPlotDetails(model, node);
				}
			}
		});

		reportPanel.addEventListener('pointerleave', hideTip);

		reportPanel.addEventListener('toggle', (event) => {
			const target = event.target;
			if (!target || target.tagName !== 'DETAILS') {
				return;
			}

			const level = target.getAttribute('data-level');
			if (level) {
				const openLevels = currentState.openLevels && typeof currentState.openLevels === 'object'
					? { ...currentState.openLevels }
					: {};
				openLevels[level] = target.hasAttribute('open');
				updateState({ openLevels });
				return;
			}

			const memoryBucket = target.getAttribute('data-memory-bucket');
			const memorySection = target.getAttribute('data-memory-section');
			if (memoryBucket && memorySection) {
				const openMemorySections = currentState.openMemorySections && typeof currentState.openMemorySections === 'object'
					? { ...currentState.openMemorySections }
					: {};
				const bucketMap = openMemorySections[memoryBucket] && typeof openMemorySections[memoryBucket] === 'object'
					? { ...openMemorySections[memoryBucket] }
					: {};
				bucketMap[memorySection] = target.hasAttribute('open');
				openMemorySections[memoryBucket] = bucketMap;
				updateState({ openMemorySections });
			}
		}, true);

		window.addEventListener('message', (event) => {
			const message = event.data;
			if (message.command === 'model') {
				renderModel(message.model);
			}
		});

		vscode.postMessage({ command: 'ready', state: currentState });
	</script>
</body>
</html>`;
	}
}
