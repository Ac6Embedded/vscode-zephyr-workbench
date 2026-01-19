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
	joinPath: (...parts) => ({ fsPath: parts.filter(Boolean).map(String).join('/') }),
};

module.exports = {
	window,
	env,
	workspace,
	Uri,
	ProgressLocation: { Notification: 0 },
};
