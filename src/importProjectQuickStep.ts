import vscode, { ExtensionContext, QuickPickItem, ThemeIcon } from "vscode";
import { WestWorkspace } from "./WestWorkspace";
import { ZephyrBoard } from "./ZephyrBoard";
import { ZephyrProject } from "./ZephyrProject";
import { ZephyrSDK } from "./ZephyrSDK";
import { MultiStepInput } from "./utilities/MultiStepQuickPick";
import { fileExists, getListZephyrSDKs, getListIARs, getSupportedBoards, getWestWorkspace, getWestWorkspaces, validateProjectLocation, getZephyrSDK, getIarToolchainForSdk, normalizePath } from "./utils";

export async function importProjectQuickStep(context: ExtensionContext) {
  const title = 'Import Project';

  interface ProjectConfig {
    projectLoc: string;
    reconfigure: boolean;
    westWorkspace: WestWorkspace;
    sdk?: ZephyrSDK;       // Zephyr SDK choice
    iarPath?: string;      // IAR choice
    board: ZephyrBoard;
  }
  

  class BrowseFolderButton implements vscode.QuickInputButton {
		constructor(public iconPath: ThemeIcon, public tooltip: string) { }
	}

	const browseFolderButton = new BrowseFolderButton( ThemeIcon.Folder , 'Select folder');

  
  async function collectInputs() {
    const state = {} as Partial<ProjectConfig>;
    await MultiStepInput.run(input => enterProjectLocation(input, state));
    return state as ProjectConfig;
  }

  async function enterProjectLocation(input: MultiStepInput, state: Partial<ProjectConfig>) {
		const pick = await input.showInputBox({
			title,
			step: 1,
			totalSteps: 4,
			value: typeof state.projectLoc === 'string' ? state.projectLoc : '',
			prompt: 'Enter or select the project to import',
      buttons: [browseFolderButton],
      ignoreFocusOut: true,
      validate: validateProjectLocation,
			shouldResume: shouldResume
		});

    if(pick) {
      if(pick instanceof BrowseFolderButton) {
        const folderUri = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Select',
        });
  
        if(folderUri && folderUri.length > 0) {
          state.projectLoc = folderUri[0].fsPath;
        }
      } else {
        state.projectLoc = pick;
      }
    }

    return (input: MultiStepInput) => pickReconfigure(input, state);
	}

  async function pickReconfigure(input: MultiStepInput, state: Partial<ProjectConfig>) {
    if(state.projectLoc && ZephyrProject.isZephyrProjectPath(state.projectLoc)) {
      const choiceItems: QuickPickItem[] = [ { label: 'No' }, { label: 'Yes' }];
      const pick = await input.showQuickPick({
        title,
        step: 2,
        totalSteps: 4,
        placeholder: 'A Zephyr Workbench project is detected, do you want to reconfigure the project?',
        items: choiceItems,
        ignoreFocusOut: true,
        shouldResume: shouldResume
      });

      if(pick) {
        let projLoc = state.projectLoc;
        if(pick.label === 'No') {
          vscode.commands.executeCommand("zephyr-workbench-app-explorer.import-local", projLoc);
          return;
        }
        state.reconfigure = true;
      }
    }
    return (input: MultiStepInput) => pickWestWorkspace(input, state);
  }

  async function pickWestWorkspace(input: MultiStepInput, state: Partial<ProjectConfig>) {
    const westWorkspaceItems: QuickPickItem[] = [];

    for(let westWorkspace of getWestWorkspaces()) {
      westWorkspaceItems.push({ label: westWorkspace.name, description: westWorkspace.rootUri.fsPath });
    }

    const pick = await input.showQuickPick({
			title,
			step: 2,
			totalSteps: 4,
			placeholder: 'Select the west workspace',
			items: westWorkspaceItems,
      ignoreFocusOut: true,
			shouldResume: shouldResume
		});

    if(pick) {
      if(pick.description) {
        try {
          state.westWorkspace = getWestWorkspace(pick.description);
        } catch(e) {
          console.error(e, " path: ", pick.description);
        }
      }
    }
    return (input: MultiStepInput) => pickToolchain(input, state);
  }

  async function pickToolchain(input: MultiStepInput, state: Partial<ProjectConfig>) {
    type TcItem = QuickPickItem & {
      tcKind: "zephyr_sdk" | "iar";
      sdk?: ZephyrSDK;
      iarPath?: string;
    };
  
    const items: TcItem[] = [];
  
    for (const sdk of await getListZephyrSDKs()) {
      items.push({
        label:        sdk.name,
        description:  sdk.version,
        detail:       sdk.rootUri.fsPath,
        tcKind:       "zephyr_sdk",
        sdk
      });
    }
  
    for (const iar of await getListIARs()) {
      items.push({
        label:        iar.name,
        description:  "IAR toolchain",
        detail:       iar.iarPath,
        tcKind:       "iar",
        iarPath:      iar.iarPath
      });
    }
  
    const pick = await input.showQuickPick({
      title,
      step: 3,
      totalSteps: 4,
      placeholder: "Select the toolchain",
      items,
      ignoreFocusOut: true,
      shouldResume
    }) as TcItem | undefined;
  
    if (pick) {
      if (pick.tcKind === "zephyr_sdk") {
        state.sdk = pick.sdk!;
      } else {
        state.iarPath = pick.iarPath!;
      }
    }
    return (input: MultiStepInput) => pickBoard(input, state);
  }

  async function pickBoard(input: MultiStepInput, state: Partial<ProjectConfig>) {

    const boardItems: QuickPickItem[] = [];
    let prevBoardItem: QuickPickItem | undefined = undefined;
    if(state.westWorkspace) {

      // Get preset board FIXME maybe not supported by MultiStepInput yet
      // if(state.projectLoc && state.reconfigure === true) {
      //   let proj: ZephyrAppProject = new ZephyrAppProject(vscode.Uri.file(state.projectLoc), state.projectLoc);
      //   const listBoards = await getSupportedBoards(state.westWorkspace, state.projectLoc);
      //   listBoards.sort((a, b) => {
      //     if (a.name < b.name) {
      //       return -1;
      //     }
      //     if (a.name > b.name) {
      //       return 1;
      //     }
      //     return 0;
      //   });
      //   for(let board of listBoards) {
      //     if(board.identifier === proj.boardId) {
      //       state.board = board;
      //       break;
      //     }
      //   }
      // }

      let boards: ZephyrBoard[] = [];
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Updating available boards list. It might take a while...",
        cancellable: false,
        }, async () => {
          if(state.westWorkspace) {
            boards = await getSupportedBoards(state.westWorkspace, state.projectLoc);
            boards.sort((a, b) => {
              if (a.name < b.name) {
                return -1;
              }
              if (a.name > b.name) {
                return 1;
              }
              return 0;
            });
          }
        }
      );

      for(let board of boards) {
        boardItems.push({ label: board.name, description: board.identifier });
      }

      const pick = await input.showQuickPick({
        title,
        step: 4,
        totalSteps: 4,
        placeholder: 'Select the target board',
        items: boardItems,
        ignoreFocusOut: true,
        shouldResume: shouldResume
      });

      if(pick) {
        for(let board of boards) {
          if(board.identifier === pick.description) {
            state.board = board;
            break;
          }
        }
      }
    }
	}


  function shouldResume() {
    // Could show a notification with the option to resume.
    return new Promise<boolean>((resolve, reject) => {
      reject();
    });
  }

  const state = await collectInputs();
  const toolchain = (state.sdk && getZephyrSDK(state.sdk.rootUri.fsPath)) || (state.iarPath && getIarToolchainForSdk(state.iarPath));
  vscode.commands.executeCommand(
    "zephyr-workbench-app-explorer.import-app", state.projectLoc, state.westWorkspace, state.board, toolchain);
}

