// Minimal stub for unit tests (Node environment).
// VS Code provides the real 'vscode' module at runtime; unit tests only need imports to resolve.

function createOutputChannel() {
	return {
		name: 'stub',
		append() {},
		appendLine() {},
		clear() {},
		show() {},
		hide() {},
		dispose() {},
	};
}

const window = {
	createOutputChannel,
	showInformationMessage: async () => undefined,
	showErrorMessage: async () => undefined,
	withProgress: async (_opts, task) => task({ report() {} }, { isCancellationRequested: false }),
};

const env = {
	shell: undefined,
};

const workspace = {
	getConfiguration: () => ({ get: () => undefined, update: async () => undefined }),
	workspaceFolders: undefined,
	getWorkspaceFolder: () => undefined,
};

const Uri = {
	file: (fsPath) => ({ fsPath }),
	joinPath: (base, ...parts) => ({
		fsPath: [base && base.fsPath !== undefined ? base.fsPath : String(base), ...parts.map(String)].join('/'),
	}),
};

// No other extension is installed, so get_status can run against the stub.
const extensions = {
	getExtension: () => undefined,
};

module.exports = {
	window,
	env,
	workspace,
	extensions,
	version: '0.0.0-stub',
	Uri,
	ProgressLocation: { Notification: 0 },
};

// Settings writers pass a target to update(); the values match VS Code's enum.
module.exports.ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

// `import * as vscode` copies the keys that exist when a module loads, so the
// task API is declared here for tests to replace, not added by them later.
module.exports.tasks = {
	taskExecutions: [],
	executeTask: async () => undefined,
	onDidStartTask: () => ({ dispose() {} }),
	onDidEndTask: () => ({ dispose() {} }),
	onDidEndTaskProcess: () => ({ dispose() {} }),
};
module.exports.TaskGroup = { Build: { id: 'build' } };

// Just enough of the task value types to build a task and read it back. The
// enum values match VS Code's.
class ShellExecution {
	constructor(commandLine, options) {
		this.commandLine = commandLine;
		this.options = options;
	}
}
class Task {
	constructor(definition, scope, name, source, execution, problemMatchers) {
		this.definition = definition;
		this.scope = scope;
		this.name = name;
		this.source = source;
		this.execution = execution;
		this.problemMatchers = problemMatchers === undefined ? [] : [].concat(problemMatchers);
		this.presentationOptions = {};
	}
}
module.exports.ShellExecution = ShellExecution;
module.exports.Task = Task;
module.exports.TaskScope = { Global: 1, Workspace: 2 };
module.exports.TaskRevealKind = { Always: 1, Silent: 2, Never: 3 };
module.exports.TaskPanelKind = { Shared: 1, Dedicated: 2, New: 3 };
