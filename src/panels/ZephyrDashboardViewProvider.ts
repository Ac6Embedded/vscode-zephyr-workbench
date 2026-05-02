import * as vscode from 'vscode';
import { ZephyrApplication } from '../models/ZephyrApplication';
import { ZephyrBuildConfig } from '../models/ZephyrBuildConfig';
import { getNonce } from '../utilities/getNonce';
import { readZephyrBuildSummary, type ZephyrBuildSummary } from '../utils/zephyr/buildSummaryParser';
import { readZephyrMemoryReport, type ZephyrMemoryReport } from '../utils/zephyr/memoryReportParser';
import { readZephyrSysInitReport, type ZephyrSysInitReport } from '../utils/zephyr/sysInitParser';

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
	error?: string;
}

interface DashboardViewModel {
	hasProjects: boolean;
	hasContent: boolean;
	hasReport: boolean;
	hasMemoryReport: boolean;
	projectLabel: string;
	configLabel: string;
	boardLabel: string;
	buildDir: string;
	elfPath: string;
	message: string;
	hint: string;
	summary?: ZephyrBuildSummary;
	report?: ZephyrSysInitReport;
	memoryReport?: ZephyrMemoryReport;
	memoryError?: string;
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
				await this._openFile(message?.path);
				break;
			default:
				break;
		}
	}

	private async _openFile(filePath: unknown): Promise<void> {
		if (typeof filePath !== 'string' || filePath.length === 0) {
			return;
		}

		try {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
			await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
		} catch {
			void vscode.window.showWarningMessage(`Unable to open file: ${filePath}`);
		}
	}

	private _setTargetFromNode(node?: unknown): void {
		if (!node) {
			return;
		}

		let projectPath: string | undefined;

		if ((node as any)?.project?.appWorkspaceFolder?.uri?.fsPath) {
			projectPath = (node as any).project.appWorkspaceFolder.uri.fsPath;
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
		const folders = await ZephyrApplication.getApplicationWorkspaceFolders(vscode.workspace.workspaceFolders ?? []);
		const projects: ZephyrApplication[] = [];

		for (const folder of folders) {
			try {
				projects.push(new ZephyrApplication(folder, folder.uri.fsPath));
			} catch {
				// Skip malformed project state instead of breaking the view.
			}
		}

		return projects;
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

		if (!elfPath) {
			return {
				projects,
				selectedProject,
				selectedConfig,
				buildDir,
				summary,
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

			const activeProject = projects.find(project => project.appWorkspaceFolder.uri.fsPath === activeEditorFolder.uri.fsPath);
			if (activeProject) {
				return activeProject;
			}

			return undefined;
		}

		if (this._revealedProjectPath) {
			const revealedProject = projects.find(project => project.appWorkspaceFolder.uri.fsPath === this._revealedProjectPath);
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
			hasContent: !!target.summary || !!target.report || !!target.memoryReport,
			hasReport: !!target.report,
			hasMemoryReport: !!target.memoryReport,
			projectLabel: target.selectedProject?.appName ?? '',
			configLabel: target.selectedConfig?.name ?? '',
			boardLabel: target.selectedConfig?.boardIdentifier ?? '',
			buildDir: target.buildDir ?? '',
			elfPath: target.elfPath ?? '',
			message,
			hint,
			summary: target.summary,
			report: target.report,
			memoryReport: target.memoryReport,
			memoryError: target.memoryError,
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

		@media (max-width: 800px) {
			.toolbar-info-row,
			.toolbar-bottom {
				grid-template-columns: 1fr;
			}

			.summary-card {
				grid-template-columns: 1fr;
				gap: 8px;
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

			setMetric(entriesMetric, 'Bin', formatBytes(summaryData?.image?.binSizeBytes), typeof summaryData?.image?.binSizeBytes === 'number');
			setMetric(devicesMetric, 'Flash', formatBytes(romUsed), typeof romUsed === 'number');
			setMetric(mappedMetric, 'RAM', formatBytes(ramUsed), typeof ramUsed === 'number');
		}

		function getActiveTab() {
			const tab = typeof currentState.activeTab === 'string' ? currentState.activeTab : 'summary';
			return ['summary', 'sys-init', 'ram', 'rom'].includes(tab) ? tab : 'summary';
		}

		function getActiveTabLabel() {
			switch (getActiveTab()) {
				case 'sys-init':
					return 'Sys Init';
				case 'ram':
					return 'RAM';
				case 'rom':
					return 'ROM';
				default:
					return 'Summary';
			}
		}

		function syncTabs() {
			const activeTab = getActiveTab();
			for (const tab of tabs) {
				tab.classList.toggle('active', tab.getAttribute('data-tab') === activeTab);
			}

			tabTitle.textContent = getActiveTabLabel();
			const showSearch = activeTab === 'sys-init' || activeTab === 'ram' || activeTab === 'rom';
			toolbarBottom.classList.toggle('hidden', !showSearch);
			if (!showSearch) {
				summary.textContent = '';
			}
		}

		function isSearchableTab(tab) {
			return tab === 'sys-init' || tab === 'ram' || tab === 'rom';
		}

		function hasDataForTab(tab, model) {
			if (tab === 'sys-init') {
				return !!model?.hasReport;
			}
			if (tab === 'ram' || tab === 'rom') {
				return !!model?.hasMemoryReport;
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
					return '<tr class="data-row">' +
						'<td class="call-cell">' +
							'<div class="call-main"><code>' + escapeHtml(sym.name) + '</code></div>' +
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

			renderPlaceholderTab(getActiveTabLabel(), '');
		}

		function renderModel(model) {
			currentModel = model;
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

		searchInput.addEventListener('input', () => {
			updateState({ searchText: searchInput.value });
			renderActiveTab();
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

			const trigger = target.closest('[data-open-file="true"]');
			if (!trigger) {
				return;
			}

			const filePath = trigger.getAttribute('data-file-path');
			if (!filePath) {
				return;
			}

			vscode.postMessage({ command: 'openFile', path: filePath });
		});

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
