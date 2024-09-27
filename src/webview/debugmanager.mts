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
  
  const runnerPathText = document.getElementById('runnerPath') as TextField;
  const browseProgramButton = document.getElementById("browseProgramButton") as Button;
  const browseSvdButton = document.getElementById("browseSvdButton") as Button;
  const browseGdbButton = document.getElementById("browseGdbButton") as Button;
  const browseRunnerButton = document.getElementById("browseRunnerButton") as Button;
  const resetButton = document.getElementById("resetButton") as Button;
  const applyButton = document.getElementById("applyButton") as Button;
  const debugButton = document.getElementById("debugButton") as Button;

  runnerPathText.addEventListener('input', function() {
    const runnerInput = document.getElementById('runnerInput') as HTMLInputElement;
    webviewApi.postMessage(
      {
        command: 'runnerPathChanged',
        runner: runnerInput.getAttribute('data-value'),
        runnerPath: runnerPathText.value
      }
    );
  });

  browseProgramButton?.addEventListener("click", browseProgramHandler);
  browseSvdButton?.addEventListener("click", browseSvdHandler);
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
  if(path) {
    localPath.value = path;
  }
}

function setVSCodeMessageListener() {
  window.addEventListener("message", (event) => {
    const command = event.data.command;
    switch(command) {
      case 'updateConfig': {
        const programPath = event.data.programPath;
        const svdPath = event.data.svdPath;
        const gdbPath = event.data.gdbPath;
        const gdbAddress = event.data.gdbAddress;
        const gdbPort = event.data.gdbPort;
        const runnersHTML = event.data.runnersHTML;
        const runner = event.data.runnerName;
        const runnerPath = event.data.runnerPath;
        const runnerArgs = event.data.runnerArgs;
        
        updateConfig(programPath, svdPath, gdbPath, gdbAddress, gdbPort, runnersHTML, runner, runnerPath, runnerArgs);
        break;
      }
      case 'updateRunnerConfig': {
        const runnerPath = event.data.runnerPath;
        const runnerArgs = event.data.runnerArgs;
        updateRunnerConfig(runnerPath, runnerArgs);
        break;
      }
      case 'updateRunnerDetect': {
        const runnerDetect = event.data.runnerDetect;
        updateRunnerDetect(runnerDetect === 'true'?true:false);
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

function browseSvdHandler(this: HTMLElement, ev: MouseEvent) {
  webviewApi.postMessage(
    {
      command: 'browseSvd',
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
  const svdPath = document.getElementById('svdPath') as TextField;
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
      svdPath: svdPath.value,
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

// Ugly method to refactor/split
function updateConfig(programPath: string, svdPath: string, gdbPath: string, 
  gdbAddress: string = 'localhost', gdbPort: string = '3333', runnersHTML: string,
  server: string, runnerPath: string, runnerArgs: string) {
  const applicationDropdownSpinner = document.getElementById('applicationsDropdownSpinner') as HTMLElement; 
  const programPathText = document.getElementById('programPath') as TextField;
  const svdPathText = document.getElementById('svdPath') as TextField;
  const gdbPathText = document.getElementById('gdbPath') as TextField;
  const gdbAddressText = document.getElementById('gdbAddress') as TextField;
  const gdbPortText = document.getElementById('gdbPort') as TextField;
  const runnerInput = document.getElementById('runnerInput') as HTMLInputElement;
  const runnersDropdown = document.getElementById('runnersDropdown') as HTMLElement;
  const runnerPathText = document.getElementById('runnerPath') as TextField;
  const runnerArgsText = document.getElementById('runnerArgs') as TextField;

  programPathText.value = programPath?programPath:'';
  svdPathText.value = svdPath?svdPath:'';
  gdbPathText.value = gdbPath?gdbPath:'';
  gdbAddressText.value = gdbAddress?gdbAddress:'';
  gdbPortText.value = gdbPort?gdbPort:'';

  if(runnersHTML.length > 0) {
    runnersDropdown.innerHTML = runnersHTML;
    addDropdownItemEventListeners(runnersDropdown, runnerInput);
  }

  const selectedRunner = runnersDropdown.querySelector(`.dropdown-item[data-label="${server}"]`) as HTMLDivElement;
  if (selectedRunner) {
    selectedRunner.click();
  }
  runnerPathText.value = runnerPath;
  runnerArgsText.value = runnerArgs;
  runnerPathText.dispatchEvent(new Event('input'));

  // Hide loading spinner
  applicationDropdownSpinner.style.display = 'none';
}

function updateRunnerConfig(runnerPath: string, runnerArgs: string) {
  const runnerPathText = document.getElementById('runnerPath') as TextField;
  const runnerArgsText = document.getElementById('runnerArgs') as TextField;

  runnerPathText.value = runnerPath;
  runnerArgsText.value = runnerArgs;
  runnerPathText.dispatchEvent(new Event('input'));
}

function updateRunnerDetect(runnerDetect: boolean) {
  const runnerDetectSpan = document.getElementById('runnerDetect') as HTMLElement;
  if(runnerDetect === true) {
    runnerDetectSpan.innerHTML = "(Runner executable found)";
    runnerDetectSpan.style.color = "#00aa00";
  } else if (runnerDetect === false) {
    runnerDetectSpan.innerHTML = "(Runner not found in PATH, please enter runner location)";
    runnerDetectSpan.style.color = "#aa0000";
  } else {
    console.warn('Unexpected value for runnerDetect:', runnerDetect);
  }
}