import vscode, { ThemeIcon } from "vscode";
import path from "path";
import { ExtensionContext, QuickPickItem } from "vscode";
import { WestWorkspace } from "./WestWorkspace";
import { ZephyrBoard } from "./ZephyrBoard";
import { ZephyrSample } from "./ZephyrSample";
import { MultiStepInput } from "./utilities/MultiStepQuickPick";
import { fileExists, getListSamples, getListZephyrSDKs, getSupportedBoards, getWestWorkspace, getWestWorkspaces, getZephyrSDK } from "./utils";
import { ZephyrSDK } from "./ZephyrSDK";

export async function createProjectQuickStep(context: ExtensionContext) {
  const title = 'Create New Project';

  interface ProjectConfig {
    westWorkspace: WestWorkspace,
    sdk: ZephyrSDK,
    board: ZephyrBoard,
    sample: ZephyrSample,
    projectLoc: string,
    projectName: string
  }

  class BrowseFolderButton implements vscode.QuickInputButton {
		constructor(public iconPath: ThemeIcon, public tooltip: string) { }
	}

	const browseFolderButton = new BrowseFolderButton( ThemeIcon.Folder , 'Select folder');

  
  async function collectInputs() {
    const state = {} as Partial<ProjectConfig>;
    await MultiStepInput.run(input => pickWestWorkspace(input, state));
    return state as ProjectConfig;
  }

  async function pickWestWorkspace(input: MultiStepInput, state: Partial<ProjectConfig>) {
    const westWorkspaceItems: QuickPickItem[] = [];

    for(let westWorkspace of getWestWorkspaces()) {
      westWorkspaceItems.push({ label: westWorkspace.name, description: westWorkspace.rootUri.fsPath });
    }

    const pick = await input.showQuickPick({
			title,
			step: 1,
			totalSteps: 6,
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
			step: 2,
			totalSteps: 6,
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
    if(state.westWorkspace) {
      const boards = await getSupportedBoards(state.westWorkspace);
      boards.sort((a, b) => {
        if (a.name < b.name) {
          return -1;
        }
        if (a.name > b.name) {
          return 1;
        }
        return 0;
      });
      for(let board of boards) {
        boardItems.push({ label: board.identifier });
      }
    
      const pick = await input.showQuickPick({
        title,
        step: 3,
        totalSteps: 6,
        placeholder: 'Select the target board',
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
		return (input: MultiStepInput) => pickSample(input, state);
	}

  async function pickSample(input: MultiStepInput, state: Partial<ProjectConfig>) {

    const sampleItems: QuickPickItem[] = [];

    const samples = await getListSamples(state.westWorkspace as WestWorkspace);
    for(let sample of samples) {
      sampleItems.push({ label: sample.name, description: sample.rootDir.fsPath });
    }


		const pick = await input.showQuickPick({
			title,
			step: 4,
			totalSteps: 6,
			placeholder: 'Select sample',
			items: sampleItems,
			shouldResume: shouldResume
		});

    if(pick) {
      if(pick.description) {
        for(let sample of samples) {
          if(sample.rootDir.fsPath === pick.description) {
            state.sample = sample;
            state.projectName = pick.label;
            break;
          }
        }
      }
    }

    return (input: MultiStepInput) => enterParentLocation(input, state);

  }

  async function enterParentLocation(input: MultiStepInput, state: Partial<ProjectConfig>) {
		const pick = await input.showInputBox({
			title,
			step: 5,
			totalSteps: 6,
			value: typeof state.projectLoc === 'string' ? state.projectLoc : '',
			prompt: 'Enter or select the project parent location',
      buttons: [browseFolderButton],
      validate: validateLocation,
			shouldResume: shouldResume
		});

    if(pick instanceof BrowseFolderButton) {
      const folderUri = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select',
      });

      if(folderUri && folderUri.length > 0) {
        state.projectLoc = folderUri[0].fsPath;
        enterParentLocation(input, state);
      }
    }

    return (input: MultiStepInput) => enterProjectName(input, state);
	}

  async function enterProjectName(input: MultiStepInput, state: Partial<ProjectConfig>) {
    const pick = await input.showInputBox({
			title,
			step: 6,
			totalSteps: 6,
			value: typeof state.projectName === 'string' ? state.projectName : '',
			prompt: 'Enter or select the project parent location',
      validate: validateProjectName,
			shouldResume: shouldResume
		});

    async function validateProjectName(name: string) {
      if(state.projectLoc) {
        let projectPath = path.join(state.projectLoc, name);
        return fileExists(projectPath) ? 'The project folder already exists !' : undefined;
      }
    }

    if(pick){
      state.projectName = pick;
    }

  }

  async function validateLocation(location: string) {
    return undefined;
  }

  

  function shouldResume() {
    // Could show a notification with the option to resume.
    return new Promise<boolean>((resolve, reject) => {
      reject();
    });
  }

  const state = await collectInputs();
  vscode.commands.executeCommand("zephyr-workbench-app-explorer.create-app", state.westWorkspace, state.sample, state.board, state.projectLoc, state.projectName, state.sdk);
}


