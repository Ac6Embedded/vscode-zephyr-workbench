import { allComponents,
  Button,
  Checkbox,
  provideVSCodeDesignSystem, 
  RadioGroup} from "@vscode/webview-ui-toolkit/";

provideVSCodeDesignSystem().register(
  allComponents
);

const webviewApi = acquireVsCodeApi();

window.addEventListener("load", main);

function main() {
  const sdkConfigRadioGroup = document.getElementById("sdkConfig") as RadioGroup;
  const importButton = document.getElementById("importButton") as Button;
  
  sdkConfigRadioGroup.addEventListener("click", sdkConfigHandler);
  sdkConfigRadioGroup.addEventListener("select", sdkConfigHandler);
  importButton.addEventListener("click", importHandler);
  
  setVSCodeMessageListener();

}

function setVSCodeMessageListener() {
  window.addEventListener("message", (event) => {
    const command = event.data.command;
    switch(command) {
      case '': {
        
      }
      default:
        break;
    }

  });
}
function sdkConfigHandler(this: HTMLElement, ev: Event) {
  const sdkConfigRadioGroup = document.getElementById("sdkConfig") as RadioGroup;
  const tCheckboxes = document.getElementsByClassName('toolchain-checkbox');
  
  for(let tCheckbox of tCheckboxes) {
    if(sdkConfigRadioGroup.value === 'select') {
      tCheckbox.removeAttribute('disabled');
    } else {
      tCheckbox.setAttribute('disabled', '');
    }
  }
}

function importHandler(this: HTMLElement, ev: MouseEvent) {
  const sdkConfigRadioGroup = document.getElementById("sdkConfig") as RadioGroup;
  const listToolchains = getListSelectedToolchains();
  webviewApi.postMessage(
    { 
      command: 'import',
      sdkconfig: sdkConfigRadioGroup.value,
      listToolchains: listToolchains,
    }
  );
}

function getListSelectedToolchains(): string {
  const tCheckboxes = document.getElementsByClassName('toolchain-checkbox') as HTMLCollectionOf<Checkbox>;
  let listTools = "";
  for(let tCheckbox of tCheckboxes) {
    if(tCheckbox.getAttribute('current-checked') === 'true') {
      console.log(tCheckbox);
      listTools += ` ${tCheckbox.value}`;
    }
  }
  return listTools;
}

