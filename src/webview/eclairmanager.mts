// Register VSCode Webview UI Toolkit components
import { provideVSCodeDesignSystem, allComponents } from "@vscode/webview-ui-toolkit";

provideVSCodeDesignSystem().register(allComponents);

const webviewApi = acquireVsCodeApi();

// VSCode API for messaging between webview and extension backend

/**
 * Enables or disables edit mode for a text field and its related buttons.
 * Used for all Edit/Done logic in the UI.
 */
function setEditMode(inputEl: HTMLInputElement | null, browseBtn: HTMLElement | null, editBtn: HTMLElement | null, editing: boolean) {
  if (!inputEl || !editBtn) return;
  (inputEl as any).disabled = !editing;
  if (browseBtn) (browseBtn as any).disabled = !editing;
  (editBtn as any).textContent = editing ? 'Done' : 'Edit';
  if (editing) inputEl.focus();
}

/**
 * Handles Edit/Done logic for the Eclair install path field.
 * On Done, sends the new path to the backend to update env.yml.
 */
function toggleInstallEdit() {
  const input = document.getElementById('details-path-input-eclair') as HTMLInputElement | null;
  const browse = document.getElementById('browse-path-button-eclair') as HTMLElement | null;
  const editBtn = document.getElementById('edit-path-eclair') as HTMLElement | null;
  if (!input || !browse || !editBtn) return;
  const isEdit = (editBtn.textContent || '') === 'Edit';
  // When leaving edit mode, persist the value to env.yml via backend
  if (!isEdit) {
    const newPath = (input.value || '').trim();
    webviewApi.postMessage({ command: 'update-path', tool: 'eclair', newPath });
  }
  setEditMode(input, browse, editBtn, isEdit);
}

/**
 * Handles Edit/Done logic for the Additional Configuration (.ecl) field.
 * On Done, sends the new path to the backend.
 */
function toggleConfigEdit() {
  const input = document.getElementById('extra-config') as HTMLInputElement | null;
  const browse = document.getElementById('browse-config') as HTMLElement | null;
  const editBtn = document.getElementById('edit-config') as HTMLElement | null;
  if (!input || !browse || !editBtn) return;
  const isEdit = (editBtn.textContent || '') === 'Edit';
  if (!isEdit) {
    const newPath = (input.value || '').trim();
    webviewApi.postMessage({ command: 'update-extra-config', newPath });
  }
  setEditMode(input, browse, editBtn, isEdit);
}

/**
 * Collects all current config values from the UI fields.
 * Used to send settings to the backend for persistence.
 */
function collectConfig() {
  const installPath = (document.getElementById("install-path") as any)?.value?.trim?.() || "";
  const extraConfig = (document.getElementById("extra-config") as any)?.value?.trim?.() || "";
  const radios = Array.from(document.querySelectorAll('vscode-radio[name="ruleset"]')) as any[];
  const selected = (radios.find(r => (r as any).checked) as any)?.value || "ECLAIR_RULESET_FIRST_ANALYSIS";
  const userName = (document.getElementById("user-ruleset-name") as any)?.value?.trim?.() || "";
  const userPath = (document.getElementById("user-ruleset-path") as any)?.value?.trim?.() || "";
  const reports = Array.from(document.querySelectorAll('.report-chk'))
    .filter((c: any) => !!c.checked)
    .map((c: any) => c.getAttribute('value') || '')
    .filter(Boolean) as string[];
  return { installPath, extraConfig, ruleset: selected, userRulesetName: userName, userRulesetPath: userPath, reports };
}

/**
 * Shows or hides the user ruleset fields based on the selected ruleset radio.
 */
function updateUserRulesetVisibility() {
  const radios = Array.from(document.querySelectorAll('vscode-radio[name="ruleset"]')) as any[];
  const selected = (radios.find(r => (r as any).checked) as any)?.value;
  const div = document.getElementById("user-ruleset-fields") as HTMLElement | null;
  if (!div) return;
  const isUser = selected === "USER";
  if (isUser) {
    div.classList.remove('hidden');
  } else {
    div.classList.add('hidden');
  }
}

/**
 * Ensures that when 'ALL' is checked, all other report checkboxes are unchecked.
 */
function handleReportsAllToggle() {
  const checks = Array.from(document.querySelectorAll('.report-chk')) as any[];
  const allChk = checks.find(c => c.getAttribute('value') === 'ALL') as any;
  if (!allChk) return;
  if (allChk.checked) {
    checks.forEach(c => { if (c.getAttribute('value') !== 'ALL') c.checked = false; });
  }
}

/**
 * Prevents conflicting selection between 'ALL' and individual report checkboxes.
 */
function preventAllConflict(ev: any) {
  const tgt = ev.target as HTMLElement | null;
  if (!tgt || !tgt.classList.contains('report-chk')) return;
  const val = tgt.getAttribute('value');
  const checks = Array.from(document.querySelectorAll('.report-chk')) as any[];
  const all = checks.find(c => c.getAttribute('value') === 'ALL') as any;
  if (val !== 'ALL' && all && all.checked) all.checked = false;
  if (val === 'ALL') handleReportsAllToggle();
}

/**
 * Listens for messages from the backend and updates the UI accordingly.
 * Handles all UI state sync from extension to webview.
 */
function setVSCodeMessageListener() {
  window.addEventListener("message", (ev: MessageEvent) => {
    const msg: any = ev.data;
    switch (msg.command) {
      case "toggle-spinner": {
        const show = !!msg.show;
        const sp = document.getElementById('em-spinner');
        if (sp) {
          if (show) sp.classList.remove('hidden');
          else sp.classList.add('hidden');
        }
        break;
      }
      case "eclair-status": {
        const installed = !!msg.installed;
        const verSpan = document.getElementById('eclair-version');
        const icon = document.getElementById('eclair-status-icon');
        const text = document.getElementById('eclair-status-text');
        if (verSpan) (verSpan as HTMLElement).textContent = installed ? (String(msg.version || '').trim() || 'Unknown') : 'Unknown';
        if (icon && text) {
          icon.classList.add('codicon');
          icon.classList.remove('codicon-warning', 'warning-icon', 'codicon-check', 'success-icon');
          if (installed) {
            icon.classList.add('codicon-check', 'success-icon');
            (text as HTMLElement).textContent = 'Installed';
          } else {
            icon.classList.add('codicon-warning', 'warning-icon');
            (text as HTMLElement).textContent = 'Not installed';
          }
        }
        break;
      }
      case "set-install-path": {
        const f = document.getElementById("details-path-input-eclair") as any;
        const browse = document.getElementById('browse-path-button-eclair') as HTMLElement | null;
        const editBtn = document.getElementById('edit-path-eclair') as HTMLElement | null;
        if (f) {
          const p = (msg.path ?? '').toString().trim();
          // Show special markers (Checking / Not Found) as visible, styled value
            if (!p || p === "Not Found" || p === "Checking") {
              // show the text as the input value but keep the field disabled so it appears faded
              f.value = p || "Not Found";
              f.placeholder = "";
              f.disabled = true;
              // ensure no custom placeholder styling overrides the disabled appearance
              try { f.classList.remove('em-placeholder-value'); } catch {}
            } else {
              f.value = p;
              f.placeholder = "";
              f.disabled = true;
              try { f.classList.remove('em-placeholder-value'); } catch {}
            }
        }
        if (editBtn) editBtn.textContent = 'Edit';
        try { setEditMode(f as HTMLInputElement, browse, editBtn, false); } catch {}
        break;
      }
      case "set-extra-config": {
        const f = document.getElementById("extra-config") as any;
        if (f) f.value = msg.path || "";
        const browse = document.getElementById('browse-config') as HTMLElement | null;
        const editBtn = document.getElementById('edit-config') as HTMLElement | null;
        setEditMode(f as HTMLInputElement, browse, editBtn, false);
        break;
      }
      case "set-path-status": {
        const f = document.getElementById("details-path-input-eclair") as any;
        const browse = document.getElementById('browse-path-button-eclair') as HTMLElement | null;
        if (f) {
          const t = (msg.text ?? '').toString();
            if (!t || t === "Not Found" || t === "Checking") {
              f.value = t || "Not Found";
              f.placeholder = "";
              f.disabled = true;
              try { f.classList.remove('em-placeholder-value'); } catch {}
            } else {
              f.value = t;
              f.placeholder = "";
              f.disabled = true;
              try { f.classList.remove('em-placeholder-value'); } catch {}
            }
        }
        break;
      }
      case "set-install-path-placeholder": {
        const f = document.getElementById("details-path-input-eclair") as any;
        if (f) {
          const t = (msg.text ?? '').toString();
          f.placeholder = t;
        }
        break;
      }
       case "set-user-ruleset-name": {
        const f = document.getElementById("user-ruleset-name") as any;
        const editBtn = document.getElementById('edit-user-ruleset-name') as HTMLElement | null;
        if (f) {
          f.value = msg.name || "";
          f.disabled = true;
        }
        if (editBtn) editBtn.textContent = 'Edit';
        setEditMode(f as HTMLInputElement, null, editBtn, false);
        break;
      }
      case "set-user-ruleset-path": {
        const f = document.getElementById("user-ruleset-path") as any;
        const browseBtn = document.getElementById('browse-user-ruleset-path') as HTMLElement | null;
        const editBtn = document.getElementById('edit-user-ruleset-path') as HTMLElement | null;
        if (f) {
          f.value = msg.path || "";
          f.disabled = true;
        }
        if (editBtn) editBtn.textContent = 'Edit';
        setEditMode(f as HTMLInputElement, browseBtn, editBtn, false);
        // Save automatically when a new path is received from the browser
        const cfg = collectConfig();
        webviewApi.postMessage({ command: 'save-sca-config', data: cfg });
        break;
      }
    }
  });
}

/**
 * Main entry point for the webview UI logic.
 * Sets up all event listeners and initializes the UI state.
 */
function main() {
  setVSCodeMessageListener();

  document.querySelectorAll('vscode-radio[name="ruleset"]').forEach(r => {
    r.addEventListener("change", updateUserRulesetVisibility);
  });
  document.querySelectorAll('.report-chk').forEach(c => {
    c.addEventListener('change', preventAllConflict);
  });

  document.getElementById("generate-cmd")?.addEventListener("click", () => {
    const cfg = collectConfig();
    webviewApi.postMessage({ command: "save-sca-config", data: cfg });
  });
  document.getElementById("run-cmd")?.addEventListener("click", () => {
    webviewApi.postMessage({ command: "run-command", data: collectConfig() });
  });
  document.getElementById("manage-license")?.addEventListener("click", () => {
    webviewApi.postMessage({ command: "manage-license" });
  });
  document.getElementById("request-trial")?.addEventListener("click", () => {
    webviewApi.postMessage({ command: "request-trial" });
  });
  document.getElementById("about-eclair")?.addEventListener("click", () => {
    webviewApi.postMessage({ command: "about-eclair" });
  });
  document.getElementById("btn-refresh-status")?.addEventListener("click", () => {
    webviewApi.postMessage({ command: "refresh-status" });
  });
  document.getElementById("probe-btn")?.addEventListener("click", () => {
    webviewApi.postMessage({ command: "probe-eclair" });
  });
  document.getElementById('edit-path-eclair')?.addEventListener('click', () => toggleInstallEdit());
  document.getElementById('browse-path-button-eclair')?.addEventListener('click', () => {
    webviewApi.postMessage({ command: 'browse-path', tool: 'eclair' });
  });
  document.getElementById('edit-config')?.addEventListener('click', () => toggleConfigEdit());
  document.getElementById('browse-config')?.addEventListener('click', () => {
    webviewApi.postMessage({ command: 'browse-extra-config' });
  });

  // User ruleset name edit logic 
  document.getElementById('edit-user-ruleset-name')?.addEventListener('click', () => {
    const input = document.getElementById('user-ruleset-name') as HTMLInputElement | null;
    const editBtn = document.getElementById('edit-user-ruleset-name') as HTMLElement | null;
    if (!input || !editBtn) return;
    const isEdit = (editBtn.textContent || '') === 'Edit';
    if (!isEdit) {
      const cfg = collectConfig();
      webviewApi.postMessage({ command: 'save-sca-config', data: cfg });
    }
    setEditMode(input, null, editBtn, isEdit);
  });

  // User ruleset path edit logic 
  document.getElementById('edit-user-ruleset-path')?.addEventListener('click', () => {
    const input = document.getElementById('user-ruleset-path') as HTMLInputElement | null;
    const browseBtn = document.getElementById('browse-user-ruleset-path') as HTMLElement | null;
    const editBtn = document.getElementById('edit-user-ruleset-path') as HTMLElement | null;
    if (!input || !editBtn || !browseBtn) return;
    const isEdit = (editBtn.textContent || '') === 'Edit';
    if (!isEdit) {
      const cfg = collectConfig();
      webviewApi.postMessage({ command: 'save-sca-config', data: cfg });
    }
    setEditMode(input, browseBtn, editBtn, isEdit);
  });

  // Browse button for user-ruleset-path
  document.getElementById('browse-user-ruleset-path')?.addEventListener('click', (ev) => {
    const btn = ev.currentTarget as HTMLElement | null;
    if (btn && !btn.hasAttribute('disabled')) {
      webviewApi.postMessage({ command: 'browse-user-ruleset-path' });
    }
  });

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const active = document.activeElement as HTMLElement | null;
    if (!active) return;
    if (active.id === 'details-path-input-eclair') {
      const btn = document.getElementById('edit-path-eclair') as HTMLElement | null;
      if (btn && btn.textContent === 'Done') { e.preventDefault(); (btn as any).click(); }
    } else if (active.id === 'extra-config') {
      const btn = document.getElementById('edit-config') as HTMLElement | null;
      if (btn && btn.textContent === 'Done') { e.preventDefault(); (btn as any).click(); }
    } else if (active.id === 'user-ruleset-name') {
      const btn = document.getElementById('edit-user-ruleset-name') as HTMLElement | null;
      if (btn && btn.textContent === 'Done') { e.preventDefault(); (btn as any).click(); }
    } else if (active.id === 'user-ruleset-path') {
      const btn = document.getElementById('edit-user-ruleset-path') as HTMLElement | null;
      if (btn && btn.textContent === 'Done') { e.preventDefault(); (btn as any).click(); }
    }
  });

  updateUserRulesetVisibility();
  handleReportsAllToggle();
}

// Initialize the UI when the webview loads
window.addEventListener("load", main);
