import { provideVSCodeDesignSystem, Button, RadioGroup, TextField, vsCodeButton, vsCodeCheckbox, vsCodeTextField , vsCodeRadioGroup, vsCodeRadio} from "@vscode/webview-ui-toolkit/";

provideVSCodeDesignSystem().register(
  vsCodeButton(), 
  vsCodeCheckbox(),
  vsCodeTextField(),
  vsCodeRadio(),
  vsCodeRadioGroup()
);

const webviewApi = acquireVsCodeApi();

window.addEventListener("load", main);

function main() {

  setVSCodeMessageListener();

  const srcTypeRadioGroup = document.getElementById("srcType") as RadioGroup;
  srcTypeRadioGroup.addEventListener("click", modifySrcTypeHandler);
  srcTypeRadioGroup.addEventListener("select", modifySrcTypeHandler);

  const browseButton = document.getElementById("browseButton") as Button;
  browseButton?.addEventListener("click", browseLocalPath);

  const importButton = document.getElementById("importButton") as Button;
  importButton?.addEventListener("click", importHandler);

  setDefault();
}

function setDefault() {
  // const configuration = vscode.workspace.getConfiguration();
  // const srcTypeRadioGroup = document.getElementById("srcType") as RadioGroup;
  // const srcRemotePath = document.getElementById("remotePath") as TextField;
  // const srcRemoteBranch = document.getElementById("remoteBranch") as TextField;
  // const localPath = document.getElementById("localPath") as TextField;

  // let srcTypeValue: string | undefined = configuration.get('zephyr-workbench.kernel.srcType');
  // if(srcTypeValue) { srcTypeRadioGroup.value = srcTypeValue; }

  // if(srcTypeValue === 'remote') {
  //   let srcPath: string | undefined = configuration.get('zephyr-workbench.kernel.srcPath');
  //   let srcBranch: string | undefined = configuration.get('zephyr-workbench.kernel.srcBranch');
  //   if(srcPath) { srcRemotePath.value = srcPath; }
  //   if(srcBranch) { srcRemoteBranch.value = srcBranch; }
  // } else {
  //   let srcPath: string | undefined = configuration.get('zephyr-workbench.kernel.srcPath');
  //   if(srcPath) { localPath.value = srcPath; }
  // }

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
  const srcRemoteBranch = document.getElementById("remoteBranch") as TextField;
  const localPath = document.getElementById("localPath") as TextField;
  const browseButton = document.getElementById("browseButton") as Button;

  // Enable/Disable form section depending on user choice
  if(srcTypeRadioGroup.value === 'remote') {
    srcRemotePath.removeAttribute('disabled');
    srcRemoteBranch.removeAttribute('disabled');
    localPath.setAttribute('disabled', '');
    browseButton.setAttribute('disabled', '');
  } else if(srcTypeRadioGroup.value === 'local') {
    srcRemotePath.setAttribute('disabled', '');
    srcRemoteBranch.setAttribute('disabled', '');
    localPath.removeAttribute('disabled');
    browseButton.removeAttribute('disabled');
  }
}

function browseLocalPath(this: HTMLElement, ev: MouseEvent) {
  webviewApi.postMessage(
    { 
      command: 'openFolderDialog' 
    }
  );
}

// function importHandler(this: HTMLElement, ev: MouseEvent) {
//   const srcTypeRadioGroup = document.getElementById("srcType") as RadioGroup;
//   const srcRemotePath = document.getElementById("remotePath") as TextField;
//   const srcRemoteBranch = document.getElementById("remoteBranch") as TextField;
//   const localPath = document.getElementById("localPath") as TextField;

//   const configuration = vscode.workspace.getConfiguration();
//   configuration.update('zephyr-workbench.kernel.srcType', srcTypeRadioGroup.value);
//   if(srcTypeRadioGroup.value === 'remote') {
//     configuration.update('zephyr-workbench.kernel.srcPath', srcRemotePath.value);
//     configuration.update('zephyr-workbench.kernel.srcBranch', srcRemoteBranch.value);
//   } else {
//     configuration.update('zephyr-workbench.kernel.srcPath', localPath);
//   }
  
//   webviewApi.postMessage({
//     command: "debug",
//     text: srcTypeRadioGroup.value,
//   });
// }

function importHandler(this: HTMLElement, ev: MouseEvent) {
  const srcTypeRadioGroup = document.getElementById("srcType") as RadioGroup;
  const srcRemotePath = document.getElementById("remotePath") as TextField;
  const srcRemoteBranch = document.getElementById("remoteBranch") as TextField;
  const localPath = document.getElementById("localPath") as TextField;

  webviewApi.postMessage(
    {
      command: 'import',
      srcType: srcTypeRadioGroup.value,
      remotePath: srcRemotePath.value,
      remoteBranch: srcRemoteBranch.value,
      localPath: localPath.value,
    }
  );
}

function testHandler() {
  webviewApi.postMessage({
    command: "debug",
    text: "test",
  });
}



