import { Button, TextField, allComponents,
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
  
  const browseProgramButton = document.getElementById("browseProgramButton") as Button;
  const browseGdbButton = document.getElementById("browseGdbButton") as Button;
  const browseRunnerButton = document.getElementById("browseRunnerButton") as Button;
  const resetButton = document.getElementById("resetButton") as Button;
  const applyButton = document.getElementById("applyButton") as Button;
  const debugButton = document.getElementById("debugButton") as Button;
  
  browseProgramButton?.addEventListener("click", browseProgramHandler);
  browseGdbButton?.addEventListener("click", browseGdbHandler);
  browseRunnerButton?.addEventListener("click", browseRunnerHandler);

  resetButton.addEventListener("click", resetHandler);
  applyButton.addEventListener("click", applyHandler);
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

function setLocalPath(id: string, path: string) {
  const localPath = document.getElementById(id) as TextField;
  localPath.value = path;
}

function setVSCodeMessageListener() {
  window.addEventListener("message", (event) => {
    const command = event.data.command;
    switch(command) {
      case 'updateConfig': {
        const programPath = event.data.programPath;
        const gdbPath = event.data.gdbPath;
        const gdbAddress = event.data.gdbAddress;
        const gdbPort = event.data.gdbPort;
        const runnersHTML = event.data.runnersHTML;
        const runner = event.data.runnerName;
        const runnerPath = event.data.runnerPath;
        const runnerArgs = event.data.runnerArgs;
        
        updateConfig(programPath, gdbPath, gdbAddress, gdbPort, runnersHTML, runner, runnerPath, runnerArgs);
        break;
      }
      case 'updateRunnerConfig': {
        const runnerPath = event.data.runnerPath;
        const runnerArgs = event.data.runnerArgs;
        updateRunnerConfig(runnerPath, runnerArgs);
        break;
      }
      case 'fileSelected':
        setLocalPath(event.data.id, event.data.fileUri);
        break;
      default:
        break;
    }

  });
}

function browseProgramHandler(this: HTMLElement, ev: MouseEvent) {
  webviewApi.postMessage(
    {
      command: 'browseProgram',
    }
  );
}

function browseGdbHandler(this: HTMLElement, ev: MouseEvent) {
  webviewApi.postMessage(
    {
      command: 'browseGdb',
    }
  );
}

function browseRunnerHandler(this: HTMLElement, ev: MouseEvent) {
  webviewApi.postMessage(
    {
      command: 'browseRunner',
    }
  );
}

function resetHandler(this: HTMLElement, ev: MouseEvent) {
  const applicationInput = document.getElementById('applicationInput') as HTMLInputElement;

  webviewApi.postMessage(
    {
      command: 'reset',
      project: applicationInput.getAttribute('data-value'),
    }
  );
}

function applyHandler(this: HTMLElement, ev: MouseEvent) {
  const applicationInput = document.getElementById('applicationInput') as HTMLInputElement;
  const programPath = document.getElementById('programPath') as TextField;
  const gdbPath = document.getElementById('gdbPath') as TextField;
  const gdbAddress = document.getElementById('gdbAddress') as TextField;
  const gdbPort = document.getElementById('gdbPort') as TextField;
  const runnerInput = document.getElementById('runnerInput') as HTMLInputElement;
  const runnerPath = document.getElementById('runnerPath') as TextField;
  const runnerArgs = document.getElementById('runnerArgs') as TextField;

  webviewApi.postMessage(
    {
      command: 'apply',
      project: applicationInput.getAttribute('data-value'),
      programPath: programPath.value,
      gdbPath: gdbPath.value,
      gdbAddress: gdbAddress.value,
      gdbPort: gdbPort.value,
      runner: runnerInput.getAttribute('data-value'),
      runnerPath: runnerPath.value,
      runnerArgs: runnerArgs.value
    }
  );
}

function debugHandler(this: HTMLElement, ev: MouseEvent) {
  const applicationInput = document.getElementById('applicationInput') as HTMLInputElement;
  const programPath = document.getElementById('programPath') as TextField;
  const gdbPath = document.getElementById('gdbPath') as TextField;
  const gdbAddress = document.getElementById('gdbAddress') as TextField;
  const gdbPort = document.getElementById('gdbPort') as TextField;
  const runnerInput = document.getElementById('runnerInput') as HTMLInputElement;
  const runnerPath = document.getElementById('runnerPath') as TextField;
  const runnerArgs = document.getElementById('runnerArgs') as TextField;

  webviewApi.postMessage(
    {
      command: 'debug',
      project: applicationInput.getAttribute('data-value'),
      programPath: programPath.value,
      gdbPath: gdbPath.value,
      gdbAddress: gdbAddress.value,
      gdbPort: gdbPort.value,
      runner: runnerInput.getAttribute('data-value'),
      runnerPath: runnerPath.value,
      runnerArgs: runnerArgs.value
    }
  );
}

function initApplicationsDropdown() {
  const applicationInput = document.getElementById('applicationInput') as HTMLInputElement;
  const applicationsDropdown = document.getElementById('applicationsDropdown') as HTMLElement;
  const applicationDropdownSpinner = document.getElementById('applicationsDropdownSpinner') as HTMLElement;
  
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
    webviewApi.postMessage(
      { 
        command: 'projectChanged',
        project: applicationInput.getAttribute('data-value'),
      }
    );
    applicationDropdownSpinner.style.display = 'block';
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

  applicationDropdownSpinner.style.display = 'none';
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
    webviewApi.postMessage(
      { 
        command: 'runnerChanged',
        runner: runnerInput.getAttribute('data-value'),
      }
    );
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

function updateConfig(programPath: string, gdbPath: string, gdbAddress: string = 'localhost', gdbPort: string = '3333', runnersHTML: string,
  server: string, runnerPath: string, runnerArgs: string) {
  const applicationDropdownSpinner = document.getElementById('applicationsDropdownSpinner') as HTMLElement; 
  const programPathText = document.getElementById('programPath') as TextField;
  const gdbPathText = document.getElementById('gdbPath') as TextField;
  const gdbAddressText = document.getElementById('gdbAddress') as TextField;
  const gdbPortText = document.getElementById('gdbPort') as TextField;
  const runnerInput = document.getElementById('runnerInput') as HTMLInputElement;
  const runnersDropdown = document.getElementById('runnersDropdown') as HTMLElement;
  const runnerPathText = document.getElementById('runnerPath') as TextField;
  const runnerArgsText = document.getElementById('runnerArgs') as TextField;

  programPathText.value = programPath;
  gdbPathText.value = gdbPath;
  gdbAddressText.value = gdbAddress;
  gdbPortText.value = gdbPort;

  if(runnersHTML.length > 0) {
    runnersDropdown.innerHTML = runnersHTML;
    addDropdownItemEventListeners(runnersDropdown, runnerInput);
  }

  runnerInput.value = server;
  runnerInput.setAttribute('data-value', server);
  runnerPathText.value = runnerPath;
  runnerArgsText.value = runnerArgs;

  // Hide loading spinner
  applicationDropdownSpinner.style.display = 'none';
}

function updateRunnerConfig(runnerPath: string, runnerArgs: string) {
  const runnerPathText = document.getElementById('runnerPath') as TextField;
  const runnerArgsText = document.getElementById('runnerArgs') as TextField;
  runnerPathText.value = runnerPath;
  runnerArgsText.value = runnerArgs;
}