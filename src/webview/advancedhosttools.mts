import { allComponents, provideVSCodeDesignSystem } from "@vscode/webview-ui-toolkit/";

provideVSCodeDesignSystem().register(allComponents);

const webviewApi = acquireVsCodeApi();

window.addEventListener("load", main);

interface PartStatus {
  part: string;
  label: string;
  present: boolean;
  detectedVersion: string;
  systemDetected: boolean;
}

let lastParts: PartStatus[] = [];
let probeDebounce: number | undefined;

function getPythonMode(): string {
  const checked = document.querySelector('.python-source-radio:checked') as HTMLInputElement | null;
  return checked?.getAttribute('data-mode') ?? 'portable';
}

function getCustomPythonPath(): string {
  const field = document.getElementById('custom-python-path') as HTMLInputElement | null;
  return (field?.value ?? '').trim();
}

function getRequirementsRef(): string {
  const input = document.getElementById('requirementsRefInput') as HTMLInputElement | null;
  return (input?.value ?? '').trim();
}

function getPythonSelection(): { mode: string; path?: string; requirementsRef: string } {
  const mode = getPythonMode();
  const requirementsRef = getRequirementsRef();
  if (mode === 'custom') {
    return { mode, path: getCustomPythonPath(), requirementsRef };
  }
  return { mode, requirementsRef };
}

function setDetectionLine(html: string) {
  const line = document.getElementById('python-detection');
  if (line) { line.innerHTML = html; }
}

function requestPythonProbe() {
  const mode = getPythonMode();
  const spinner = document.getElementById('python-spinner');
  if (mode === 'portable') {
    setDetectionLine('<span class="codicon codicon-info"></span> The portable Python is downloaded by the installer when missing.');
    return;
  }
  if (mode === 'custom' && getCustomPythonPath() === '') {
    setDetectionLine('<span class="codicon codicon-info"></span> Enter or browse the path to a python executable.');
    return;
  }
  spinner?.classList.remove('hidden');
  webviewApi.postMessage({ command: 'probe-python', mode, path: mode === 'custom' ? getCustomPythonPath() : undefined });
}

function schedulePythonProbe() {
  if (probeDebounce !== undefined) { window.clearTimeout(probeDebounce); }
  probeDebounce = window.setTimeout(() => { requestPythonProbe(); }, 400);
}

function setActionsEnabled(enabled: boolean) {
  const ids = ['btn-install-selected', 'btn-reinstall-all', 'btn-rebuild-venv', 'btn-select-missing', 'btn-select-all', 'btn-unselect-all'];
  for (const id of ids) {
    const el = document.getElementById(id) as any;
    if (el) { el.disabled = !enabled; }
  }
  document.querySelectorAll('.install-part-button').forEach(btn => { (btn as any).disabled = !enabled; });
}

function hideAllWheels() {
  document.querySelectorAll('.progress-wheel').forEach(w => { (w as HTMLElement).style.display = 'none'; });
}

function showResultLine(text: string, isError: boolean) {
  const line = document.getElementById('result-line');
  const textEl = document.getElementById('result-text');
  if (!line || !textEl) { return; }
  textEl.textContent = text;
  line.classList.remove('hidden');
  line.classList.toggle('result-error', isError);
}

function renderVenvStatus(venvPresent: boolean) {
  const line = document.getElementById('venv-status');
  if (!line) { return; }
  if (venvPresent) {
    line.innerHTML = '<span class="codicon codicon-check success-icon"></span> Global virtual environment: present';
  } else {
    line.innerHTML = '<span class="codicon codicon-info"></span> Global virtual environment: not created yet, it will be installed with the next run';
  }
}

function renderStatus(parts: PartStatus[], anyInstalled: boolean) {
  lastParts = parts;
  for (const p of parts) {
    const statusCell = document.getElementById(`status-${p.part}`);
    const detectedCell = document.getElementById(`detected-${p.part}`);
    if (statusCell) {
      if (p.present) {
        statusCell.innerHTML = '<span class="codicon codicon-check success-icon"></span> Installed';
      } else if (p.systemDetected) {
        // Not in the zinstaller install, but a system-wide tool was found.
        statusCell.innerHTML = '<span class="codicon codicon-info"></span> System only';
      } else {
        statusCell.innerHTML = '<span class="codicon codicon-circle-slash"></span> Not installed';
      }
    }
    if (detectedCell) {
      let detected = p.detectedVersion ?? '';
      if (detected && p.systemDetected) {
        detected = `${detected} (system)`;
      }
      detectedCell.textContent = detected;
    }
  }
  // Full reinstall and venv rebuild only make sense once something exists.
  document.getElementById('other-actions-section')?.classList.toggle('hidden', !anyInstalled);
}

function setCheckboxes(predicate: (p: PartStatus) => boolean) {
  for (const p of lastParts) {
    const box = document.getElementById(`check-${p.part}`) as HTMLInputElement | null;
    if (box) { box.checked = predicate(p); }
  }
}

function getCheckedParts(): string[] {
  const parts: string[] = [];
  document.querySelectorAll('.part-checkbox').forEach(box => {
    const input = box as HTMLInputElement;
    if (input.checked) {
      const part = input.getAttribute('data-part');
      if (part) { parts.push(part); }
    }
  });
  return parts;
}

function main() {
  setVSCodeMessageListener();
  hideAllWheels();

  // Python source radios: show/hide the custom row and probe on change.
  document.querySelectorAll('.python-source-radio').forEach(radio => {
    radio.addEventListener('change', () => {
      const customRow = document.getElementById('custom-python-row');
      if (customRow) { customRow.classList.toggle('hidden', getPythonMode() !== 'custom'); }
      requestPythonProbe();
    });
  });

  const customField = document.getElementById('custom-python-path');
  customField?.addEventListener('input', () => schedulePythonProbe());
  customField?.addEventListener('blur', () => requestPythonProbe());

  document.getElementById('browse-python-button')?.addEventListener('click', (e) => {
    e.preventDefault();
    webviewApi.postMessage({ command: 'browse-python-path' });
  });

  document.getElementById('btn-refresh-status')?.addEventListener('click', () => {
    webviewApi.postMessage({ command: 'refresh-status' });
  });

  document.getElementById('btn-select-missing')?.addEventListener('click', () => setCheckboxes(p => !p.present));
  document.getElementById('btn-select-all')?.addEventListener('click', () => setCheckboxes(() => true));
  document.getElementById('btn-unselect-all')?.addEventListener('click', () => setCheckboxes(() => false));

  document.getElementById('btn-install-selected')?.addEventListener('click', () => {
    document.getElementById('result-line')?.classList.add('hidden');
    webviewApi.postMessage({ command: 'install-selected', parts: getCheckedParts(), python: getPythonSelection() });
  });

  document.querySelectorAll('.install-part-button').forEach(button => {
    button.addEventListener('click', () => {
      const part = button.getAttribute('data-part');
      if (!part) { return; }
      const wheel = document.getElementById(`progress-${part}`);
      if (wheel) { (wheel as HTMLElement).style.display = 'block'; }
      setActionsEnabled(false);
      webviewApi.postMessage({ command: 'install-part', part, python: getPythonSelection() });
    });
  });

  // Reinstall everything sits behind an in-view confirmation.
  document.getElementById('btn-reinstall-all')?.addEventListener('click', () => {
    document.getElementById('confirm-overlay')?.classList.remove('hidden');
  });
  document.getElementById('confirm-cancel')?.addEventListener('click', () => {
    document.getElementById('confirm-overlay')?.classList.add('hidden');
  });
  document.getElementById('confirm-ok')?.addEventListener('click', () => {
    document.getElementById('confirm-overlay')?.classList.add('hidden');
    document.getElementById('result-line')?.classList.add('hidden');
    webviewApi.postMessage({ command: 'reinstall-all', python: getPythonSelection() });
  });

  document.getElementById('btn-rebuild-venv')?.addEventListener('click', () => {
    document.getElementById('result-line')?.classList.add('hidden');
    webviewApi.postMessage({ command: 'rebuild-venv' });
  });

  document.getElementById('open-terminal-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    webviewApi.postMessage({ command: 'open-terminal' });
  });

  setupRequirementsCombo();

  requestPythonProbe();
  webviewApi.postMessage({ command: 'webview-ready' });
  webviewApi.postMessage({ command: 'fetch-requirements-refs' });
}

function filterRequirementsDropdown(needleRaw: string) {
  const dropdown = document.getElementById('requirementsRefDropdown');
  if (!dropdown) { return; }
  const needle = needleRaw.trim().toLowerCase();
  dropdown.querySelectorAll('.dropdown-item').forEach(item => {
    const label = (item.getAttribute('data-label') ?? '').toLowerCase();
    (item as HTMLElement).style.display = (needle === '' || label.includes(needle)) ? '' : 'none';
  });
}

function setupRequirementsCombo() {
  const input = document.getElementById('requirementsRefInput') as HTMLInputElement | null;
  const dropdown = document.getElementById('requirementsRefDropdown');
  if (!input || !dropdown) { return; }

  const show = () => { (dropdown as HTMLElement).style.display = 'block'; };
  const hide = () => { (dropdown as HTMLElement).style.display = 'none'; };

  // Opening the combo always shows EVERYTHING; the list narrows only while
  // the user is actually typing.
  input.addEventListener('focus', () => { filterRequirementsDropdown(''); show(); });
  input.addEventListener('click', () => { filterRequirementsDropdown(''); show(); });
  input.addEventListener('input', () => { filterRequirementsDropdown(input.value); show(); });

  // mousedown so the selection lands before the input loses focus.
  dropdown.addEventListener('mousedown', (event) => {
    const item = (event.target as HTMLElement | null)?.closest('.dropdown-item');
    if (!item) { return; }
    event.preventDefault();
    const value = item.getAttribute('data-value') ?? '';
    input.value = value;
    input.setAttribute('data-value', value);
    hide();
  });

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (target && !target.closest('#requirementsCombo')) { hide(); }
  });

  document.getElementById('requirementsRefreshButton')?.addEventListener('click', (e) => {
    e.preventDefault();
    input.placeholder = 'Loading Zephyr versions...';
    webviewApi.postMessage({ command: 'fetch-requirements-refs' });
  });

  hide();
}

function setVSCodeMessageListener() {
  window.addEventListener("message", (event) => {
    const command = event.data.command;
    switch (command) {
      case 'toggle-spinner': {
        const spinner = document.getElementById('aht-spinner');
        if (spinner) { spinner.classList.toggle('hidden', !event.data.show); }
        setActionsEnabled(!event.data.show);
        if (!event.data.show) { hideAllWheels(); }
        break;
      }
      case 'status-updated': {
        renderStatus(Array.isArray(event.data.parts) ? event.data.parts : [], event.data.anyInstalled === true);
        renderVenvStatus(event.data.venvPresent === true);
        break;
      }
      case 'python-probe-result': {
        document.getElementById('python-spinner')?.classList.add('hidden');
        // Ignore stale results after the user switched modes.
        if (event.data.mode !== getPythonMode()) { break; }
        if (event.data.ok) {
          const version = String(event.data.version ?? '');
          const exePath = String(event.data.exePath ?? '');
          if (event.data.tooOld) {
            setDetectionLine(`<span class="codicon codicon-warning warning-icon"></span> Detected: ${exePath} (${version}). This Python is older than 3.12, the minimum recommended by current Zephyr requirements.`);
          } else {
            setDetectionLine(`<span class="codicon codicon-check success-icon"></span> Detected: ${exePath} (${version})`);
          }
        } else {
          setDetectionLine(`<span class="codicon codicon-error error-icon"></span> ${String(event.data.error ?? 'Python not detected')}`);
        }
        break;
      }
      case 'python-path-selected': {
        const field = document.getElementById('custom-python-path') as HTMLInputElement | null;
        if (field) { field.value = String(event.data.path ?? ''); }
        requestPythonProbe();
        break;
      }
      case 'requirements-refs-updated': {
        const dropdown = document.getElementById('requirementsRefDropdown');
        const input = document.getElementById('requirementsRefInput') as HTMLInputElement | null;
        if (dropdown) { dropdown.innerHTML = String(event.data.refsHTML ?? ''); }
        if (input) {
          input.placeholder = 'Zephyr tag or branch (e.g. v4.2.0, main)';
          // Only preset the default when the user has not typed anything yet.
          if (input.value.trim() === '') {
            const defaultRef = String(event.data.defaultRef ?? 'main');
            input.value = defaultRef;
            input.setAttribute('data-value', defaultRef);
          }
        }
        break;
      }
      case 'install-finished': {
        hideAllWheels();
        if (typeof event.data.message === 'string' && event.data.message.length > 0) {
          showResultLine(event.data.message, !event.data.ok);
          break;
        }
        if (event.data.kind === 'reinstall-all') {
          showResultLine(event.data.ok
            ? 'Reinstall finished successfully.'
            : 'Reinstall finished with failures. Check the terminal output for the per-step summary.', !event.data.ok);
          break;
        }
        const installed: string[] = Array.isArray(event.data.installed) ? event.data.installed : [];
        const failed: string[] = Array.isArray(event.data.failed) ? event.data.failed : [];
        let text = '';
        if (event.data.ok) {
          text = installed.length > 0
            ? `Result: ${installed.length} part(s) installed (${installed.join(', ')}).`
            : 'Run finished successfully.';
        } else {
          text = failed.length > 0
            ? `Result: ${installed.length} installed, ${failed.length} failed (${failed.join(', ')}). Check the terminal output.`
            : 'Run finished with failures. Check the terminal output for the per-step summary.';
        }
        showResultLine(text, !event.data.ok);
        break;
      }
      case 'install-part-finished': {
        const wheel = document.getElementById(`progress-${event.data.part}`);
        if (wheel) { (wheel as HTMLElement).style.display = 'none'; }
        setActionsEnabled(true);
        showResultLine(event.data.ok
          ? `${String(event.data.part)} installed successfully.`
          : `${String(event.data.part)} failed to install. Check the terminal output.`, !event.data.ok);
        break;
      }
      case 'venv-rebuild-finished': {
        showResultLine(event.data.ok
          ? 'Virtual environment rebuilt successfully.'
          : 'Virtual environment rebuild failed. Check the terminal output.', !event.data.ok);
        break;
      }
    }
  });
}
