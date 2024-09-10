import { Button, allComponents,
  provideVSCodeDesignSystem } from "@vscode/webview-ui-toolkit/";

provideVSCodeDesignSystem().register(
  allComponents
);

const webviewApi = acquireVsCodeApi();

window.addEventListener("load", main);

function main() {

  setVSCodeMessageListener();

  initApplicationsDropdown();
  initRunnersDropdown();
  
  const debugButton = document.getElementById("debugButton") as Button;
  debugButton.addEventListener("click", debugHandler);
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

function setVSCodeMessageListener() {
  window.addEventListener("message", (event) => {
    const command = event.data.command;
    switch(command) {
      default:
        break;
    }

  });
}

function debugHandler(this: HTMLElement, ev: MouseEvent) {
  const applicationInput = document.getElementById('applicationInput') as HTMLInputElement;
  const runnerInput = document.getElementById('runnerInput') as HTMLInputElement;

  webviewApi.postMessage(
    {
      command: 'debug',
      runner: runnerInput.getAttribute('data-value'),
      project: applicationInput.getAttribute('data-value'),
    }
  );
}

function initApplicationsDropdown() {
  const applicationInput = document.getElementById('applicationInput') as HTMLInputElement;
  const applicationsDropdown = document.getElementById('applicationsDropdown') as HTMLElement;
  
  applicationInput.addEventListener('focusin', function() {
    if(applicationsDropdown) {
      applicationsDropdown.style.display = 'block';
    }
  });

  applicationInput.addEventListener('focusout', function() {
    if(applicationsDropdown) {
      applicationsDropdown.style.display = 'none';
    }
  });

  applicationInput.addEventListener('click', function(event) {
    if(applicationsDropdown) {
      applicationsDropdown.style.display = 'block';
    }
  });

  applicationInput.addEventListener('input', () => {
    // Handle selection change
  });

  applicationInput.addEventListener('keyup', () => {
    filterFunction(applicationInput, applicationsDropdown);
  });

  applicationsDropdown.addEventListener('mousedown', function(event) {
    event.preventDefault();
  });

  applicationsDropdown.addEventListener('mouseup', function(event) {
    event.preventDefault();
  });

  addDropdownItemEventListeners(applicationsDropdown, applicationInput);
}

function initRunnersDropdown() {
  const runnerInput = document.getElementById('runnerInput') as HTMLInputElement;
  const runnersDropdown = document.getElementById('runnersDropdown') as HTMLElement;
  
  runnerInput.addEventListener('focusin', function() {
    if(runnersDropdown) {
      runnersDropdown.style.display = 'block';
    }
  });

  runnerInput.addEventListener('focusout', function() {
    if(runnersDropdown) {
      runnersDropdown.style.display = 'none';
    }
  });

  runnerInput.addEventListener('click', function(event) {
    if(runnersDropdown) {
      runnersDropdown.style.display = 'block';
    }
  });

  runnerInput.addEventListener('input', () => {
    // Handle selection change
  });

  runnerInput.addEventListener('keyup', () => {
    filterFunction(runnerInput, runnersDropdown);
  });

  runnersDropdown.addEventListener('mousedown', function(event) {
    event.preventDefault();
  });

  runnersDropdown.addEventListener('mouseup', function(event) {
    event.preventDefault();
  });

  addDropdownItemEventListeners(runnersDropdown, runnerInput);
}



