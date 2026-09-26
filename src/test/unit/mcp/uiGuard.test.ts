import { strict as assert } from 'assert';
import * as vscode from 'vscode';
import { installUiGuard } from './uiGuard';

describe('test helper: uiGuard', () => {
  it('records and refuses every UI call, even one a handler would swallow', () => {
    const guard = installUiGuard();
    try {
      assert.throws(() => vscode.window.showWarningMessage('Delete it?'), /cannot answer/);
      try {
        void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification }, async () => undefined);
      } catch {
        // Swallowed on purpose: the record must still show it.
      }
      assert.deepEqual(guard.calls.map(call => call.split(':')[0]), ['showWarningMessage', 'withProgress']);
    } finally {
      guard.restore();
    }
    // The stub is back: its own withProgress runs the task.
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification }, async () => 'ran')
      .then(value => assert.equal(value, 'ran'));
  });
});
