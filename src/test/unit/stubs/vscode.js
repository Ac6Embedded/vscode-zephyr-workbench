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

// The debug API, declared for tests to replace like the task API above.
const noDispose = () => ({ dispose() {} });
module.exports.debug = {
	activeDebugSession: undefined,
	activeDebugConsole: { append() {}, appendLine() {} },
	breakpoints: [],
	startDebugging: async () => false,
	stopDebugging: async () => undefined,
	addBreakpoints: () => undefined,
	removeBreakpoints: () => undefined,
	registerDebugAdapterTrackerFactory: noDispose,
	registerDebugConfigurationProvider: noDispose,
	onDidStartDebugSession: noDispose,
	onDidTerminateDebugSession: noDispose,
	onDidChangeActiveDebugSession: noDispose,
	onDidChangeBreakpoints: noDispose,
	onDidReceiveDebugSessionCustomEvent: noDispose,
};
module.exports.commands = {
	executeCommand: async () => undefined,
	registerCommand: noDispose,
	getCommands: async () => [],
};

// Just enough of the breakpoint and location value types to build one and
// read it back.
class Position {
	constructor(line, character) {
		this.line = line;
		this.character = character;
	}
}
class Range {
	constructor(startOrLine, endOrCharacter, endLine, endCharacter) {
		if (typeof startOrLine === 'number') {
			this.start = new Position(startOrLine, endOrCharacter);
			this.end = new Position(endLine, endCharacter);
		} else {
			this.start = startOrLine;
			this.end = endOrCharacter;
		}
	}
}
class Location {
	constructor(uri, rangeOrPosition) {
		this.uri = uri;
		this.range = rangeOrPosition instanceof Position ? new Range(rangeOrPosition, rangeOrPosition) : rangeOrPosition;
	}
}
let breakpointCounter = 0;
class Breakpoint {
	constructor(enabled, condition, hitCondition, logMessage) {
		breakpointCounter += 1;
		this.id = `stub-bp-${breakpointCounter}`;
		this.enabled = enabled === undefined ? true : enabled;
		this.condition = condition;
		this.hitCondition = hitCondition;
		this.logMessage = logMessage;
	}
}
class SourceBreakpoint extends Breakpoint {
	constructor(location, enabled, condition, hitCondition, logMessage) {
		super(enabled, condition, hitCondition, logMessage);
		this.location = location;
	}
}
class FunctionBreakpoint extends Breakpoint {
	constructor(functionName, enabled, condition, hitCondition, logMessage) {
		super(enabled, condition, hitCondition, logMessage);
		this.functionName = functionName;
	}
}
class EventEmitter {
	constructor() {
		this.listeners = new Set();
		this.event = listener => {
			this.listeners.add(listener);
			return { dispose: () => this.listeners.delete(listener) };
		};
	}
	fire(value) {
		for (const listener of [...this.listeners]) {
			listener(value);
		}
	}
	dispose() {
		this.listeners.clear();
	}
}
module.exports.Position = Position;
module.exports.Range = Range;
module.exports.Location = Location;
module.exports.Breakpoint = Breakpoint;
module.exports.SourceBreakpoint = SourceBreakpoint;
module.exports.FunctionBreakpoint = FunctionBreakpoint;
module.exports.EventEmitter = EventEmitter;
