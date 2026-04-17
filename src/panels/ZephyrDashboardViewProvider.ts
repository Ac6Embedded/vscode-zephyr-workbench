import * as vscode from 'vscode';
import { ZephyrAppProject } from '../models/ZephyrAppProject';
import { ZephyrProjectBuildConfiguration } from '../models/ZephyrProjectBuildConfiguration';
import { getNonce } from '../utilities/getNonce';
import { readZephyrSysInitReport, type ZephyrSysInitReport } from '../utils/zephyr/sysInitParser';

interface DashboardTarget {
	projects: ZephyrAppProject[];
	selectedProject?: ZephyrAppProject;
	selectedConfig?: ZephyrProjectBuildConfiguration;
	buildDir?: string;
	elfPath?: string;
	report?: ZephyrSysInitReport;
	error?: string;
}

interface DashboardViewModel {
	hasProjects: boolean;
	hasReport: boolean;
	projectLabel: string;
	configLabel: string;
	boardLabel: string;
	buildDir: string;
	elfPath: string;
	message: string;
	hint: string;
	report?: ZephyrSysInitReport;
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
			default:
				break;
		}
	}

	private _setTargetFromNode(node?: unknown): void {
		if (!node) {
			return;
		}

		let projectPath: string | undefined;

		if ((node as any)?.project?.workspaceFolder?.uri?.fsPath) {
			projectPath = (node as any).project.workspaceFolder.uri.fsPath;
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

	private async _getProjects(): Promise<ZephyrAppProject[]> {
		const folders = await ZephyrAppProject.getZephyrProjectWorkspaceFolders(vscode.workspace.workspaceFolders ?? []);
		const projects: ZephyrAppProject[] = [];

		for (const folder of folders) {
			try {
				projects.push(new ZephyrAppProject(folder, folder.uri.fsPath));
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
		const devicetreeHeaderPath = selectedConfig.getBuildArtifactPath(
			selectedProject,
			'zephyr',
			'include',
			'generated',
			'zephyr',
			'devicetree_generated.h',
		);

		if (!elfPath) {
			return {
				projects,
				selectedProject,
				selectedConfig,
				buildDir,
				error: 'No zephyr.elf was found for the selected build configuration.',
			};
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
				report,
			};
		} catch (error) {
			return {
				projects,
				selectedProject,
				selectedConfig,
				buildDir,
				elfPath,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private _selectProject(projects: ZephyrAppProject[]): ZephyrAppProject | undefined {
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

			const activeProject = projects.find(project => project.workspaceFolder.uri.fsPath === activeEditorFolder.uri.fsPath);
			if (activeProject) {
				return activeProject;
			}

			return undefined;
		}

		if (this._revealedProjectPath) {
			const revealedProject = projects.find(project => project.workspaceFolder.uri.fsPath === this._revealedProjectPath);
			if (revealedProject) {
				return revealedProject;
			}
			this._revealedProjectPath = undefined;
		}

		return undefined;
	}

	private _selectConfig(project?: ZephyrAppProject): ZephyrProjectBuildConfiguration | undefined {
		if (!project || project.configs.length === 0) {
			return undefined;
		}

		return project.configs.find(config => config.active) ?? project.configs[0];
	}

	private _getDescription(target: DashboardTarget): string | undefined {
		if (!target.selectedProject) {
			return undefined;
		}

		if (!target.selectedConfig) {
			return target.selectedProject.folderName;
		}

		return `${target.selectedProject.folderName} / ${target.selectedConfig.name}`;
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
			hasReport: !!target.report,
			projectLabel: target.selectedProject?.folderName ?? '',
			configLabel: target.selectedConfig?.name ?? '',
			boardLabel: target.selectedConfig?.boardIdentifier ?? '',
			buildDir: target.buildDir ?? '',
			elfPath: target.elfPath ?? '',
			message,
			hint,
			report: target.report,
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
	<title>Zephyr Dashboard</title>
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
			const showSearch = activeTab === 'sys-init';
			toolbarBottom.classList.toggle('hidden', !showSearch);
			if (!showSearch) {
				summary.textContent = '';
			}
		}

		function renderPlaceholderTab(title, body) {
			summary.textContent = '';
			reportPanel.innerHTML =
				'<section class="panel empty">' +
					'<div class="empty-title">' + escapeHtml(title) + '</div>' +
					'<div class="dim">' + escapeHtml(body) + '</div>' +
				'</section>';
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
				reportPanel.innerHTML = '';
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

		function renderActiveTab() {
			const activeTab = getActiveTab();

			if (activeTab === 'sys-init') {
				renderReport();
				return;
			}

			if (activeTab === 'summary') {
				renderPlaceholderTab('Summary', 'Summary widgets will be added here.');
				return;
			}

			if (activeTab === 'ram') {
				renderPlaceholderTab('RAM', 'RAM analysis will be added here.');
				return;
			}

			renderPlaceholderTab('ROM', 'ROM analysis will be added here.');
		}

		function renderModel(model) {
			currentModel = model;
			setTag(projectTag, projectValue, model.projectLabel);
			setTag(configTag, configValue, model.configLabel);
			setTag(boardTag, boardValue, model.boardLabel);

			const hasReport = !!model.hasReport && !!model.report;
			setMetric(entriesMetric, 'Calls', model.report ? model.report.totalEntries : 0, hasReport);
			setMetric(devicesMetric, 'Devices', model.report ? model.report.totalDeviceEntries : 0, hasReport);
			setMetric(mappedMetric, 'Mapped', model.report ? model.report.mappedDevicePaths : 0, hasReport);

			syncTabs();
			searchInput.disabled = !hasReport || getActiveTab() !== 'sys-init';

			emptyPanel.classList.toggle('hidden', hasReport);
			reportPanel.classList.toggle('hidden', !hasReport);

			if (!hasReport) {
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
			renderReport();
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

			if (currentModel?.hasReport && currentModel?.report) {
				searchInput.disabled = getActiveTab() !== 'sys-init';
				renderActiveTab();
			}
		});

		reportPanel.addEventListener('toggle', (event) => {
			const target = event.target;
			if (!target || target.tagName !== 'DETAILS') {
				return;
			}

			const level = target.getAttribute('data-level');
			if (!level) {
				return;
			}

			const openLevels = currentState.openLevels && typeof currentState.openLevels === 'object'
				? { ...currentState.openLevels }
				: {};
			openLevels[level] = target.hasAttribute('open');
			updateState({ openLevels });
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
