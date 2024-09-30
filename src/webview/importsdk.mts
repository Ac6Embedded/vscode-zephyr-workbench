import { provideVSCodeDesignSystem, Button, RadioGroup, TextField, vsCodeButton, vsCodeCheckbox, vsCodeTextField , vsCodeRadioGroup, vsCodeRadio, vsCodePanels, vsCodePanelView, vsCodePanelTab, Checkbox} from "@vscode/webview-ui-toolkit/";
import { list } from "node-7z";

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

  initVersionsDropdown();

  const srcTypeRadioGroup = document.getElementById("srcType") as RadioGroup;
  srcTypeRadioGroup.addEventListener("click", modifySrcTypeHandler);
  srcTypeRadioGroup.addEventListener("select", modifySrcTypeHandler);
  srcTypeRadioGroup.dispatchEvent(new Event('select'));

  const sdkTypeRadioGroup = document.getElementById("sdkType") as RadioGroup;
  sdkTypeRadioGroup.addEventListener("click", modifySdkTypeHandler);
  sdkTypeRadioGroup.addEventListener("select", modifySdkTypeHandler);

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
  const officialForm = document.getElementById("official-form") as HTMLElement;
  const srcRemotePath = document.getElementById("remotePath") as TextField;

  // Enable/Disable form section depending on user choice
  if(srcTypeRadioGroup.value === 'official') {
    officialForm.style.display = "block";
    srcRemotePath.setAttribute('disabled', '');
    srcRemotePath.style.display = "none";
  } else if(srcTypeRadioGroup.value === 'remote') {
    officialForm.style.display = "none";
    srcRemotePath.removeAttribute('disabled');
    srcRemotePath.style.display = "block";
  } else if(srcTypeRadioGroup.value === 'local') {
    officialForm.style.display = "none";
    srcRemotePath.setAttribute('disabled', '');
    srcRemotePath.style.display = "none";
  } 
}

function modifySdkTypeHandler(this: HTMLElement) {
  const sdkTypeRadioGroup = this as RadioGroup;
  const tCheckboxes = document.getElementsByClassName('toolchain-checkbox');
  for(let tCheckbox of tCheckboxes) {
    if(sdkTypeRadioGroup.value === 'minimal') {
      tCheckbox.removeAttribute('disabled');
    } else {
      tCheckbox.setAttribute('disabled', '');
    }
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
  const sdkTypeRadioGroup = document.getElementById("sdkType") as RadioGroup;
  const versionInput = document.getElementById('versionInput') as HTMLInputElement;
  const listToolchains = getListSelectedToolchains();
  
  webviewApi.postMessage(
    {
      command: 'import',
      srcType: srcTypeRadioGroup.value,
      remotePath: srcRemotePath.value,
      workspacePath: workspacePath.value,
      sdkType: sdkTypeRadioGroup.value,
      sdkVersion: versionInput.getAttribute('data-value'),
      listToolchains: listToolchains
    }
  );
}



function initVersionsDropdown() {
  const versionInput = document.getElementById('versionInput') as HTMLInputElement;
  const versionsDropdown = document.getElementById('versionsDropdown') as HTMLElement;
  
  versionInput.addEventListener('focusin', function() {
    if(versionsDropdown) {
      versionsDropdown.style.display = 'block';
    }
  });

  versionInput.addEventListener('focusout', function() {
    if(versionsDropdown) {
      versionsDropdown.style.display = 'none';
    }
  });

  versionInput.addEventListener('click', function(event) {
    if(versionsDropdown) {
      versionsDropdown.style.display = 'block';
    }
  });

  versionInput.addEventListener('input', () => {
    //filterFunction(versionInput, versionsDropdown);
  });

  versionInput.addEventListener('keyup', () => {
  });

  versionsDropdown.addEventListener('mousedown', function(event) {
    event.preventDefault();
  });

  versionsDropdown.addEventListener('mouseup', function(event) {
    event.preventDefault();
  });

  addDropdownItemEventListeners(versionsDropdown, versionInput);
}

function addDropdownItemEventListeners(dropdown: HTMLElement, input: HTMLInputElement) {
  const items = dropdown.getElementsByClassName('dropdown-item');

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as HTMLElement;
    item.addEventListener('click', () => {
      input.value = item.getAttribute('data-label') || '';
      input.setAttribute('data-value', item.getAttribute('data-value') || '');
      input.dispatchEvent(new Event('input'));
      dropdown.style.display = 'none';
    });
  }
}

function filterFunction(input: HTMLInputElement, dropdown: HTMLElement) {
  const filter = input.value.toUpperCase();
  const items = dropdown.getElementsByClassName('dropdown-item');

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as HTMLElement;
    const textValue = item.textContent || item.innerText;
    if (textValue.toUpperCase().indexOf(filter) > -1) {
      item.style.display = '';
    } else {
      item.style.display = 'none';
    }
  }
}

function getListSelectedToolchains(): string {
  const tCheckboxes = document.getElementsByClassName('toolchain-checkbox') as HTMLCollectionOf<Checkbox>;
  let listTools : string[] = [];
  for(let tCheckbox of tCheckboxes) {
    if(tCheckbox.getAttribute('current-checked') === 'true') {
      console.log(tCheckbox);
      listTools.push(`${tCheckbox.value}`);
    }
  }
  return listTools.join(' ');
}