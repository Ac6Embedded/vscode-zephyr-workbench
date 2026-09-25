// Proves an MCP handler shows no UI. An agent's call must never wait on a
// notification, a picker or a progress toast only a person can dismiss; the
// confirmation dialog is the one exception, and handler tests inject its
// `ask`, so it never reaches vscode.window.

const stub = require('vscode') as { window: Record<string, unknown> };

const GUARDED = [
  'showInformationMessage', 'showWarningMessage', 'showErrorMessage',
  'showQuickPick', 'showInputBox', 'showOpenDialog', 'showSaveDialog', 'withProgress',
] as const;

export interface UiGuard {
  /** Every guarded call made since the guard was installed, as "name: first argument". */
  readonly calls: string[];
  /** Put the stub back as it was. */
  restore(): void;
}

/**
 * Make every UI entry point of the vscode stub record the call and throw. The
 * record matters as much as the throw: a handler may catch the error and carry
 * on, and the test must still fail.
 */
export function installUiGuard(): UiGuard {
  const calls: string[] = [];
  const saved = new Map<string, unknown>();
  for (const name of GUARDED) {
    saved.set(name, stub.window[name]);
    stub.window[name] = (...args: unknown[]) => {
      const first = typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0] ?? '');
      calls.push(`${name}: ${String(first).slice(0, 160)}`);
      throw new Error(`An MCP handler called vscode.window.${name}, which an agent cannot answer.`);
    };
  }
  return {
    calls,
    restore: () => {
      for (const [name, value] of saved) {
        if (value === undefined) {
          delete stub.window[name];
        } else {
          stub.window[name] = value;
        }
      }
    },
  };
}

/**
 * Install the guard around every test of the enclosing describe block, and
 * fail any test during which a handler reached for UI.
 */
export function useUiGuard(): void {
  let guard: UiGuard | undefined;
  beforeEach(() => { guard = installUiGuard(); });
  afterEach(function () {
    const calls = guard?.calls ?? [];
    guard?.restore();
    guard = undefined;
    // Reported as a failure of this hook, naming the test that showed UI.
    if (calls.length > 0 && this.currentTest?.state !== 'failed') {
      throw new Error(`"${this.currentTest?.title}" showed UI an agent cannot answer:\n${calls.join('\n')}`);
    }
  });
}
