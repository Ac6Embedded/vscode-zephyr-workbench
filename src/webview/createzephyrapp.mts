import {
  Button, RadioGroup, TextField, allComponents,
  provideVSCodeDesignSystem
} from "@vscode/webview-ui-toolkit/";

provideVSCodeDesignSystem().register(
  allComponents
);

const webviewApi = acquireVsCodeApi();
let currentWorkspaceRequestId = 0;

type DiscoveryTarget = 'board' | 'sample';

const discoveryTargets = {
  board: {
    inputId: 'boardInput',
    dropdownId: 'boardDropdown',
    spinnerId: 'boardDropdownSpinner',
    statusId: 'boardStatus',
    emptyMessage: 'No boards were found for this workspace.',
  },
  sample: {
    inputId: 'sampleInput',
    dropdownId: 'samplesDropdown',
    spinnerId: 'samplesDropdownSpinner',
    statusId: 'sampleStatus',
    emptyMessage: 'No sample or test projects were found for this workspace.',
  },
} as const;

window.addEventListener("load", main);

function main() {

  setVSCodeMessageListener();

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
  const appFromGroup = document.getElementById('appFromGroup') as RadioGroup;
  const createOnlyElems = document.querySelectorAll<HTMLElement>('.create-only');
  const advancedDetails = document.querySelector('.advanced-options') as HTMLDetailsElement | null;
  const advancedArrow = document.querySelector('.advanced-arrow') as HTMLElement | null;

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
    clearSelectedValueIfEdited(workspaceInput);
    westWorkspaceChanged(workspaceInput.getAttribute('data-value') ?? '');
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

  sdkInput.addEventListener('input', () => {
    clearSelectedValueIfEdited(sdkInput);
    updateToolchainVariantVisibility();
  });

  sdkDropdown.addEventListener('mousedown', function (event) {
    event.preventDefault();
  });

  sdkDropdown.addEventListener('mouseup', function (event) {
    event.preventDefault();
  });

  addDropdownItemEventListeners(sdkDropdown, sdkInput);
  updateToolchainVariantVisibility();


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
    clearSelectedValueIfEdited(boardInput);
    webviewApi.postMessage(
      {
        command: 'boardChanged',
        boardYamlPath: boardInput.getAttribute('data-value') ?? ''
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
    clearSelectedValueIfEdited(sampleInput);
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
  resetWorkspaceDiscoveryControls();

  browseParentButton.addEventListener("click", browseParentHandler);
  createButton.addEventListener("click", createHandler);

  const refreshCreateOnlyRows = () => {
    const show = appFromGroup.value === 'create';
    createOnlyElems.forEach(el => (el.style.display = show ? '' : 'none'));
  };

  appFromGroup.addEventListener('change', refreshCreateOnlyRows);
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
        input.setAttribute("data-selected-label", label);
        const hasLlvm = item.dataset.hasLlvm ?? "";
        if (hasLlvm) {
          input.setAttribute("data-has-llvm", hasLlvm);
        } else {
          input.removeAttribute("data-has-llvm");
        }
        const boardIdentifier = item.dataset.boardIdentifier ?? "";
        if (boardIdentifier) {
          input.setAttribute("data-board-identifier", boardIdentifier);
        } else {
          input.removeAttribute("data-board-identifier");
        }
        input.dispatchEvent(new Event("input"));
        dropdown.style.display = "none";
      });
    });
}

function clearSelectedValueIfEdited(input: HTMLInputElement) {
  const selectedLabel = input.getAttribute('data-selected-label') ?? '';
  if (selectedLabel.length > 0 && input.value !== selectedLabel) {
    input.setAttribute('data-value', '');
    input.setAttribute('data-selected-label', '');
    input.removeAttribute('data-has-llvm');
    input.removeAttribute('data-board-identifier');
  }
}

function resetComboInput(input: HTMLInputElement) {
  input.value = '';
  input.setAttribute('data-value', '');
  input.setAttribute('data-selected-label', '');
  input.removeAttribute('data-has-llvm');
  input.removeAttribute('data-board-identifier');
}

function updateToolchainVariantVisibility() {
  const sdkInput = document.getElementById('sdkInput') as HTMLInputElement;
  const toolchainVariantRow = document.getElementById('toolchainVariantRow') as HTMLElement | null;
  const toolchainVariantGroup = document.getElementById('toolchainVariantGroup') as RadioGroup | null;
  if (!toolchainVariantRow || !toolchainVariantGroup) {
    return;
  }

  const hasLlvm = sdkInput.getAttribute('data-has-llvm') === 'true';
  toolchainVariantRow.style.display = hasLlvm ? '' : 'none';
  if (!hasLlvm) {
    toolchainVariantGroup.value = 'zephyr';
  }
}

function filterFunction(input: HTMLInputElement, dropdown: HTMLElement) {
  const filter = input.value.toUpperCase();
  const items = dropdown.getElementsByClassName('dropdown-item');
  const headers = dropdown.getElementsByClassName('dropdown-header');

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as HTMLElement;
    const textValue = item.textContent || item.innerText;
    if (textValue.toUpperCase().indexOf(filter) > -1) {
      item.style.display = '';
    } else {
      item.style.display = 'none';
    }
  }

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i] as HTMLElement;
    let nextElement = header.nextElementSibling;
    let hasVisibleItems = false;

    while (nextElement && !nextElement.classList.contains('dropdown-header')) {
      if (nextElement.classList.contains('dropdown-item')) {
        const itemElement = nextElement as HTMLElement;
        if (itemElement.style.display !== 'none') {
          hasVisibleItems = true;
          break;
        }
      }
      nextElement = nextElement.nextElementSibling;
    }

    header.style.display = hasVisibleItems ? '' : 'none';
  }
}


async function westWorkspaceChanged(selectedWorkspaceUri: string) {
  currentWorkspaceRequestId += 1;
  const requestId = currentWorkspaceRequestId;

  if (!selectedWorkspaceUri) {
    resetWorkspaceDiscoveryControls();
    return;
  }

  setDiscoveryLoadingState('board', 'Loading boards...');
  setDiscoveryLoadingState('sample', 'Loading sample and test projects...');
  updateBoardImage('noImg');

  webviewApi.postMessage(
    {
      command: 'westWorkspaceChanged',
      workspace: selectedWorkspaceUri,
      requestId,
    }
  );
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

function getDiscoveryElements(target: DiscoveryTarget) {
  const config = discoveryTargets[target];
  return {
    input: document.getElementById(config.inputId) as HTMLInputElement,
    dropdown: document.getElementById(config.dropdownId) as HTMLElement,
    spinner: document.getElementById(config.spinnerId) as HTMLElement,
    status: document.getElementById(config.statusId) as HTMLElement,
    emptyMessage: config.emptyMessage,
  };
}

function setDiscoveryStatus(target: DiscoveryTarget, message: string, tone: 'info' | 'error' = 'info') {
  const { status } = getDiscoveryElements(target);
  status.textContent = message;
  status.classList.toggle('error', tone === 'error');
  status.hidden = message.length === 0;
}

function resetDiscoveryState(target: DiscoveryTarget, message: string) {
  const { input, dropdown, spinner } = getDiscoveryElements(target);
  resetComboInput(input);
  input.disabled = true;
  dropdown.innerHTML = '';
  dropdown.style.display = 'none';
  spinner.style.display = 'none';
  spinner.style.visibility = 'hidden';
  setDiscoveryStatus(target, message);
}

function setDiscoveryLoadingState(target: DiscoveryTarget, message: string) {
  const { input, dropdown, spinner } = getDiscoveryElements(target);
  resetComboInput(input);
  input.disabled = true;
  dropdown.innerHTML = '';
  dropdown.style.display = 'none';
  spinner.style.display = 'block';
  spinner.style.visibility = 'visible';
  setDiscoveryStatus(target, message);
}

function setDiscoveryReadyState(target: DiscoveryTarget, html: string, message?: string) {
  const { input, dropdown, spinner, emptyMessage } = getDiscoveryElements(target);
  const hasItems = html.trim().length > 0;

  resetComboInput(input);
  dropdown.innerHTML = html;
  addDropdownItemEventListeners(dropdown, input);
  dropdown.style.display = 'none';
  spinner.style.display = 'none';
  spinner.style.visibility = 'hidden';
  input.disabled = !hasItems;
  setDiscoveryStatus(target, message ?? (hasItems ? '' : emptyMessage));
}

function setDiscoveryErrorState(target: DiscoveryTarget, message: string) {
  const { input, dropdown, spinner } = getDiscoveryElements(target);
  resetComboInput(input);
  input.disabled = true;
  dropdown.innerHTML = '';
  dropdown.style.display = 'none';
  spinner.style.display = 'none';
  spinner.style.visibility = 'hidden';
  setDiscoveryStatus(target, message, 'error');
}

function resetWorkspaceDiscoveryControls() {
  resetDiscoveryState('board', 'Choose a west workspace from the list to load boards.');
  resetDiscoveryState('sample', 'Choose a west workspace from the list to load sample and test projects.');
  updateBoardImage('noImg');
}

function applyDiscoveryState(
  requestId: number,
  target: DiscoveryTarget,
  status: 'ready' | 'error',
  html?: string,
  message?: string
) {
  if (requestId !== currentWorkspaceRequestId) {
    return;
  }

  if (status === 'ready') {
    setDiscoveryReadyState(target, html ?? '', message);
  } else {
    setDiscoveryErrorState(target, message ?? 'This list could not be loaded.');
  }
}

function setVSCodeMessageListener() {
  window.addEventListener("message", (event) => {
    const command = event.data.command;
    switch (command) {
      case 'folderSelected':
        setLocalPath(event.data.id, event.data.folderUri);
        break;
      case 'setDiscoveryState':
        applyDiscoveryState(
          event.data.requestId,
          event.data.target,
          event.data.status,
          event.data.html,
          event.data.message
        );
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
  const appFromGroup = document.getElementById('appFromGroup') as RadioGroup;
  const venvRadioGroup = document.getElementById('venvMode') as RadioGroup;
  const toolchainVariantGroup = document.getElementById('toolchainVariantGroup') as RadioGroup;
  const debugPresetCheckbox = document.getElementById('debugPresetCheckbox') as HTMLInputElement | null;

  webviewApi.postMessage(
    {
      command:            "create",
      appFrom:            appFromGroup.value,
      westWorkspaceRootPath: workspaceInput.getAttribute("data-value") ?? '',
      zephyrSdkPath:      sdkInput.getAttribute("data-value") ?? '',
      toolchainVariant:   sdkInput.getAttribute("data-has-llvm") === 'true'
        ? toolchainVariantGroup.value
        : 'zephyr',
      boardYamlPath:      boardInput.getAttribute('data-value') ?? '',
      boardIdentifier:    boardInput.getAttribute('data-board-identifier') ?? '',
      samplePath:         sampleInput.getAttribute('data-value') ?? '',
      projectName:        projectNameText.value,
      projectParentPath:  projectParentPathText.value,
      pristine:           pristineRadioGroup.value,
      venv:               venvRadioGroup?.value ?? 'global',
      debugPreset:        !!debugPresetCheckbox?.checked,
    }
  );
}

function browseParentHandler(this: HTMLElement, ev: MouseEvent) {
  const workspaceInput = document.getElementById('workspaceInput') as HTMLInputElement;
  webviewApi.postMessage(
    {
      command: 'openLocationDialog',
      westWorkspaceRootPath: workspaceInput.getAttribute('data-value') ?? ''
    }
  );
}
