import { provideVSCodeDesignSystem, Button, Dropdown, TextField, vsCodeButton, vsCodeCheckbox, vsCodeTextField , vsCodeRadioGroup, vsCodeRadio, vsCodeDropdown} from "@vscode/webview-ui-toolkit/";

provideVSCodeDesignSystem().register(
  vsCodeButton(), 
  vsCodeCheckbox(),
  vsCodeTextField(),
  vsCodeRadio(),
  vsCodeRadioGroup(),
  vsCodeDropdown()
);

const webviewApi = acquireVsCodeApi();

window.addEventListener("load", main);

function main() {

  setVSCodeMessageListener();

  const workspacesDropdown = document.getElementById("workspacesList") as Dropdown;
  workspacesDropdown?.addEventListener("change", workspaceChangedHandler);

  const createButton = document.getElementById("createButton") as Button;
  createButton?.addEventListener("click", createHandler);
}

function setVSCodeMessageListener() {
  window.addEventListener("message", (event) => {
    const command = event.data.command;
    switch(command) {
      case 'update-form':
        //updateForm(event.data.id, event.data.folderUri);
        break;
    }

  });
}

function workspaceChangedHandler(this: HTMLElement, ev: Event) {
  const workspacesDropdown = document.getElementById("listWorkspaces") as Dropdown;
  webviewApi.postMessage(
    {
      command: 'select-workspace',
      workspace: 'changed'
    }
  );

  const samplesDropdown = document.getElementById("samplesList") as Dropdown;

}


function createHandler(this: HTMLElement, ev: MouseEvent) {
  webviewApi.postMessage(
    {
      command: 'create',
      text: 'create'
    }
  );
}

function testHandler() {
  webviewApi.postMessage({
    command: "debug",
    text: "test"
  });
}




