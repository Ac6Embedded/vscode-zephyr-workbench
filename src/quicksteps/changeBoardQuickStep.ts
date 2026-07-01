import vscode, { ExtensionContext, QuickPickItem } from "vscode";
import { ZephyrApplication } from "../models/ZephyrApplication";
import { getSupportedBoards } from "../utils/zephyr/boardDiscovery";
import { getWestWorkspace } from "../utils/utils";
import { getOutputChannel } from "../utils/execUtils";
import { ZephyrBoard } from "../models/ZephyrBoard";

interface BoardQuickPickItem extends QuickPickItem {
  /** Marks the trailing "Enter custom board..." escape hatch. */
  isCustom?: boolean;
}

export async function changeBoardQuickStep(context: ExtensionContext, project: ZephyrApplication, buildConfigName?: string): Promise<string | undefined> {
  const configs = project.buildConfigs;
  let buildConfig;

  if (buildConfigName) {
    buildConfig = project.getBuildConfiguration(buildConfigName);
  } else {
    for (let cfg of configs) {
      if (cfg.active === true) {
        buildConfig = cfg;
        break;
      }
    }

    if (!buildConfig && configs.length > 0) {
      buildConfig = configs[0];
    }
  }
  if (!buildConfig) {
    throw new Error("No valid build configuration found. Please check your project settings.");
  }

  // Resolve the workspace and discover boards defensively: a missing/invalid
  // workspace or a failed board search must not block the user. In every case we
  // still surface the "Enter custom board..." option so a board that was not
  // detected (e.g. a custom board root) can be provided manually.
  let westWorkspace;
  try {
    westWorkspace = getWestWorkspace(project.westWorkspaceRootPath);
  } catch {
    westWorkspace = undefined;
  }

  let boards: ZephyrBoard[] = [];
  let discoveryFailed = false;

  if (westWorkspace) {
    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Updating available boards list. It might take a while...",
        cancellable: false,
      }, async () => {
        const found = await getSupportedBoards(westWorkspace!, project, buildConfig);
        found.sort((a, b) => {
          if (a.name < b.name) {
            return -1;
          }
          if (a.name > b.name) {
            return 1;
          }
          return 0;
        });
        boards = found;
      });
    } catch (error) {
      discoveryFailed = true;
      getOutputChannel().appendLine(
        `[Zephyr Workbench] Board discovery failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
      );
    }
  }

  const boardItems: BoardQuickPickItem[] = boards.map(board => ({ label: board.name, description: board.identifier }));

  const items: BoardQuickPickItem[] = [...boardItems];
  if (boardItems.length > 0) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  }
  items.push({
    label: '$(edit) Enter custom board...',
    detail: 'Type a board identifier manually (use this if your board is not listed)',
    alwaysShow: true,
    isCustom: true,
  });

  const placeHolder = boards.length > 0
    ? 'Select a target board'
    : discoveryFailed
      ? 'Board discovery failed. Enter a custom board.'
      : 'No boards found. Enter a custom board.';

  const result = await vscode.window.showQuickPick(items, {
    title: 'Change Board',
    placeHolder,
    matchOnDescription: true,
    matchOnDetail: true,
    canPickMany: false,
    ignoreFocusOut: true,
  });

  if (!result) {
    return undefined;
  }

  if (result.isCustom) {
    return promptCustomBoardIdentifier(buildConfig.boardIdentifier);
  }

  return result.description ?? undefined;
}

/**
 * Ask the user to type a board identifier as accepted by `west build -b`, e.g.
 * `nucleo_f401re` or `nrf5340dk/nrf5340/cpuapp`. Pre-fills the current board so
 * it can be tweaked. Returns the trimmed identifier, or undefined if cancelled.
 */
async function promptCustomBoardIdentifier(currentBoardIdentifier?: string): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: 'Enter custom board',
    prompt: 'Board identifier passed to "west build -b". Example: nucleo_f401re or nrf5340dk/nrf5340/cpuapp',
    placeHolder: 'board[@revision][/soc[/cluster][/variant]]',
    value: currentBoardIdentifier,
    ignoreFocusOut: true,
    validateInput: (raw) => {
      const input = raw.trim();
      if (input.length === 0) {
        return 'Board identifier cannot be empty';
      }
      if (/\s/.test(input)) {
        return 'Board identifier cannot contain spaces';
      }
      return undefined;
    },
  });

  return value?.trim() || undefined;
}
