import vscode, { ExtensionContext, QuickPickItem, ThemeIcon } from "vscode";
import { WestWorkspace } from "./WestWorkspace";
import { ZephyrAppProject } from "./ZephyrAppProject";
import { ZephyrBoard } from "./ZephyrBoard";
import { ZephyrProject } from "./ZephyrProject";
import { ZephyrSDK } from "./ZephyrSDK";
import { MultiStepInput } from "./utilities/MultiStepQuickPick";
import { getListZephyrSDKs, getSupportedBoards, getWestWorkspace, getWestWorkspaces, getZephyrSDK } from "./utils";

export async function importProjectQuickStep(context: ExtensionContext) {
  const title = 'Import Project';

  interface ProjectConfig {
    projectLoc: string,
    reconfigure: boolean,
    westWorkspace: WestWorkspace,
    sdk: ZephyrSDK,
    board: ZephyrBoard,
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
      validate: validateProjectLocation,
			shouldResume: shouldResume
		});

    if(pick instanceof BrowseFolderButton) {
      const folderUri = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select parent location:',
      });

      if(folderUri && folderUri.length > 0) {
        state.projectLoc = folderUri[0].fsPath;
      }
    }

    //return (input: MultiStepInput) => pickWestWorkspace(input, state);
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
    return (input: MultiStepInput) => pickZephyrSDK(input, state);
  }

  async function pickZephyrSDK(input: MultiStepInput, state: Partial<ProjectConfig>) {
    const zephyrSDKItems: QuickPickItem[] = [];

    for(let zephyrSDK of await getListZephyrSDKs()) {
      zephyrSDKItems.push({ label: zephyrSDK.name, description: zephyrSDK.version, detail: zephyrSDK.rootUri.fsPath });
    }

    const pick = await input.showQuickPick({
			title,
			step: 3,
			totalSteps: 4,
			placeholder: 'Select the Zephyr SDK',
			items: zephyrSDKItems,
			shouldResume: shouldResume
		});

    if(pick) {
      if(pick.detail) {
        state.sdk = getZephyrSDK(pick.detail);
      }
    }
    return (input: MultiStepInput) => pickBoard(input, state);
  }

  async function pickBoard(input: MultiStepInput, state: Partial<ProjectConfig>) {

    const boardItems: QuickPickItem[] = [];
    let prevBoardItem: QuickPickItem | undefined = undefined;
    if(state.westWorkspace) {

      // Get preset board FIXME maybe not supported by MultiStepInput yet
      if(state.projectLoc && state.reconfigure === true) {
        let proj: ZephyrAppProject = new ZephyrAppProject(vscode.Uri.file(state.projectLoc), state.projectLoc);
        const listBoards = await getSupportedBoards(state.westWorkspace);
        for(let board of listBoards) {
          if(board.identifier === proj.boardId) {
            state.board = board;
            break;
          }
        }
      }

      const boards = await getSupportedBoards(state.westWorkspace);
      for(let board of boards) {
        boardItems.push({ label: board.identifier });
        if(board.identifier === state.board?.identifier) {
          prevBoardItem = { label: board.identifier };
        }
      }

      const pick = await input.showQuickPick({
        title,
        step: 4,
        totalSteps: 4,
        placeholder: 'Select the target board',
        activeItem: prevBoardItem,
        items: boardItems,
        shouldResume: shouldResume
      });

      if(pick) {
        for(let board of boards) {
          if(board.identifier === pick.label) {
            state.board = board;
            break;
          }
        }
      }
    }
	}

  async function validateProjectLocation(location: string) {
    return undefined;
  }

  function shouldResume() {
    // Could show a notification with the option to resume.
    return new Promise<boolean>((resolve, reject) => {
      reject();
    });
  }

  const state = await collectInputs();
  vscode.commands.executeCommand("zephyr-workbench-app-explorer.import-app", state.projectLoc,  state.westWorkspace, state.board, state.sdk);
}


function isZephyrProjectPath(projectLoc: string | undefined) {
  throw new Error("Function not implemented.");
}

