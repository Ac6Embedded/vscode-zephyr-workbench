// When `west boards` cannot start because the Python venv it runs in lacks a
// module, the board pickers say which module is missing from which venv, and
// offer the command that rebuilds that venv.

import * as vscode from 'vscode';
import { WestCommandError } from '../../commands/WestCommands';
import type { WestWorkspace } from '../../models/WestWorkspace';
import { missingPythonModule } from './westFailures';
import { westCommandVenv } from './westWorkspaceSetup';

export interface MissingPythonModuleNotice {
  /** The module west could not import, such as jsonschema. */
  module: string;
  /** Which module is missing from which venv, and what fixes it. */
  message: string;
  /** The button that rebuilds that venv; none for a venv the workbench did not create. */
  repair?: { title: string; run(): Thenable<unknown> };
}

/**
 * The notice for a board discovery that failed because west could not import
 * a Python module, undefined for any other failure.
 */
export function describeMissingPythonModule(error: unknown, westWorkspace: WestWorkspace): MissingPythonModuleNotice | undefined {
  const module = error instanceof WestCommandError ? missingPythonModule(error.stderr) : undefined;
  if (!module) {
    return undefined;
  }
  const missing = `Boards could not be listed: west needs the Python module '${module}', which is missing from`;
  const venv = westCommandVenv(westWorkspace);
  switch (venv.kind) {
    case 'dedicated':
      return {
        module,
        message: `${missing} the dedicated venv of ${westWorkspace.name}. Recreate it to install the Python requirements of this Zephyr version.`,
        // The command only reads the west workspace of the tree item it is given.
        repair: {
          title: 'Recreate dedicated venv',
          run: () => vscode.commands.executeCommand('zephyr-workbench-west-workspace.create-venv', { westWorkspace }),
        },
      };
    case 'global':
      return {
        module,
        message: `${missing} the global venv. Reinstall it to install the Python requirements of Zephyr.`,
        repair: {
          title: 'Reinstall global venv',
          run: () => vscode.commands.executeCommand('zephyr-workbench.reinstall-venv', true),
        },
      };
    default:
      return {
        module,
        message: `${missing} the venv ${venv.path}. Install the Python requirements of this Zephyr version into it.`,
      };
  }
}

/** Show the notice as an error, with its repair button when there is one. */
export async function showMissingPythonModule(notice: MissingPythonModuleNotice): Promise<void> {
  const repair = notice.repair;
  const choice = await vscode.window.showErrorMessage(notice.message, ...(repair ? [repair.title] : []));
  if (repair && choice === repair.title) {
    await repair.run();
  }
}
