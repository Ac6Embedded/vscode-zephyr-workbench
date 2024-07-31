import { provideVSCodeDesignSystem, Button, RadioGroup, TextField, vsCodeButton, vsCodeCheckbox, vsCodeTextField , vsCodeRadioGroup, vsCodeRadio, vsCodePanels, vsCodePanelView, vsCodePanelTab} from "@vscode/webview-ui-toolkit/";

provideVSCodeDesignSystem().register(
  vsCodeButton(), 
  vsCodeCheckbox(),
  vsCodeTextField(),
  vsCodeRadio(),
  vsCodeRadioGroup(),
  vsCodePanels(), 
  vsCodePanelTab(), 
  vsCodePanelView()
);

const webviewApi = acquireVsCodeApi();

window.addEventListener("load", main);

function main() {

  setVSCodeMessageListener();

  const srcTypeRadioGroup = document.getElementById("srcType") as RadioGroup;
  srcTypeRadioGroup.addEventListener("click", modifySrcTypeHandler);
  srcTypeRadioGroup.addEventListener("select", modifySrcTypeHandler);

  const browseLocationButton = document.getElementById("browseLocationButton") as Button;
  browseLocationButton?.addEventListener("click", browseLocationHandler);

  const importButton = document.getElementById("importButton") as Button;
  importButton?.addEventListener("click", importHandler);

}

function setVSCodeMessageListener() {
  window.addEventListener("message", (event) => {
    const command = event.data.command;

    switch(command) {
      case 'folderSelected':
        setLocalPath(event.data.id, event.data.folderUri);
        break;
    }
  });
}

function setLocalPath(id: string, path: string) {
  const localPath = document.getElementById(id) as TextField;
  localPath.value = path;
}


function modifySrcTypeHandler(this: HTMLElement) {
  const srcTypeRadioGroup = document.getElementById("srcType") as RadioGroup;
  const srcRemotePath = document.getElementById("remotePath") as TextField;

  // Enable/Disable form section depending on user choice
  if(srcTypeRadioGroup.value === 'remote') {
    srcRemotePath.removeAttribute('disabled');
  } else if(srcTypeRadioGroup.value === 'local') {
    srcRemotePath.setAttribute('disabled', '');
  }
}

function browseLocationHandler(this: HTMLElement, ev: MouseEvent) {
  webviewApi.postMessage(
    { 
      command: 'openLocationDialog', 
    }
  );
}

function importHandler(this: HTMLElement, ev: MouseEvent) {
  const srcTypeRadioGroup = document.getElementById("srcType") as RadioGroup;
  const srcRemotePath = document.getElementById("remotePath") as TextField;
  const workspacePath = document.getElementById("workspacePath") as TextField;

  webviewApi.postMessage(
    {
      command: 'create',
      srcType: srcTypeRadioGroup.value,
      remotePath: srcRemotePath.value,
      workspacePath: workspacePath.value,
    }
  );
}



