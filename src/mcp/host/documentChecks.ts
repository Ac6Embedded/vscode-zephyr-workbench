// Which open documents changed since a checker, such as a language server,
// last reported on them. When the agent rewrites a file open in VS Code, VS
// Code reloads the document, and its problems stay those of the previous text
// until the language server reports again. get_diagnostics waits for that
// report rather than hand back problems the agent already fixed. Recorded from
// activation on, so a file the user opened before the first call counts too.

import * as vscode from 'vscode';

/** Per open document, its version when its diagnostics last changed. */
const reportedVersion = new Map<string, number>();

/** Records the reports on open documents until disposed. */
export function watchDocumentChecks(): vscode.Disposable {
  const subscriptions = [
    vscode.languages.onDidChangeDiagnostics(event => {
      const open = new Map((vscode.workspace.textDocuments ?? []).map(document => [document.uri.toString(), document]));
      for (const uri of event.uris) {
        const document = open.get(uri.toString());
        if (document) {
          reportedVersion.set(uri.toString(), document.version);
        }
      }
    }),
    vscode.workspace.onDidCloseTextDocument(document => reportedVersion.delete(document.uri.toString())),
  ];
  return {
    dispose: () => {
      subscriptions.forEach(subscription => subscription.dispose());
      reportedVersion.clear();
    },
  };
}

/**
 * True when something reported on the document before and its text changed
 * since, so its problems are those of an older text. A document nothing
 * reported on may have no checker at all, so it does not count.
 */
export function awaitingReport(document: vscode.TextDocument): boolean {
  const version = reportedVersion.get(document.uri.toString());
  return version !== undefined && version < document.version;
}
