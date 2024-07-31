import { Button, Dropdown, TextField, allComponents,
  provideVSCodeDesignSystem } from "@vscode/webview-ui-toolkit/";

provideVSCodeDesignSystem().register(
  allComponents
);

const webviewApi = acquireVsCodeApi();

window.addEventListener("load", main);

function main() {

  setVSCodeMessageListener();

  const listWorkspaces = document.getElementById('listWorkspaces') as Dropdown;
  const boardInput = document.getElementById('boardInput') as HTMLInputElement;
  const sampleInput = document.getElementById('sampleInput') as HTMLInputElement;
  const boardDropdown = document.getElementById('boardDropdown') as HTMLElement;
  const samplesDropdown = document.getElementById('samplesDropdown') as HTMLElement;
  const boardDropdownSpinner = document.getElementById('boardDropdownSpinner') as HTMLElement;
  const samplesDropdownSpinner = document.getElementById('samplesDropdownSpinner') as HTMLElement;
  const projectNameText = document.getElementById("projectName") as TextField;
  const browseParentButton = document.getElementById("browseParentButton") as Button;
  const boardImage = document.getElementById('boardImg') as HTMLImageElement;
  const createButton = document.getElementById("createButton") as Button;

  if (listWorkspaces && boardDropdown && samplesDropdown) {
    listWorkspaces.addEventListener('change', (event: Event) => {
      const selectedWorkspace = (event.target as HTMLSelectElement).value;
      westWorkspaceChanged(selectedWorkspace);
    });
  }

  boardInput.addEventListener('focusin', function() {
    if(boardDropdown) {
      boardDropdown.style.display = 'block';
    }
  });

  boardInput.addEventListener('focusout', function() {
    if(boardDropdown) {
      boardDropdown.style.display = 'none';
    }
  });

  boardInput.addEventListener('click', function(event) {
    if(boardDropdown) {
      boardDropdown.style.display = 'block';
    }
  });

  boardInput.addEventListener('keyup', () => {
    filterFunction(boardInput, boardDropdown);
  });

  boardInput.addEventListener('input', () => {
    webviewApi.postMessage(
      { 
        command: 'boardChanged',
        workspace: listWorkspaces.value,
        boardYamlPath: boardInput.getAttribute('data-value')
      }
    );
  });

  boardDropdown.addEventListener('mousedown', function(event) {
    event.preventDefault();
  });

  boardDropdown.addEventListener('mouseup', function(event) {
    event.preventDefault();
  });

  sampleInput.addEventListener('focusin', function() {
    if(samplesDropdown) {
      samplesDropdown.style.display = 'block';
    }
  });

  sampleInput.addEventListener('focusout', function() {
    if(samplesDropdown) {
      samplesDropdown.style.display = 'none';
    }
  });

  sampleInput.addEventListener('click', function(event) {
    if(samplesDropdown) {
      samplesDropdown.style.display = 'block';
    }
  });

  sampleInput.addEventListener('keyup', () => {
    filterFunction(sampleInput, samplesDropdown);
  });

  sampleInput.addEventListener('input', () => {
    if(projectNameText.value.length === 0) {
      projectNameText.value = sampleInput.textContent || '';
    }
  });

  samplesDropdown.addEventListener('mousedown', function(event) {
    event.preventDefault();
  });

  samplesDropdown.addEventListener('mouseup', function(event) {
    event.preventDefault();
  });

  document.addEventListener('click', function(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (target && !target.closest('.combo-dropdown')) {
      if (boardDropdown) {
        (boardDropdown as HTMLElement).style.display = 'none';
      }

      if (samplesDropdown) {
        (samplesDropdown as HTMLElement).style.display = 'none';
      }
    }
  });

  // Hide the board image and spinner on load
  boardImage.style.visibility = 'hidden';
  boardImage.style.display = 'none';
  boardDropdownSpinner.style.display = 'none';
  samplesDropdownSpinner.style.display = 'none';

  browseParentButton.addEventListener("click", browseParentHandler);
  createButton.addEventListener("click", createHandler);
  
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

async function westWorkspaceChanged(selectedWorkspaceUri: string) {
  webviewApi.postMessage(
    { 
      command: 'westWorkspaceChanged',
      workspace: selectedWorkspaceUri
    }
  );

  const boardDropdownSpinner = document.getElementById('boardDropdownSpinner') as HTMLElement;
  const samplesDropdownSpinner = document.getElementById('samplesDropdownSpinner') as HTMLElement;
  boardDropdownSpinner.style.display = 'block'; 
  samplesDropdownSpinner.style.display = 'block'; 
}

async function updateBoardDropdown(boardHTML: string) {
  const boardInput = document.getElementById('boardInput') as HTMLInputElement;
  const boardDropdown = document.getElementById('boardDropdown') as HTMLElement;
  const boardDropdownSpinner = document.getElementById('boardDropdownSpinner') as HTMLElement;
  boardDropdown.innerHTML = boardHTML;
  addDropdownItemEventListeners(boardDropdown, boardInput);
  boardDropdownSpinner.style.display = 'none'; 

}

function updateBoardImage(imgSrc: string) {
  const boardImage = document.getElementById('boardImg') as HTMLImageElement;
  if (imgSrc && imgSrc !== 'noImg') {
    boardImage.src = imgSrc;
    boardImage.style.visibility = 'visible';
    boardImage.style.display = 'block'; 
  } else {
    boardImage.src = '';
    boardImage.style.visibility = 'hidden';
    boardImage.style.display = 'none';
  }
}

async function updateSamplesDropdown(samplesHTML: string) {
  const samplesDropdown = document.getElementById('samplesDropdown') as HTMLElement;
  const sampleInput = document.getElementById('sampleInput') as HTMLInputElement;
  const samplesDropdownSpinner = document.getElementById('samplesDropdownSpinner') as HTMLElement;
  samplesDropdown.innerHTML = samplesHTML;
  addDropdownItemEventListeners(samplesDropdown, sampleInput);
  samplesDropdownSpinner.style.display = 'none'; 
}

function setVSCodeMessageListener() {
  window.addEventListener("message", (event) => {
    const command = event.data.command;
    switch(command) {
      case 'folderSelected':
        setLocalPath(event.data.id, event.data.folderUri);
        break;
      case 'updateBoardDropdown':
        updateBoardDropdown(event.data.boardHTML);
        break;
      case 'updateSamplesDropdown':
        updateSamplesDropdown(event.data.samplesHTML);
        break;
      case 'updateBoardImage':
        updateBoardImage(event.data.imgPath);
        break;
    }

  });
}

function setLocalPath(id: string, path: string) {
  const localPath = document.getElementById(id) as TextField;
  localPath.value = path;
}

function createHandler(this: HTMLElement, ev: MouseEvent) {
  const listWorkspaces = document.getElementById('listWorkspaces') as Dropdown;
  const listSDKs = document.getElementById('listSDKs') as Dropdown;
  const boardInput = document.getElementById('boardInput') as HTMLInputElement;
  const sampleInput = document.getElementById('sampleInput') as HTMLInputElement;
  const projectNameText = document.getElementById("projectName") as TextField;
  const projectParentPathText = document.getElementById("projectParentPath") as TextField;
  
  webviewApi.postMessage(
    {
      command: 'create',
      westWorkspacePath: listWorkspaces.value,
      zephyrsdkPath: listSDKs.value,
      boardYamlPath: boardInput.getAttribute('data-value'),
      samplePath: sampleInput.getAttribute('data-value'),
      projectName: projectNameText.value,
      projectParentPath: projectParentPathText.value,
    }
  );
}

function browseParentHandler(this: HTMLElement, ev: MouseEvent) {
  webviewApi.postMessage(
    { 
      command: 'openLocationDialog', 
    }
  );
}

