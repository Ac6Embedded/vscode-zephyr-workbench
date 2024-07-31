import * as vscode from 'vscode';

export async function showPristineQuickPick(): Promise<string> {
	let i = 0;
	const result = await vscode.window.showQuickPick(['auto', 'always', 'none'], {
		placeHolder: 'Select the build pristine mode',
	});
  return result ? result : 'auto';
}