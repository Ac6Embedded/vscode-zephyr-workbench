import { Button, RadioGroup, TextField, allComponents, provideVSCodeDesignSystem } from "@vscode/webview-ui-toolkit/";

provideVSCodeDesignSystem().register(allComponents);

const webviewApi = acquireVsCodeApi();

window.addEventListener("load", main);

function main() {
  setVSCodeMessageListener();

  hideBrowseSpinners();
  initApplicationsDropdown();
  initBuildConfigsDropdown();
  initRunnersDropdown();

  const runnerPathText = document.getElementById('runnerPath') as TextField;
  const browseProgramButton = document.getElementById("browseProgramButton") as Button;
  const browseSvdButton = document.getElementById("browseSvdButton") as Button;
  const browseGdbButton = document.getElementById("browseGdbButton") as Button;
  const browseRunnerButton = document.getElementById("browseRunnerButton") as Button;
  const installButton = document.getElementById("installRunnerButton") as Button;
  const resetButton = document.getElementById("resetButton") as Button;
  const applyButton = document.getElementById("applyButton") as Button;
  const debugButton = document.getElementById("debugButton") as Button;

  runnerPathText.addEventListener('input', function() {
    const runnerInput = document.getElementById('runnerInput') as HTMLInputElement;
    webviewApi.postMessage({
      command: 'runnerPathChanged',
      runner: runnerInput.getAttribute('data-value'),
      runnerPath: runnerPathText.value
    });
  });

  browseProgramButton?.addEventListener("click", browseProgramHandler);
  browseSvdButton?.addEventListener("click", browseSvdHandler);
  browseGdbButton?.addEventListener("click", browseGdbHandler);
  browseRunnerButton?.addEventListener("click", browseRunnerHandler);

  installButton.addEventListener("click", installHandler);
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

          if (input.id === 'applicationInput') {
            hideSpinner('svdPathSpinner'); 
            hideSpinner('runnerPathSpinner'); 
            showSpinner('programPathSpinner');
            showSpinner('gdbPathSpinner');
      }
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

function showSpinner(spinnerId: string) {
  const spinner = document.getElementById(spinnerId);
  if (spinner) spinner.style.display = 'inline-block';
}

function hideSpinner(spinnerId: string) {
  const spinner = document.getElementById(spinnerId);
  if (spinner) spinner.style.display = 'none';
}

function setLocalPath(id: string, path: string) {
  const localPath = document.getElementById(id) as TextField;
  if (path) {
    localPath.value = path;
    localPath.dispatchEvent(new Event('input'));
  }
  if (id === 'programPath') hideSpinner('programPathSpinner');
  if (id === 'svdPath') hideSpinner('svdPathSpinner');
  if (id === 'gdbPath') hideSpinner('gdbPathSpinner');
  if (id === 'runnerPath') hideSpinner('runnerPathSpinner');
}

function setVSCodeMessageListener() {
  window.addEventListener("message", (event) => {
    const command = event.data.command;
    switch (command) {
      case 'updateLaunchConfig': {
        const projectPath = event.data.projectPath;
        if (projectPath && projectPath.length > 0) {
          const configName = event.data.configName;
          updateSelectedApplication(projectPath, configName);
        }
        break;
      }
      case 'updateBuildConfigs': {
        const buildConfigsHTML = event.data.buildConfigsHTML;
        updateBuildConfigs(buildConfigsHTML, event.data.selectFirst === 'true' ? true : false);
        break;
      }
      case 'updateConfig': {
        updateConfig(event.data);
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
        updateRunnerDetect(runnerDetect === 'true' ? true : false);
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
  showSpinner('programPathSpinner');
  webviewApi.postMessage({ command: 'browseProgram' });
}

function browseSvdHandler(this: HTMLElement, ev: MouseEvent) {
  showSpinner('svdPathSpinner');
  webviewApi.postMessage({ command: 'browseSvd' });
}

function browseGdbHandler(this: HTMLElement, ev: MouseEvent) {
  showSpinner('gdbPathSpinner');
  webviewApi.postMessage({ command: 'browseGdb' });
}

function browseRunnerHandler(this: HTMLElement, ev: MouseEvent) {
  showSpinner('runnerPathSpinner');
  webviewApi.postMessage({ command: 'browseRunner' });
}

function installHandler(this: HTMLElement, ev: MouseEvent) {
  webviewApi.postMessage({ command: 'install' });
}

function resetHandler(this: HTMLElement, ev: MouseEvent) {
  const applicationInput = document.getElementById('applicationInput') as HTMLInputElement;
  const buildConfigInput = document.getElementById('buildConfigInput') as HTMLInputElement;

  webviewApi.postMessage({
    command: 'reset',
    project: applicationInput.getAttribute('data-value'),
    buildConfig: buildConfigInput.getAttribute('data-value') ? buildConfigInput.getAttribute('data-value') : ''
  });
}

function applyHandler(this: HTMLElement, ev: MouseEvent) {
  const applicationInput = document.getElementById('applicationInput') as HTMLInputElement;
  const buildConfigInput = document.getElementById('buildConfigInput') as HTMLInputElement;
  const programPath = document.getElementById('programPath') as TextField;
  const svdPath = document.getElementById('svdPath') as TextField;
  const gdbPath = document.getElementById('gdbPath') as TextField;
  const gdbAddress = document.getElementById('gdbAddress') as TextField;
  const gdbPort = document.getElementById('gdbPort') as TextField;
  const gdbModeRadioGroup = document.getElementById("gdbMode") as RadioGroup;
  const runnerInput = document.getElementById('runnerInput') as HTMLInputElement;
  const runnerPath = document.getElementById('runnerPath') as TextField;
  const runnerArgs = document.getElementById('runnerArgs') as TextField;

  webviewApi.postMessage({
    command: 'apply',
    project: applicationInput.getAttribute('data-value'),
    buildConfig: buildConfigInput.getAttribute('data-value') ? buildConfigInput.getAttribute('data-value') : '',
    programPath: programPath.value,
    svdPath: svdPath.value,
    gdbPath: gdbPath.value,
    gdbAddress: gdbAddress.value,
    gdbPort: gdbPort.value,
    gdbMode: gdbModeRadioGroup.value,
    runner: runnerInput.getAttribute('data-value'),
    runnerPath: runnerPath.value,
    runnerArgs: runnerArgs.value
  });
}

function debugHandler(this: HTMLElement, ev: MouseEvent) {
  const applicationInput = document.getElementById('applicationInput') as HTMLInputElement;
  const buildConfigInput = document.getElementById('buildConfigInput') as HTMLInputElement;
  const programPath = document.getElementById('programPath') as TextField;
  const svdPath = document.getElementById('svdPath') as TextField;
  const gdbPath = document.getElementById('gdbPath') as TextField;
  const gdbAddress = document.getElementById('gdbAddress') as TextField;
  const gdbPort = document.getElementById('gdbPort') as TextField;
  const gdbModeRadioGroup = document.getElementById("gdbMode") as RadioGroup;
  const runnerInput = document.getElementById('runnerInput') as HTMLInputElement;
  const runnerPath = document.getElementById('runnerPath') as TextField;
  const runnerArgs = document.getElementById('runnerArgs') as TextField;
  const debugButton = document.getElementById("debugButton") as Button;

  debugButton.disabled = true;
  webviewApi.postMessage({
    command: 'debug',
    project: applicationInput.getAttribute('data-value'),
    buildConfig: buildConfigInput.getAttribute('data-value') ? buildConfigInput.getAttribute('data-value') : '',
    programPath: programPath.value,
    svdPath: svdPath.value,
    gdbPath: gdbPath.value,
    gdbAddress: gdbAddress.value,
    gdbPort: gdbPort.value,
    gdbMode: gdbModeRadioGroup.value,
    runner: runnerInput.getAttribute('data-value'),
    runnerPath: runnerPath.value,
    runnerArgs: runnerArgs.value
  });
}

function showBrowseSpinnersWhileLoading() {
  showSpinner('programPathSpinner');
  showSpinner('gdbPathSpinner');
  hideSpinner('runnerPathSpinner');
}

function hideBrowseSpinners() {
  hideSpinner('programPathSpinner');
  hideSpinner('svdPathSpinner');
  hideSpinner('gdbPathSpinner');
  hideSpinner('runnerPathSpinner');
}

function initApplicationsDropdown() {
  const applicationInput = document.getElementById('applicationInput') as HTMLInputElement;
  const applicationsDropdown = document.getElementById('applicationsDropdown') as HTMLElement;
  const applicationDropdownSpinner = document.getElementById('applicationsDropdownSpinner') as HTMLElement;

  applicationInput.addEventListener('focusin', () => {
    if (applicationsDropdown) applicationsDropdown.style.display = 'block';
  });

  applicationInput.addEventListener('focusout', () => {
    if (applicationsDropdown) applicationsDropdown.style.display = 'none';
  });

  applicationInput.addEventListener('click', () => {
    if (applicationsDropdown) applicationsDropdown.style.display = 'block';
  });

  applicationInput.addEventListener('input', () => {
    webviewApi.postMessage({
      command: 'projectChanged',
      project: applicationInput.getAttribute('data-value'),
    });
  });

  applicationInput.addEventListener('keyup', () => {
    filterFunction(applicationInput, applicationsDropdown);
  });

  applicationsDropdown.addEventListener('mousedown', e => e.preventDefault());
  applicationsDropdown.addEventListener('mouseup', e => e.preventDefault());

  applicationDropdownSpinner.style.display = 'none';
  addDropdownItemEventListeners(applicationsDropdown, applicationInput);
}

function initBuildConfigsDropdown() {
  const applicationInput = document.getElementById('applicationInput') as HTMLInputElement;
  const buildConfigInput = document.getElementById('buildConfigInput') as HTMLInputElement;
  const buildConfigDropdown = document.getElementById('buildConfigDropdown') as HTMLElement;

  buildConfigInput.addEventListener('focusin', () => {
    if (buildConfigDropdown) buildConfigDropdown.style.display = 'block';
  });

  buildConfigInput.addEventListener('focusout', () => {
    if (buildConfigDropdown) buildConfigDropdown.style.display = 'none';
  });

  buildConfigInput.addEventListener('click', () => {
    if (buildConfigDropdown) buildConfigDropdown.style.display = 'block';
  });

  buildConfigInput.addEventListener('input', () => {
    webviewApi.postMessage({
      command: 'buildConfigChanged',
      project: applicationInput.getAttribute('data-value'),
      buildConfig: buildConfigInput.getAttribute('data-value') ? buildConfigInput.getAttribute('data-value') : ''
    });
  });

  buildConfigInput.addEventListener('keyup', () => {
    filterFunction(buildConfigInput, buildConfigDropdown);
  });

  buildConfigDropdown.addEventListener('mousedown', e => e.preventDefault());
  buildConfigDropdown.addEventListener('mouseup', e => e.preventDefault());

  addDropdownItemEventListeners(buildConfigDropdown, buildConfigInput);
}

function initRunnersDropdown() {
  const runnerInput = document.getElementById('runnerInput') as HTMLInputElement;
  const runnersDropdown = document.getElementById('runnersDropdown') as HTMLElement;
  const runnerPath = document.getElementById('runnerPath') as TextField;

  runnerInput.addEventListener('focusin', () => {
    if (runnersDropdown) runnersDropdown.style.display = 'block';
  });

  runnerInput.addEventListener('focusout', () => {
    if (runnersDropdown) runnersDropdown.style.display = 'none';
  });

  runnerInput.addEventListener('click', () => {
    if (runnersDropdown) runnersDropdown.style.display = 'block';
  });

  runnerInput.addEventListener('input', () => {
    webviewApi.postMessage({
      command: 'runnerChanged',
      runner: runnerInput.getAttribute('data-value'),
      runnerPath: runnerPath.value ?? '',
    });
  });

  runnerInput.addEventListener('keyup', () => {
    filterFunction(runnerInput, runnersDropdown);
  });

  runnersDropdown.addEventListener('mousedown', e => e.preventDefault());
  runnersDropdown.addEventListener('mouseup', e => e.preventDefault());

  addDropdownItemEventListeners(runnersDropdown, runnerInput);
}

async function updateSelectedApplication(projectPath: string, configName: string) {
  const applicationInput = document.getElementById('applicationInput') as HTMLInputElement;
  const applicationsDropdown = document.getElementById('applicationsDropdown') as HTMLElement;
  const buildConfigInput = document.getElementById('buildConfigInput') as HTMLInputElement;

  if (projectPath) {
    for (let i = 0; i < applicationsDropdown.children.length; i++) {
      const option = applicationsDropdown.children[i] as HTMLElement;
      if (option.getAttribute('data-value') === projectPath) {
        applicationInput.value = option.getAttribute('data-label') || '';
        applicationInput.setAttribute('data-value', option.getAttribute('data-value') || '');
        applicationInput.dispatchEvent(new Event('input'));
        break;
      }
    }

    if (configName.length > 0) {
      buildConfigInput.value = configName || '';
      buildConfigInput.setAttribute('data-value', configName || '');
      buildConfigInput.dispatchEvent(new Event('input'));
    }
  }
}

function updateBuildConfigs(buildConfigsHTML: string, selectFirst: boolean = false) {
  const buildConfigInput = document.getElementById('buildConfigInput') as HTMLInputElement;
  const buildConfigDropdown = document.getElementById('buildConfigDropdown') as HTMLElement;

  if (buildConfigsHTML.length > 0) {
    buildConfigInput.disabled = false;
    buildConfigDropdown.innerHTML = buildConfigsHTML;
    addDropdownItemEventListeners(buildConfigDropdown, buildConfigInput);
    if (selectFirst) {
      const firstOption = buildConfigDropdown.children[0] as HTMLElement;
      buildConfigInput.value = firstOption.getAttribute('data-label') || '';
      buildConfigInput.setAttribute('data-value', firstOption.getAttribute('data-value') || '');
      buildConfigInput.dispatchEvent(new Event('input'));
    }
  } else {
    buildConfigInput.disabled = true;
  }
}

function updateConfig(data: any) {
  const programPath = data.programPath;
  const svdPath = data.svdPath;
  const gdbPath = data.gdbPath;
  const gdbAddress = data.gdbAddress ?? 'localhost';
  const gdbPort = data.gdbPort ?? '3333';
  const gdbMode = data.gdbMode;
  const runnersHTML = data.runnersHTML;
  const runner = data.runnerName;
  const runnerPath = data.runnerPath;
  const runnerArgs = data.runnerArgs;

  const programPathText = document.getElementById('programPath') as TextField;
  const svdPathText = document.getElementById('svdPath') as TextField;
  const gdbPathText = document.getElementById('gdbPath') as TextField;
  const gdbAddressText = document.getElementById('gdbAddress') as TextField;
  const gdbPortText = document.getElementById('gdbPort') as TextField;
  const gdbModeRadioGroup = document.getElementById("gdbMode") as RadioGroup;
  const runnerInput = document.getElementById('runnerInput') as HTMLInputElement;
  const runnersDropdown = document.getElementById('runnersDropdown') as HTMLElement;
  const runnerPathText = document.getElementById('runnerPath') as TextField;
  const runnerArgsText = document.getElementById('runnerArgs') as TextField;

  programPathText.value = programPath ?? '';
  svdPathText.value = svdPath ?? '';
  gdbPathText.value = gdbPath ?? '';
  gdbAddressText.value = gdbAddress ?? '';
  gdbPortText.value = gdbPort ?? '';
  gdbModeRadioGroup.value = gdbMode ?? 'program';

  if (runnersHTML && runnersHTML.length > 0) {
    runnersDropdown.innerHTML = runnersHTML;
    addDropdownItemEventListeners(runnersDropdown, runnerInput);
  }

  const selectedRunner = runnersDropdown.querySelector(`.dropdown-item[data-label="${runner}"]`) as HTMLDivElement;
  if (selectedRunner) {
    runnerInput.value = selectedRunner.getAttribute('data-label') || '';
    runnerInput.setAttribute('data-value', selectedRunner.getAttribute('data-value') || '');
  }

  runnerPathText.value = runnerPath ?? '';
  runnerArgsText.value = runnerArgs ?? '';

  programPathText.dispatchEvent(new Event('input'));
  svdPathText.dispatchEvent(new Event('input'));
  gdbPathText.dispatchEvent(new Event('input'));
  runnerPathText.dispatchEvent(new Event('input'));

  const programLoaded = (programPathText.value ?? '').trim().length > 0;
  const gdbLoaded = (gdbPathText.value ?? '').trim().length > 0;
  const runnerLoaded = (runnerPathText.value ?? '').trim().length > 0;

  if (programLoaded && gdbLoaded && runnerLoaded) {
    hideBrowseSpinners();
  } else {
    if (programLoaded) hideSpinner('programPathSpinner');
    if (gdbLoaded) hideSpinner('gdbPathSpinner');
    if (runnerLoaded) hideSpinner('runnerPathSpinner');
    if ((svdPathText.value ?? '').trim().length > 0) hideSpinner('svdPathSpinner');
  }
}

function updateRunnerConfig(runnerPath: string, runnerArgs: string) {
  const runnerPathText = document.getElementById('runnerPath') as TextField;
  const runnerArgsText = document.getElementById('runnerArgs') as TextField;
  runnerPathText.value = runnerPath ?? '';
  runnerPathText.dispatchEvent(new Event('input'));
  runnerArgsText.value = runnerArgs ?? '';
  runnerArgsText.dispatchEvent(new Event('input'));

  if ((runnerPath ?? '').trim().length > 0) hideSpinner('runnerPathSpinner');
}

function updateRunnerDetect(runnerDetect: boolean) {
  const runnerDetectSpan = document.getElementById('runnerDetect') as HTMLElement;
  if (runnerDetect === true) {
    runnerDetectSpan.innerHTML = "(Runner executable found)";
    runnerDetectSpan.style.color = "#00aa00";
  } else if (runnerDetect === false) {
    runnerDetectSpan.innerHTML = "(Runner not found in PATH, please enter runner location)";
    runnerDetectSpan.style.color = "#aa0000";
  } else {
    console.warn('Unexpected value for runnerDetect:', runnerDetect);
  }
}