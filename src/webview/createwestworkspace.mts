import { Button, RadioGroup, TextField, allComponents,
  provideVSCodeDesignSystem } from "@vscode/webview-ui-toolkit/";

provideVSCodeDesignSystem().register(
  allComponents
);

const webviewApi = acquireVsCodeApi();

window.addEventListener("load", main);

function main() {

  setVSCodeMessageListener();

  const srcTypeRadioGroup = document.getElementById("srcType") as RadioGroup;
  const remotePathText = document.getElementById('remotePath') as TextField;

  srcTypeRadioGroup.addEventListener("click", modifySrcTypeHandler);
  srcTypeRadioGroup.addEventListener("select", modifySrcTypeHandler);
  srcTypeRadioGroup.dispatchEvent(new Event('select'));

  initTemplatesDropdown();
  initBranchDropdown();

  remotePathText.addEventListener('change', function() {
    console.log(remotePathText.value);
    remotePathChanged(remotePathText.value);
  });

  const browseLocationButton = document.getElementById("browseLocationButton") as Button;
  browseLocationButton?.addEventListener("click", browseLocationHandler);

  const browseManifestButton = document.getElementById("browseManifestButton") as Button;
  browseManifestButton?.addEventListener("click", browseManifestHandler);

  const importButton = document.getElementById("importButton") as Button;
  importButton?.addEventListener("click", createHandler);

  // Initialize branch values
  remotePathChanged(remotePathText.value);
}

function initBranchDropdown() {
  const branchInput = document.getElementById('branchInput') as HTMLInputElement;
  const branchDropdown = document.getElementById('branchDropdown') as HTMLElement;

  branchInput.addEventListener('focusin', function() {
    if(branchDropdown) {
      branchDropdown.style.display = "block";
    }
  });

  branchInput.addEventListener('focusout', function() {
    if(branchDropdown) {
      branchDropdown.style.display = "none";
    }
  });

  branchInput.addEventListener('click', function(event) {
    if(branchDropdown) {
      branchDropdown.style.display = "block";
    }
  });

  branchInput.addEventListener('keyup', () => {
    filterFunction(branchInput, branchDropdown);
  });

  branchDropdown.addEventListener('mousedown', function(event) {
    event.preventDefault();
  });

  branchDropdown.addEventListener('mouseup', function(event) {
    event.preventDefault();
  });

  document.addEventListener('click', function(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (target && !target.closest('.combo-dropdown')) {
      if (branchDropdown) {
        (branchDropdown as HTMLElement).style.display = "none";
      }
    }
  });
  
  const rootStyles = getComputedStyle(document.documentElement);
  const elements = document.querySelectorAll<HTMLDivElement>(".combo-dropdown-control:disabled");
  elements.forEach(element => {
    const bgColor = rootStyles.getPropertyValue('--input-background').trim();
    const textColor = rootStyles.getPropertyValue('--input-foreground').trim();
    const borderColor = rootStyles.getPropertyValue('--dropdown-border').trim();
    console.log(element);
    console.log(bgColor);

    element.style.backgroundColor = hexToRgba(bgColor, 0.3);
    element.style.color = hexToRgba(textColor, 0.3);
    element.style.borderColor = hexToRgba(borderColor, 0.3);
  });
}

function initTemplatesDropdown() {
  const templateInput = document.getElementById('templateInput') as HTMLInputElement;
  const templatesDropdown = document.getElementById('templatesDropdown') as HTMLElement;
  
  templateInput.addEventListener('focusin', function() {
    if(templatesDropdown) {
      templatesDropdown.style.display = 'block';
    }
  });

  templateInput.addEventListener('focusout', function() {
    if(templatesDropdown) {
      templatesDropdown.style.display = 'none';
    }
  });

  templateInput.addEventListener('click', function(event) {
    if(templatesDropdown) {
      templatesDropdown.style.display = 'block';
    }
  });

  templateInput.addEventListener('input', () => {
    webviewApi.postMessage(
      { 
        command: 'templateChanged',
        template: templateInput.getAttribute('data-value'),
      }
    );
  });

  templateInput.addEventListener('keyup', () => {
    filterFunction(templateInput, templatesDropdown);
  });

  templatesDropdown.addEventListener('mousedown', function(event) {
    event.preventDefault();
  });

  templatesDropdown.addEventListener('mouseup', function(event) {
    event.preventDefault();
  });

  addDropdownItemEventListeners(templatesDropdown, templateInput);

  // Select "STM32" as default value (hal_stm32)
  const defaultItem = templatesDropdown.querySelector(`.dropdown-item[data-value="hal_stm32"]`) as HTMLElement;
  if (defaultItem) {
    defaultItem.click();
  }
}

function hexToRgba(hex: string, alpha: number): string {
  let r = 0, g = 0, b = 0;
  if (hex.length == 4) {
    r = parseInt(hex[1] + hex[1], 16);
    g = parseInt(hex[2] + hex[2], 16);
    b = parseInt(hex[3] + hex[3], 16);
  } else if (hex.length == 7) {
    r = parseInt(hex[1] + hex[2], 16);
    g = parseInt(hex[3] + hex[4], 16);
    b = parseInt(hex[5] + hex[6], 16);
  }
  return `rgba(${r},${g},${b},${alpha})`;
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
      item.style.display = "none";
    }
  }
}

function setVSCodeMessageListener() {
  window.addEventListener("message", (event) => {
    const command = event.data.command;

    switch(command) {
      case 'folderSelected':
        setLocalPath(event.data.id, event.data.folderUri);
        break;
     case 'manifestSelected':
        setLocalPath(event.data.id, event.data.fileUri);
        break;
     case 'updateBranchDropdown':
        updateBranchDropdown(event.data.branchHTML, event.data.branch);
        break;
    }
  });
}

async function remotePathChanged(remotePath: string) {
  webviewApi.postMessage(
    { 
      command: 'remotePathChanged',
      remotePath: remotePath
    }
  );
}

function setLocalPath(id: string, path: string) {
  const localPath = document.getElementById(id) as TextField;
  localPath.value = path;
}

async function updateBranchDropdown(branchHTML: string, branch: string) {
  const branchInput = document.getElementById('branchInput') as HTMLInputElement;
  const branchDropdown = document.getElementById('branchDropdown') as HTMLElement;

  branchInput.value = branch;
  branchDropdown.innerHTML = branchHTML;
  addDropdownItemEventListeners(branchDropdown, branchInput);
}



function addDropdownItemEventListeners(dropdown: HTMLElement, input: HTMLInputElement) {
  const items = dropdown.getElementsByClassName('dropdown-item');

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as HTMLElement;
    item.addEventListener('click', () => {
      input.value = item.getAttribute('data-label') || '';
      input.setAttribute('data-value', item.getAttribute('data-value') || '');
      input.dispatchEvent(new Event('input'));
      dropdown.style.display = "none";
    });
  }
}

function modifySrcTypeHandler(this: HTMLElement) {
  const srcTypeRadioGroup = document.getElementById("srcType") as RadioGroup;
  const srcRemotePath = document.getElementById("remotePath") as TextField;
  const srcRemoteBranch = document.getElementById("branchInput") as TextField;
  const manifestPath = document.getElementById("manifestPath") as TextField;
  const browseManifestButton = document.getElementById("browseManifestButton") as Button;

  const templatesGroup = document.getElementById("templatesGroup") as HTMLDivElement;
  const srcRemoteBranchGroup = document.getElementById("branchGroup") as HTMLDivElement;
  const manifestGroup = document.getElementById("manifestGroup") as HTMLDivElement;

  // Enable/Disable form section depending on user choice
  if(srcTypeRadioGroup.value === 'remote') {
    srcRemotePath.removeAttribute('disabled');
    srcRemotePath.value = "https://github.com/zephyrproject-rtos/zephyr";
    srcRemoteBranch.removeAttribute('disabled');
    manifestPath.removeAttribute('disabled');
    manifestPath.setAttribute('placeholder', '(Optional)'),
    browseManifestButton.removeAttribute('disabled');

    templatesGroup.style.display = "none";
    srcRemotePath.style.display = "block";
    srcRemoteBranchGroup.style.display = "block";
    manifestGroup.style.display = "block";
  } else if(srcTypeRadioGroup.value === 'local') {
    srcRemotePath.setAttribute('disabled', '');
    srcRemoteBranch.setAttribute('disabled', '');
    manifestPath.setAttribute('disabled', '');
    browseManifestButton.setAttribute('disabled', '');

    templatesGroup.style.display = "none";
    srcRemotePath.style.display = "none";
    srcRemoteBranchGroup.style.display = "none";
    manifestGroup.style.display = "none";
  } else if(srcTypeRadioGroup.value === 'manifest') {
    srcRemotePath.setAttribute('disabled', '');
    srcRemoteBranch.setAttribute('disabled', '');
    manifestPath.removeAttribute('disabled');
    manifestPath.setAttribute('placeholder', ''),
    browseManifestButton.removeAttribute('disabled');

    templatesGroup.style.display = "none";
    srcRemotePath.style.display = "none";
    srcRemoteBranchGroup.style.display = "none";
    manifestGroup.style.display  = "block";
  } else if(srcTypeRadioGroup.value === 'template') {
    srcRemotePath.value = "https://github.com/zephyrproject-rtos";
    templatesGroup.style.display = "block";
    srcRemotePath.style.display = "block";
    srcRemoteBranchGroup.style.display = "block";
    manifestGroup.style.display  = "none";
  }
}

function browseLocationHandler(this: HTMLElement, ev: MouseEvent) {
  webviewApi.postMessage(
    { 
      command: 'openLocationDialog', 
    }
  );
}

function browseManifestHandler(this: HTMLElement, ev: MouseEvent) {
  webviewApi.postMessage(
    { 
      command: 'openManifestDialog', 
    }
  );
}

function browseFolderHandler(this: HTMLElement, ev: MouseEvent) {
  webviewApi.postMessage(
    { 
      command: 'openFolderDialog', 
    }
  );
}

function createHandler(this: HTMLElement, ev: MouseEvent) {
  const srcTypeRadioGroup = document.getElementById("srcType") as RadioGroup;
  const srcRemotePath = document.getElementById("remotePath") as TextField;
  const srcRemoteBranch = document.getElementById("branchInput") as TextField;
  const templateInput = document.getElementById("templateInput") as TextField;
  const manifestPath = document.getElementById("manifestPath") as TextField;
  const workspacePath = document.getElementById("workspacePath") as TextField;
  
  webviewApi.postMessage(
    {
      command: 'create',
      srcType: srcTypeRadioGroup.value,
      remotePath: srcRemotePath.value,
      remoteBranch: srcRemoteBranch.value,
      templateHal: templateInput.getAttribute('data-value'),
      manifestPath: manifestPath.value,
      workspacePath: workspacePath.value,
    }
  );
}



