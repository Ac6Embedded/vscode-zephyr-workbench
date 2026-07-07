import { Button, RadioGroup, TextField, allComponents, provideVSCodeDesignSystem } from "@vscode/webview-ui-toolkit/";

provideVSCodeDesignSystem().register(allComponents);

const webviewApi = acquireVsCodeApi();

window.addEventListener("load", main);

function main() {
  setVSCodeMessageListener();

  hideBrowseSpinners();
  setRunnerDetectMessage('');
  setCortexDetectMessage('');
  updateRunnerDefaultInfo('', '');
  initApplicationsDropdown();
  initBuildConfigsDropdown();
  initRunnersDropdown();
  initBackendRadioGroup();
  hideSpinner('resetSpinner');
  hideSpinner('deviceNameSpinner');

  // Seed the west cache from the server-rendered dropdown so a backend toggle
  // before any build configuration loads does not wipe the runner list.
  const initialRunnersDropdown = document.getElementById('runnersDropdown') as HTMLElement | null;
  cachedWestRunnersHTML = initialRunnersDropdown?.innerHTML ?? '';

  const runnerPathText = document.getElementById('runnerPath') as TextField;
  const browseProgramButton = document.getElementById("browseProgramButton") as Button;
  const browseSvdButton = document.getElementById("browseSvdButton") as Button;
  const browseGdbButton = document.getElementById("browseGdbButton") as Button;
  const browseRunnerButton = document.getElementById("browseRunnerButton") as Button;
  const installButton = document.getElementById("installRunnerButton") as Button;
  const runnerDetectInstallButton = document.getElementById("runnerDetectInstallButton") as Button;
  const changeRunnerDefaultButton = document.getElementById("changeRunnerDefaultButton") as Button;
  const cortexInstallButton = document.getElementById("cortexInstallButton") as Button | null;
  const resetButton = document.getElementById("resetButton") as Button;
  const applyButton = document.getElementById("applyButton") as Button;
  const debugButton = document.getElementById("debugButton") as Button;

  cortexInstallButton?.addEventListener("click", () => {
    webviewApi.postMessage({ command: 'installCortexDebug', backend: getSelectedBackend() });
  });

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
  document.getElementById('pyocdManageButton')?.addEventListener("click", pyocdManageHandler);
  runnerDetectInstallButton?.addEventListener("click", installHandler);
  changeRunnerDefaultButton?.addEventListener("click", installHandler);
  resetButton.addEventListener("click", resetHandler);
  applyButton.addEventListener("click", applyHandler);
  debugButton.addEventListener("click", debugHandler);

  webviewApi.postMessage({ command: 'webviewReady' });
}

// HTML lists for the runner dropdown per backend, refreshed by updateConfig.
let cachedWestRunnersHTML = '';
let cachedNativeRunnersHTML = '';
// Pristine tracking: auto-delivered values only overwrite fields the user
// never customized (empty, or still equal to the last auto value).
let lastDefaultGdbPort = '';
let lastAutoDetectedDevice = '';
// Guards the backend radio listener against the synchronous 'change' event
// the toolkit fires when updateConfig assigns the group value programmatically.
let suppressBackendChangeEvent = false;

function getSelectedBackend(): string {
  const backendGroup = document.getElementById('debugBackend') as RadioGroup | null;
  return backendGroup?.value || 'cppdbg';
}

function setRowVisible(rowId: string, visible: boolean) {
  const row = document.getElementById(rowId) as HTMLElement | null;
  if (row) {
    row.style.display = visible ? '' : 'none';
  }
}

/**
 * Single visibility authority for backend-dependent rows.
 *
 * - Native (cortex-debug spawns the server): no GDB address/port, but Device +
 *   Interface rows and a Runner Path (cortex-debug `serverpath`) for both
 *   servers.
 * - West-based backends: keep the historical per-runner Runner Path rule
 *   (`stlink_gdbserver` is launched via the CubeCLT bundle, `pyocd` resolves
 *   from the environment).
 */
function applyBackendVisibility() {
  const backend = getSelectedBackend();
  const runnerInput = document.getElementById('runnerInput') as HTMLInputElement | null;
  const runnerName = (runnerInput?.getAttribute('data-value') ?? '').toLowerCase();
  const native = backend === 'cortex-native';

  setRowVisible('gdbAddressRow', !native);
  setRowVisible('gdbPortRow', !native);
  setRowVisible('deviceRow', native);
  setRowVisible('interfaceRow', native);
  setRowVisible('runnerPathRow', native || !(runnerName === 'stlink_gdbserver' || runnerName === 'pyocd'));
  // pyOCD's target support (CMSIS-Packs) has its own manager panel.
  document.getElementById('pyocdManageButton')?.classList.toggle('hidden', runnerName !== 'pyocd');
  if (runnerName !== 'pyocd') {
    // Hide immediately on runner switch; the panel re-posts the status when
    // pyocd is (re)selected.
    setRowVisible('pyocdTargetRow', false);
  }
}

function runnerPathHiddenForSelectedRunner() {
  applyBackendVisibility();
}

/**
 * Install the runner list matching the selected backend and keep the current
 * selection when it is still available; otherwise prefer the first runner
 * marked compatible with the board, else clear the selection.
 *
 * `silentSelection` updates the input without dispatching its 'input' event —
 * used on backend switches, where the backendChanged reset settles the final
 * runner and a second runnerChanged message would race it.
 */
function repopulateRunnersDropdown(silentSelection = false) {
  const runnerInput = document.getElementById('runnerInput') as HTMLInputElement | null;
  const runnersDropdown = document.getElementById('runnersDropdown') as HTMLElement | null;
  if (!runnerInput || !runnersDropdown) {
    return;
  }

  let html = getSelectedBackend() === 'cortex-native' ? cachedNativeRunnersHTML : cachedWestRunnersHTML;
  if (getSelectedBackend() === 'cortex-native' && !html && cachedWestRunnersHTML) {
    // No native list received yet — derive it by filtering the west list to
    // the servers cortex-debug can spawn natively. Drop the "(compatible)"
    // annotation: it describes west runners, not natively launched servers.
    const container = document.createElement('div');
    container.innerHTML = cachedWestRunnersHTML;
    for (const item of Array.from(container.children)) {
      const element = item as HTMLElement;
      const value = element.getAttribute('data-value');
      if (value !== 'jlink' && value !== 'stlink_gdbserver') {
        element.remove();
      } else {
        element.textContent = element.getAttribute('data-label') || element.textContent;
      }
    }
    html = container.innerHTML;
  }
  runnersDropdown.innerHTML = html ?? '';
  if ((html ?? '').length > 0) {
    addDropdownItemEventListeners(runnersDropdown, runnerInput);
  }

  const currentValue = runnerInput.getAttribute('data-value') ?? '';
  if (currentValue && runnersDropdown.querySelector(`.dropdown-item[data-value="${currentValue}"]`)) {
    return;
  }

  const items = Array.from(runnersDropdown.getElementsByClassName('dropdown-item')) as HTMLElement[];
  const preferred = items.find(item => (item.textContent ?? '').includes('(compatible)'));
  if (preferred) {
    runnerInput.value = preferred.getAttribute('data-label') || '';
    runnerInput.setAttribute('data-value', preferred.getAttribute('data-value') || '');
    if (!silentSelection) {
      runnerInput.dispatchEvent(new Event('input'));
    }
    return;
  }

  runnerInput.value = '';
  runnerInput.setAttribute('data-value', '');
  setRunnerDetectMessage('Choose a runner', '#aa0000');
}

function initBackendRadioGroup() {
  const backendGroup = document.getElementById('debugBackend') as RadioGroup | null;
  if (!backendGroup) {
    return;
  }

  backendGroup.addEventListener('change', () => {
    if (suppressBackendChangeEvent) {
      return;
    }
    const backend = getSelectedBackend();
    repopulateRunnersDropdown(true);
    applyBackendVisibility();

    const runnerInput = document.getElementById('runnerInput') as HTMLInputElement | null;
    const runner = runnerInput?.getAttribute('data-value') ?? '';
    if (backend === 'cortex-native' && runner === 'jlink') {
      showSpinner('deviceNameSpinner');
    }
    // A backend switch resets the form server-side; surface the same loading
    // feedback as a build-config change while the defaults are recomputed.
    const buildConfigInput = document.getElementById('buildConfigInput') as HTMLInputElement | null;
    if (buildConfigInput?.getAttribute('data-value')) {
      showBrowseSpinnersWhileLoading();
      updateRunnerDefaultInfo('', '');
    }
    webviewApi.postMessage({ command: 'backendChanged', backend, runner });
  });
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

      // Start spinners only when a build configuration is chosen,
      // since that triggers the heavy work (parse + populate fields).
      if (input.id === 'buildConfigInput') {
        showBrowseSpinnersWhileLoading();
        updateRunnerDefaultInfo('', '');
      }

      if (input.id === 'runnerInput') {
        // Clear previous detection text and start spinner before re-checking
        setRunnerDetectMessage('');
        updateRunnerDefaultInfo('', '');
        showSpinner('runnerPathSpinner');
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
  if (spinner) {spinner.style.display = 'inline-block';}
}

function hideSpinner(spinnerId: string) {
  const spinner = document.getElementById(spinnerId);
  if (spinner) {spinner.style.display = 'none';}
}

function getBrowseSpinnerId(fieldId: string): string | undefined {
  switch (fieldId) {
    case 'programPath':
      return 'programPathSpinner';
    case 'gdbPath':
      return 'gdbPathSpinner';
    case 'runnerPath':
      return 'runnerPathSpinner';
    default:
      return undefined;
  }
}

function hideBrowseSpinnerForField(fieldId: string) {
  const spinnerId = getBrowseSpinnerId(fieldId);
  if (spinnerId) {
    hideSpinner(spinnerId);
  }
}

function setDebugButtonDisabled(disabled: boolean) {
  const debugButton = document.getElementById("debugButton") as Button | null;
  if (!debugButton) {
    return;
  }

  debugButton.disabled = disabled;
  debugButton.toggleAttribute('disabled', disabled);
}

function setLocalPath(id: string, path: string) {
  const localPath = document.getElementById(id) as TextField;
  if (path) {
    localPath.value = path;
    localPath.dispatchEvent(new Event('input'));
  }
  hideBrowseSpinnerForField(id);
}

function setRunnerDetectMessage(text: string, color: string = '', showInstallButton: boolean = false) {
  const runnerDetectRow = document.getElementById('runnerDetectRow') as HTMLElement | null;
  const runnerDetectSpan = document.getElementById('runnerDetect') as HTMLElement | null;
  const runnerDetectInstallButton = document.getElementById('runnerDetectInstallButton') as Button | null;
  if (!runnerDetectRow || !runnerDetectSpan || !runnerDetectInstallButton) {
    return;
  }

  const resolvedText = (text ?? '').trim();
  runnerDetectSpan.textContent = resolvedText;
  runnerDetectSpan.style.color = color;
  runnerDetectInstallButton.hidden = !(resolvedText.length > 0 && showInstallButton);
  runnerDetectInstallButton.style.display = resolvedText.length > 0 && showInstallButton ? '' : 'none';
  runnerDetectRow.style.display = resolvedText.length > 0 ? '' : 'none';
}

function setCortexDetectMessage(text: string, color: string = '', showInstallButton: boolean = false) {
  const cortexDetectRow = document.getElementById('cortexDetectRow') as HTMLElement | null;
  const cortexDetectSpan = document.getElementById('cortexDetect') as HTMLElement | null;
  const cortexInstallButton = document.getElementById('cortexInstallButton') as Button | null;
  if (!cortexDetectRow || !cortexDetectSpan || !cortexInstallButton) {
    return;
  }

  const resolvedText = (text ?? '').trim();
  cortexDetectSpan.textContent = resolvedText;
  cortexDetectSpan.style.color = color;
  cortexInstallButton.hidden = !(resolvedText.length > 0 && showInstallButton);
  cortexInstallButton.style.display = resolvedText.length > 0 && showInstallButton ? '' : 'none';
  cortexDetectRow.style.display = resolvedText.length > 0 ? '' : 'none';
}

function setVSCodeMessageListener() {
  window.addEventListener("message", (event) => {
    const command = event.data.command;
    switch (command) {
      case 'applicationsLoading': {
        const applicationDropdownSpinner = document.getElementById('applicationsDropdownSpinner') as HTMLElement;
        if (applicationDropdownSpinner) applicationDropdownSpinner.style.display = 'inline-block';
        break;
      }
      case 'updateApplications': {
        const appsHTML = event.data.applicationsHTML as string;
        const applicationsDropdown = document.getElementById('applicationsDropdown') as HTMLElement;
        if (applicationsDropdown) {
          applicationsDropdown.innerHTML = appsHTML ?? '';
          const applicationInput = document.getElementById('applicationInput') as HTMLInputElement;
          addDropdownItemEventListeners(applicationsDropdown, applicationInput);
          // Apply pending selection if exists
          pathApplicationSelection();
        }
        const applicationDropdownSpinner = document.getElementById('applicationsDropdownSpinner') as HTMLElement;
        if (applicationDropdownSpinner) applicationDropdownSpinner.style.display = 'none';
        break;
      }
      case 'updateLaunchConfig': {
        const projectPath = event.data.projectPath;
        if (projectPath && projectPath.length > 0) {
          const configName = event.data.configName;
          // Store pending selections to be applied once dropdowns are populated
          pendingProjectPath = projectPath || '';
          pendingConfigName = configName || '';
          pathApplicationSelection();
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
      case 'updateConfigError': {
        updateRunnerDefaultInfo('', '');
        hideBrowseSpinners();
        break;
      }
      case 'updateRunnerConfig': {
        const runnerPath = event.data.runnerPath;
        const runnerArgs = event.data.runnerArgs;
        updateRunnerConfig(runnerPath, runnerArgs, event.data.runnerDefaultInfo, event.data.runnerDefaultPathInfo);
        break;
      }
      case 'updateRunnerDetect': {
        const runnerDetect = event.data.runnerDetect;
        const runnerName = event.data.runnerName;
        updateRunnerDetect(
          runnerDetect === 'true' ? true : false,
          runnerName,
          event.data.runnerDefaultInfo,
          event.data.runnerDefaultPathInfo,
          event.data.runnerVersion,
        );
        break;
      }
      case 'updatePyOCDTargetDetect': {
        const info = document.getElementById('pyocdTargetInfo');
        if (!event.data.visible || !info) {
          setRowVisible('pyocdTargetRow', false);
          break;
        }
        if (!event.data.target) {
          info.textContent = 'No pyOCD target detected for this build. Build the configuration first.';
        } else if (event.data.installed) {
          info.textContent = `pyOCD target '${event.data.target}': support installed`;
        } else {
          const link = document.createElement('a');
          link.href = '#';
          link.textContent = 'pyOCD Manager';
          link.addEventListener('click', (e) => {
            e.preventDefault();
            postPyocdManage();
          });
          info.replaceChildren(
            document.createTextNode(`pyOCD target '${event.data.target}': support not installed. The required CMSIS-Pack will be downloaded automatically and might take a while. You can customize it in the `),
            link,
            document.createTextNode('.'),
          );
        }
        setRowVisible('pyocdTargetRow', true);
        break;
      }
      case 'resetStarted': {
        document.getElementById('resetSpinner')!.style.display = 'inline-block';
        break;
      }
      case 'resetFinished': {
        document.getElementById('resetSpinner')!.style.display = 'none';
        break;
      }
      case 'updateCortexDetect': {
        // Only surface the row when something needs the user's attention:
        // a cortex backend is selected AND the extension is missing.
        if (event.data.applicable !== 'true' || event.data.installed === 'true') {
          setCortexDetectMessage('');
        } else {
          setCortexDetectMessage('Cortex-Debug extension is NOT installed (or disabled)', '#aa0000', true);
        }
        break;
      }
      case 'updateDeviceDetect': {
        const device = (event.data.device ?? '') as string;
        const deviceNameText = document.getElementById('deviceName') as TextField | null;
        const deviceDetectInfo = document.getElementById('deviceDetectInfo') as HTMLElement | null;
        // Only track the auto value when it actually landed in the field —
        // otherwise a user-typed value that happens to match a future
        // detection would be misclassified as auto and later clobbered.
        if (deviceNameText && device
          && (!deviceNameText.value.trim() || deviceNameText.value === lastAutoDetectedDevice)) {
          deviceNameText.value = device;
          lastAutoDetectedDevice = device;
        }
        if (deviceDetectInfo) {
          deviceDetectInfo.textContent = device
            ? ''
            : 'Could not auto-detect the device — enter it manually';
        }
        hideSpinner('deviceNameSpinner');
        break;
      }
      case 'updateDefaultPort': {
        const defaultPort = (event.data.defaultPort ?? '') as string;
        const gdbPortText = document.getElementById('gdbPort') as TextField | null;
        // Track the default only when it was applied, so a user-typed port
        // equal to some runner's default is never treated as pristine.
        if (gdbPortText && defaultPort
          && (!gdbPortText.value.trim() || gdbPortText.value === lastDefaultGdbPort)) {
          gdbPortText.value = defaultPort;
          lastDefaultGdbPort = defaultPort;
        }
        break;
      }
      case 'fileSelected':
        setLocalPath(event.data.id, event.data.fileUri);
        break;
      case 'fileDialogClosed':
        hideBrowseSpinnerForField(event.data.id);
        break;
      case 'debugFinished': {
        setDebugButtonDisabled(false);
        break;
      }
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

function postPyocdManage() {
  const applicationInput = document.getElementById('applicationInput') as HTMLInputElement | null;
  const buildConfigInput = document.getElementById('buildConfigInput') as HTMLInputElement | null;
  webviewApi.postMessage({
    command: 'pyocdManage',
    project: applicationInput?.getAttribute('data-value') ?? '',
    buildConfig: buildConfigInput?.getAttribute('data-value') ?? '',
  });
}

function pyocdManageHandler(this: HTMLElement, ev: MouseEvent) {
  postPyocdManage();
}

function resetHandler(this: HTMLElement, ev: MouseEvent) {
  const applicationInput = document.getElementById('applicationInput') as HTMLInputElement;
  const buildConfigInput = document.getElementById('buildConfigInput') as HTMLInputElement;

  webviewApi.postMessage({
    command: 'reset',
    project: applicationInput.getAttribute('data-value'),
    buildConfig: buildConfigInput.getAttribute('data-value') ? buildConfigInput.getAttribute('data-value') : '',
    backend: getSelectedBackend()
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
    backend: getSelectedBackend(),
    programPath: programPath.value,
    svdPath: svdPath.value,
    gdbPath: gdbPath.value,
    gdbAddress: gdbAddress.value,
    gdbPort: gdbPort.value,
    gdbMode: gdbModeRadioGroup.value,
    runner: runnerInput.getAttribute('data-value'),
    runnerPath: runnerPath.value,
    runnerArgs: runnerArgs.value,
    device: (document.getElementById('deviceName') as TextField | null)?.value ?? '',
    deviceInterface: (document.getElementById('deviceInterface') as RadioGroup | null)?.value ?? 'swd'
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

  setDebugButtonDisabled(true);
  webviewApi.postMessage({
    command: 'debug',
    project: applicationInput.getAttribute('data-value'),
    buildConfig: buildConfigInput.getAttribute('data-value') ? buildConfigInput.getAttribute('data-value') : '',
    backend: getSelectedBackend(),
    programPath: programPath.value,
    svdPath: svdPath.value,
    gdbPath: gdbPath.value,
    gdbAddress: gdbAddress.value,
    gdbPort: gdbPort.value,
    gdbMode: gdbModeRadioGroup.value,
    runner: runnerInput.getAttribute('data-value'),
    runnerPath: runnerPath.value,
    runnerArgs: runnerArgs.value,
    device: (document.getElementById('deviceName') as TextField | null)?.value ?? '',
    deviceInterface: (document.getElementById('deviceInterface') as RadioGroup | null)?.value ?? 'swd'
  });
}

function showBrowseSpinnersWhileLoading() {
  showSpinner('programPathSpinner');
  showSpinner('gdbPathSpinner');
  hideSpinner('runnerPathSpinner');
}

function hideBrowseSpinners() {
  hideSpinner('programPathSpinner');
  hideSpinner('gdbPathSpinner');
  hideSpinner('runnerPathSpinner');
}

function initApplicationsDropdown() {
  const applicationInput = document.getElementById('applicationInput') as HTMLInputElement;
  const applicationsDropdown = document.getElementById('applicationsDropdown') as HTMLElement;
  const applicationDropdownSpinner = document.getElementById('applicationsDropdownSpinner') as HTMLElement;
  const buildConfigDropdownSpinner = document.getElementById('buildConfigDropdownSpinner') as HTMLElement;

  const openDropdown = () => {
    if (applicationsDropdown) { applicationsDropdown.style.display = 'block'; }
  };

  applicationInput.addEventListener('focusin', openDropdown);
  applicationInput.addEventListener('click', openDropdown);

  applicationInput.addEventListener('focusout', () => {
    if (applicationsDropdown) {applicationsDropdown.style.display = 'none';}
  });

  applicationInput.addEventListener('input', () => {
    if (buildConfigDropdownSpinner) {buildConfigDropdownSpinner.style.display = 'inline-block';}
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
  const buildConfigDropdownSpinner = document.getElementById('buildConfigDropdownSpinner') as HTMLElement;

  buildConfigInput.addEventListener('focusin', () => {
    if (buildConfigDropdown) {buildConfigDropdown.style.display = 'block';}
  });

  buildConfigInput.addEventListener('focusout', () => {
    if (buildConfigDropdown) {buildConfigDropdown.style.display = 'none';}
  });

  buildConfigInput.addEventListener('click', () => {
    if (buildConfigDropdown) {buildConfigDropdown.style.display = 'block';}
  });

  buildConfigInput.addEventListener('input', () => {
    // Show spinners when build config changes, as heavy work begins now.
    showBrowseSpinnersWhileLoading();
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

  // Ensure spinner is hidden on initial load
  if (buildConfigDropdownSpinner) {buildConfigDropdownSpinner.style.display = 'none';}
}

function initRunnersDropdown() {
  const runnerInput = document.getElementById('runnerInput') as HTMLInputElement;
  const runnersDropdown = document.getElementById('runnersDropdown') as HTMLElement;
  const runnerPath = document.getElementById('runnerPath') as TextField;

  runnerInput.addEventListener('focusin', () => {
    if (runnersDropdown) {runnersDropdown.style.display = 'block';}
  });

  runnerInput.addEventListener('focusout', () => {
    if (runnersDropdown) {runnersDropdown.style.display = 'none';}
  });

  runnerInput.addEventListener('click', () => {
    if (runnersDropdown) {runnersDropdown.style.display = 'block';}
  });

  runnerInput.addEventListener('input', () => {
    // Clear previous detection text before triggering new detection
    const runnerPathText = document.getElementById('runnerPath') as TextField;
    const backend = getSelectedBackend();
    setRunnerDetectMessage('');
    if (runnerPathText) {
      runnerPathText.value = '';
    }
    if (backend === 'cortex-native' && runnerInput.getAttribute('data-value') === 'jlink') {
      showSpinner('deviceNameSpinner');
    }
    // A runner change resets the form server-side (keeping the runner);
    // surface the same loading feedback as a build-config change.
    const buildConfigInput = document.getElementById('buildConfigInput') as HTMLInputElement | null;
    if (buildConfigInput?.getAttribute('data-value') && runnerInput.getAttribute('data-value')) {
      showBrowseSpinnersWhileLoading();
      updateRunnerDefaultInfo('', '');
    }
    webviewApi.postMessage({
      command: 'runnerChanged',
      runner: runnerInput.getAttribute('data-value'),
      runnerPath: '',
      backend,
    });
    runnerPathHiddenForSelectedRunner();
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
  const buildConfigDropdownSpinner = document.getElementById('buildConfigDropdownSpinner') as HTMLElement;

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
    // Apply pending selection if exists
    if (pendingConfigName && buildConfigInput.getAttribute('data-value') !== pendingConfigName) {
      const option = buildConfigDropdown.querySelector(`[data-value="${pendingConfigName}"]`) as HTMLElement | null;
      if (option) {
        buildConfigInput.value = option.getAttribute('data-label') || pendingConfigName;
        buildConfigInput.setAttribute('data-value', pendingConfigName);
        buildConfigInput.dispatchEvent(new Event('input'));
        pendingConfigName = '';
      }
    }
  } else {
    buildConfigInput.disabled = true;
  }
  if (buildConfigDropdownSpinner) {buildConfigDropdownSpinner.style.display = 'none';}
}

function updateConfig(data: any) {
  const backend = data.backend === 'cortex-west' || data.backend === 'cortex-native' ? data.backend : 'cppdbg';
  const programPath = data.programPath;
  const svdPath = data.svdPath;
  const gdbPath = data.gdbPath;
  const gdbAddress = data.gdbAddress ?? 'localhost';
  const gdbPort = data.gdbPort ?? '3333';
  const gdbMode = data.gdbMode;
  const runnersHTML = data.runnersHTML;
  const runner = data.runnerName;
  const runnerValue = data.runnerValue;
  const runnerPath = data.runnerPath;
  const runnerArgs = data.runnerArgs;
  const runnerDefaultInfo = data.runnerDefaultInfo;
  const runnerDefaultPathInfo = data.runnerDefaultPathInfo;

  const programPathText = document.getElementById('programPath') as TextField;
  const svdPathText = document.getElementById('svdPath') as TextField;
  const gdbPathText = document.getElementById('gdbPath') as TextField;
  const gdbAddressText = document.getElementById('gdbAddress') as TextField;
  const gdbPortText = document.getElementById('gdbPort') as TextField;
  const gdbModeRadioGroup = document.getElementById("gdbMode") as RadioGroup;
  const backendRadioGroup = document.getElementById("debugBackend") as RadioGroup | null;
  const runnerInput = document.getElementById('runnerInput') as HTMLInputElement;
  const runnersDropdown = document.getElementById('runnersDropdown') as HTMLElement;
  const runnerPathText = document.getElementById('runnerPath') as TextField;
  const runnerArgsText = document.getElementById('runnerArgs') as TextField;
  const deviceNameText = document.getElementById('deviceName') as TextField | null;
  const deviceInterfaceGroup = document.getElementById('deviceInterface') as RadioGroup | null;

  programPathText.value = programPath ?? '';
  svdPathText.value = svdPath ?? '';
  gdbPathText.value = gdbPath ?? '';
  gdbAddressText.value = gdbAddress ?? '';
  gdbPortText.value = gdbPort ?? '';
  gdbModeRadioGroup.value = gdbMode ?? 'program';
  if (deviceNameText) {
    deviceNameText.value = data.device ?? '';
  }
  // A device restored from launch.json is user-owned: never let a later
  // auto-detection overwrite it (only updateDeviceDetect marks auto values).
  lastAutoDetectedDevice = '';
  const deviceDetectInfo = document.getElementById('deviceDetectInfo') as HTMLElement | null;
  if (deviceDetectInfo) {
    deviceDetectInfo.textContent = '';
  }
  if (deviceInterfaceGroup) {
    deviceInterfaceGroup.value = data.deviceInterface === 'jtag' ? 'jtag' : 'swd';
  }
  lastDefaultGdbPort = data.defaultGdbPort ?? '';

  // Always replace the dropdown contents — assigning an empty string clears it
  // so a previous application's runners don't leak into the new selection.
  // The list depends on the backend: full west runner list vs. native servers.
  cachedWestRunnersHTML = runnersHTML ?? '';
  cachedNativeRunnersHTML = data.nativeRunnersHTML ?? '';
  const activeRunnersHTML = backend === 'cortex-native' ? cachedNativeRunnersHTML : cachedWestRunnersHTML;
  runnersDropdown.innerHTML = activeRunnersHTML;
  if (activeRunnersHTML.length > 0) {
    addDropdownItemEventListeners(runnersDropdown, runnerInput);
  }

  // Set the backend radio AFTER the caches/fields above are consistent: the
  // toolkit radio-group fires 'change' synchronously on programmatic writes,
  // so the listener is suppressed for this assignment.
  if (backendRadioGroup && backendRadioGroup.value !== backend) {
    suppressBackendChangeEvent = true;
    try {
      backendRadioGroup.value = backend;
    } finally {
      suppressBackendChangeEvent = false;
    }
  }

  const selectedRunner = (
    (runnerValue
      ? runnersDropdown.querySelector(`.dropdown-item[data-value="${runnerValue}"]`)
      : null)
    ?? (runner
      ? runnersDropdown.querySelector(`.dropdown-item[data-label="${runner}"]`)
      : null)
  ) as HTMLDivElement | null;
  if (selectedRunner) {
    runnerInput.value = selectedRunner.getAttribute('data-label') || '';
    runnerInput.setAttribute('data-value', selectedRunner.getAttribute('data-value') || '');
  } else {
    // No matching runner in the new dropdown — clear the input so we don't
    // show a stale runner name with cleared path/args underneath.
    runnerInput.value = '';
    runnerInput.setAttribute('data-value', '');
  }

  runnerPathText.value = runnerPath ?? '';
  runnerArgsText.value = runnerArgs ?? '';
  updateRunnerDefaultInfo(runnerDefaultInfo ?? '', runnerDefaultPathInfo ?? '');

  programPathText.dispatchEvent(new Event('input'));
  svdPathText.dispatchEvent(new Event('input'));
  gdbPathText.dispatchEvent(new Event('input'));
  runnerPathText.dispatchEvent(new Event('input'));
  runnerPathHiddenForSelectedRunner();

  hideSpinner('programPathSpinner');
  hideSpinner('gdbPathSpinner');
  if ((runnerPathText.value ?? '').trim().length > 0) {
    hideSpinner('runnerPathSpinner');
  }
}

function updateRunnerConfig(runnerPath: string, runnerArgs: string, runnerDefaultInfo?: string, runnerDefaultPathInfo?: string) {
  const runnerPathText = document.getElementById('runnerPath') as TextField;
  const runnerArgsText = document.getElementById('runnerArgs') as TextField;
  runnerPathText.value = runnerPath ?? '';
  runnerPathText.dispatchEvent(new Event('input'));
  runnerArgsText.value = runnerArgs ?? '';
  runnerArgsText.dispatchEvent(new Event('input'));
  updateRunnerDefaultInfo(runnerDefaultInfo ?? '', runnerDefaultPathInfo ?? '');
  runnerPathHiddenForSelectedRunner();

  if ((runnerPath ?? '').trim().length > 0) {hideSpinner('runnerPathSpinner');}
}

function updateRunnerDefaultInfo(runnerDefaultInfo: string, runnerDefaultPathInfo: string) {
  const runnerDefaultInfoRow = document.getElementById('runnerDefaultInfoRow') as HTMLElement | null;
  const runnerDefaultInfoSpan = document.getElementById('runnerDefaultInfo') as HTMLElement | null;
  const runnerDefaultPathInfoSpan = document.getElementById('runnerDefaultPathInfo') as HTMLElement | null;
  if (!runnerDefaultInfoRow || !runnerDefaultInfoSpan || !runnerDefaultPathInfoSpan) {
    return;
  }
  const resolvedDefaultInfo = (runnerDefaultInfo ?? '').trim();
  const resolvedPathInfo = (runnerDefaultPathInfo ?? '').trim();
  runnerDefaultInfoSpan.textContent = resolvedDefaultInfo;
  runnerDefaultPathInfoSpan.textContent = resolvedPathInfo;
  runnerDefaultInfoRow.style.display = resolvedDefaultInfo.length > 0 ? '' : 'none';
}

function updateRunnerDetect(
  runnerDetect: boolean,
  runnerName: string,
  runnerDefaultInfo?: string,
  runnerDefaultPathInfo?: string,
  runnerVersion?: string,
) {
  const resolvedRunnerName = (runnerName ?? '').trim();
  updateRunnerDefaultInfo(runnerDefaultInfo ?? '', runnerDefaultPathInfo ?? '');
  hideSpinner('runnerPathSpinner');
  if (!resolvedRunnerName) {
    setRunnerDetectMessage('Choose a runner', "#aa0000");
    runnerPathHiddenForSelectedRunner();
    return;
  }
  if (runnerDetect === true) {
    const resolvedVersion = (runnerVersion ?? '').trim();
    setRunnerDetectMessage(
      resolvedVersion.length > 0
        ? `${resolvedRunnerName} is installed (version ${resolvedVersion})`
        : `${resolvedRunnerName} is installed`,
      "#00aa00",
    );
  } else if (runnerDetect === false) {
    setRunnerDetectMessage(`${resolvedRunnerName} is NOT installed`, "#aa0000", true);
  } else {
    console.warn('Unexpected value for runnerDetect:', runnerDetect);
  }
  runnerPathHiddenForSelectedRunner();
}

// Pending selections to be made once dropdowns are populated
let pendingProjectPath: string = '';
let pendingConfigName: string = '';

function pathApplicationSelection() {
  if (!pendingProjectPath){
    return;
  }
  const input = document.getElementById('applicationInput') as HTMLInputElement | null;
  const dropdown = document.getElementById('applicationsDropdown') as HTMLElement | null;
  if (!input || !dropdown)
  {
    return;
  }
  if (input.getAttribute('data-value') === pendingProjectPath){
    return;
  }

  const option = Array.from(dropdown.children).find(el => (el as HTMLElement).getAttribute('data-value') === pendingProjectPath) as HTMLElement | undefined;

  if (option) {
    input.value = option.getAttribute('data-label') || '';
    input.setAttribute('data-value', option.getAttribute('data-value') || '');
    input.dispatchEvent(new Event('input'));
    pendingProjectPath = '';
  }
}
