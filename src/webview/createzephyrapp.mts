import {
  Button, Dropdown, RadioGroup, TextField, allComponents,
  provideVSCodeDesignSystem
} from "@vscode/webview-ui-toolkit/";

provideVSCodeDesignSystem().register(
  allComponents
);

const webviewApi = acquireVsCodeApi();

window.addEventListener("load", main);

function main() {

  setVSCodeMessageListener();

  const listWorkspaces = document.getElementById('listWorkspaces') as Dropdown;
  const workspaceInput = document.getElementById('workspaceInput') as HTMLInputElement;
  const sdkInput = document.getElementById('sdkInput') as HTMLInputElement;
  const workspaceDropdown = document.getElementById('workspaceDropdown') as HTMLElement;
  const sdkDropdown = document.getElementById('sdkDropdown') as HTMLElement;

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
  const appTypeGroup = document.getElementById('appTypeGroup') as RadioGroup;
  const createOnlyElems = document.querySelectorAll<HTMLElement>('.create-only');
  const advancedDetails = document.querySelector('.advanced-options') as HTMLDetailsElement | null;
  const advancedArrow = document.querySelector('.advanced-arrow') as HTMLElement | null;


  if (listWorkspaces && boardDropdown && samplesDropdown) {
    listWorkspaces.addEventListener('change', (event: Event) => {
      const selectedWorkspace = (event.target as HTMLSelectElement).value;
      westWorkspaceChanged(selectedWorkspace);
    });
  }

  workspaceInput.addEventListener('focusin', function () {
    if (workspaceDropdown) {
      workspaceDropdown.style.display = 'block';
    }
  });

  workspaceInput.addEventListener('focusout', function () {
    if (workspaceDropdown) {
      workspaceDropdown.style.display = 'none';
    }
  });

  workspaceInput.addEventListener('click', function (event) {
    if (workspaceDropdown) {
      workspaceDropdown.style.display = 'block';
    }
  });

  workspaceInput.addEventListener('input', () => {
    westWorkspaceChanged(workspaceInput.getAttribute('data-value') as string);
  });

  workspaceInput.addEventListener('keyup', () => {
    filterFunction(workspaceInput, workspaceDropdown);
  });

  workspaceDropdown.addEventListener('mousedown', function (event) {
    event.preventDefault();
  });

  workspaceDropdown.addEventListener('mouseup', function (event) {
    event.preventDefault();
  });

  addDropdownItemEventListeners(workspaceDropdown, workspaceInput);

  sdkInput.addEventListener('focusin', function () {
    if (sdkDropdown) {
      sdkDropdown.style.display = 'block';
    }
  });

  sdkInput.addEventListener('focusout', function () {
    if (sdkDropdown) {
      sdkDropdown.style.display = 'none';
    }
  });

  sdkInput.addEventListener('click', function (event) {
    if (sdkDropdown) {
      sdkDropdown.style.display = 'block';
    }
  });

  sdkInput.addEventListener('keyup', () => {
    filterFunction(sdkInput, sdkDropdown);
  });

  sdkDropdown.addEventListener('mousedown', function (event) {
    event.preventDefault();
  });

  sdkDropdown.addEventListener('mouseup', function (event) {
    event.preventDefault();
  });

  addDropdownItemEventListeners(sdkDropdown, sdkInput);


  boardInput.addEventListener('focusin', function () {
    if (boardDropdown) {
      boardDropdown.style.display = 'block';
    }
    const samplesDropdown = document.getElementById('samplesDropdown') as HTMLElement;
    if (samplesDropdown) {
      samplesDropdown.style.display = 'none';
    }
  });

  boardInput.addEventListener('focusout', function () {
    if (boardDropdown) {
      boardDropdown.style.display = 'none';
    }
  });

  boardInput.addEventListener('click', function (event) {
    if (boardDropdown) {
      boardDropdown.style.display = 'block';
    }
    const samplesDropdown = document.getElementById('samplesDropdown') as HTMLElement;
    if (samplesDropdown) {
      samplesDropdown.style.display = 'none';
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

  boardDropdown.addEventListener('mousedown', function (event) {
    event.preventDefault();
  });

  boardDropdown.addEventListener('mouseup', function (event) {
    event.preventDefault();
  });

  sampleInput.addEventListener('focusin', function () {
    if (samplesDropdown) {
      samplesDropdown.style.display = 'block';
    }
    const boardDropdown = document.getElementById('boardDropdown') as HTMLElement;
    if (boardDropdown) {
      boardDropdown.style.display = 'none';
    }
  });

  sampleInput.addEventListener('focusout', function () {
    if (samplesDropdown) {
      samplesDropdown.style.display = 'none';
    }
  });

  sampleInput.addEventListener('click', function (event) {
    if (samplesDropdown) {
      samplesDropdown.style.display = 'block';
    }
    const boardDropdown = document.getElementById('boardDropdown') as HTMLElement;
    if (boardDropdown) {
      boardDropdown.style.display = 'none';
    }
  });

  sampleInput.addEventListener('keyup', () => {
    filterFunction(sampleInput, samplesDropdown);
  });

  sampleInput.addEventListener('input', () => {
    projectNameText.value = sampleInput.value || '';
  });

  samplesDropdown.addEventListener('mousedown', function (event) {
    event.preventDefault();
  });

  samplesDropdown.addEventListener('mouseup', function (event) {
    event.preventDefault();
  });

  document.addEventListener('click', function (event: MouseEvent) {
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
  boardDropdownSpinner.style.visibility = 'hidden';
  samplesDropdownSpinner.style.display = 'none';
  samplesDropdownSpinner.style.visibility = 'hidden';

  browseParentButton.addEventListener("click", browseParentHandler);
  createButton.addEventListener("click", createHandler);

  const refreshCreateOnlyRows = () => {
    const show = appTypeGroup.value === 'create';
    createOnlyElems.forEach(el => (el.style.display = show ? '' : 'none'));
  };

  appTypeGroup.addEventListener('change', refreshCreateOnlyRows);
  refreshCreateOnlyRows();        // call once on load

  if (advancedDetails && advancedArrow) {
    const syncAdvancedArrow = () => {
      const isOpen = advancedDetails.open;
      advancedArrow.classList.toggle('codicon-chevron-right', !isOpen);
      advancedArrow.classList.toggle('codicon-chevron-down', isOpen);
    };
    advancedDetails.addEventListener('toggle', syncAdvancedArrow);
    syncAdvancedArrow();
  }
}

function addDropdownItemEventListeners(dropdown: HTMLElement,
  input: HTMLInputElement) {

  Array.from(dropdown.getElementsByClassName("dropdown-item"))
    .forEach(itemEl => {
      const item = itemEl as HTMLElement;

      item.addEventListener("pointerdown", () => {
        /* common fields */
        const value = item.dataset.value ?? "";
        const label = item.dataset.label ?? "";

        /* Zephyr SDK or IAR – same visual behaviour */
        input.value = label;
        input.setAttribute("data-value", value);
        input.dispatchEvent(new Event("input"));
        dropdown.style.display = "none";
      });
    });
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
  const boardInput = document.getElementById('boardInput') as HTMLInputElement;
  const boardDropdown = document.getElementById('boardDropdown') as HTMLElement;
  const sampleInput = document.getElementById('sampleInput') as HTMLInputElement;
  const samplesDropdown = document.getElementById('samplesDropdown') as HTMLElement;
  
  if (boardInput) {
    boardInput.disabled = true;
  }
  if (boardDropdown) {
    boardDropdown.style.display = 'none';
  }
  if (sampleInput) {
    sampleInput.disabled = true;
  }
  if (samplesDropdown) {
    samplesDropdown.style.display = 'none';
  }
  boardDropdownSpinner.style.display = 'block';
  boardDropdownSpinner.style.visibility = 'visible';
  samplesDropdownSpinner.style.display = 'block';
  samplesDropdownSpinner.style.visibility = 'visible';
}

async function updateBoardDropdown(boardHTML: string) {
  const boardInput = document.getElementById('boardInput') as HTMLInputElement;
  const boardDropdown = document.getElementById('boardDropdown') as HTMLElement;
  const boardDropdownSpinner = document.getElementById('boardDropdownSpinner') as HTMLElement;

  boardInput.disabled = true;
  boardDropdown.style.display = 'none';
  boardDropdownSpinner.style.display = 'block';
  boardDropdownSpinner.style.visibility = 'visible';

  await new Promise(resolve => setTimeout(resolve, 300)); 

  boardDropdown.innerHTML = boardHTML;
  addDropdownItemEventListeners(boardDropdown, boardInput);

  boardDropdownSpinner.style.display = 'none';
  boardDropdownSpinner.style.visibility = 'hidden';
  boardDropdown.style.display = 'block';
  boardInput.disabled = false;
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

  sampleInput.disabled = true;
  samplesDropdown.style.display = 'none';
  samplesDropdownSpinner.style.display = 'block';
  samplesDropdownSpinner.style.visibility = 'visible';

  await new Promise(resolve => setTimeout(resolve, 300));

  samplesDropdown.innerHTML = samplesHTML;
  addDropdownItemEventListeners(samplesDropdown, sampleInput);

  samplesDropdownSpinner.style.display = 'none';
  samplesDropdownSpinner.style.visibility = 'hidden';
  samplesDropdown.style.display = 'none';
  sampleInput.disabled = false;
}

function setVSCodeMessageListener() {
  window.addEventListener("message", (event) => {
    const command = event.data.command;
    switch (command) {
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
  const workspaceInput = document.getElementById('workspaceInput') as HTMLInputElement;
  const sdkInput = document.getElementById('sdkInput') as HTMLInputElement;
  const boardInput = document.getElementById('boardInput') as HTMLInputElement;
  const sampleInput = document.getElementById('sampleInput') as HTMLInputElement;
  const projectNameText = document.getElementById("projectName") as TextField;
  const projectParentPathText = document.getElementById("projectParentPath") as TextField;
  const pristineRadioGroup = document.getElementById("pristineMode") as RadioGroup;
  const appTypeGroup = document.getElementById('appTypeGroup') as RadioGroup;
  const venvRadioGroup = document.getElementById('venvMode') as RadioGroup;
  const debugPresetCheckbox = document.getElementById('debugPresetCheckbox') as HTMLInputElement | null;

  webviewApi.postMessage(
    {
      command:            "create",
      appType:            appTypeGroup.value,
      westWorkspacePath:  workspaceInput.getAttribute("data-value"),
      zephyrSdkPath:      sdkInput.getAttribute("data-value"),
      boardYamlPath: boardInput.getAttribute('data-value'),
      samplePath: sampleInput.getAttribute('data-value'),
      projectName: projectNameText.value,
      projectParentPath: projectParentPathText.value,
      pristine: pristineRadioGroup.value,
      venv: venvRadioGroup?.value ?? 'global',
      debugPreset: !!debugPresetCheckbox?.checked,
    }
  );
}

function browseParentHandler(this: HTMLElement, ev: MouseEvent) {
  const workspaceInput = document.getElementById('workspaceInput') as HTMLInputElement;
  webviewApi.postMessage(
    {
      command: 'openLocationDialog',
      westWorkspacePath: workspaceInput.getAttribute('data-value')
    }
  );
}
