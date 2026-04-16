import * as vscode from 'vscode';

export async function showPristineQuickPick(): Promise<string> {
	const result = await vscode.window.showQuickPick(['auto', 'always', 'never'], {
		placeHolder: 'Select the build pristine mode',
	});
  return result ?? 'auto';
}
