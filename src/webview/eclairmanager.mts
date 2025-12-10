import { provideVSCodeDesignSystem, allComponents } from "@vscode/webview-ui-toolkit";

provideVSCodeDesignSystem().register(allComponents);

const webviewApi = acquireVsCodeApi();

function setEditMode(inputEl: HTMLInputElement | null, browseBtn: HTMLElement | null, editBtn: HTMLElement | null, editing: boolean) {
  if (!inputEl || !browseBtn || !editBtn) return;
  (inputEl as any).disabled = !editing;
  (browseBtn as any).disabled = !editing;
  (editBtn as any).textContent = editing ? 'Done' : 'Edit';
  if (editing) inputEl.focus();
}

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

function toggleConfigEdit() {
  const input = document.getElementById('extra-config') as HTMLInputElement | null;
  const browse = document.getElementById('browse-config') as HTMLElement | null;
  const editBtn = document.getElementById('edit-config') as HTMLElement | null;
  if (!input || !browse || !editBtn) return;
  const isEdit = (editBtn.textContent || '') === 'Edit';
  setEditMode(input, browse, editBtn, isEdit);
}

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

function handleReportsAllToggle() {
  const checks = Array.from(document.querySelectorAll('.report-chk')) as any[];
  const allChk = checks.find(c => c.getAttribute('value') === 'ALL') as any;
  if (!allChk) return;
  if (allChk.checked) {
    checks.forEach(c => { if (c.getAttribute('value') !== 'ALL') c.checked = false; });
  }
}

function preventAllConflict(ev: any) {
  const tgt = ev.target as HTMLElement | null;
  if (!tgt || !tgt.classList.contains('report-chk')) return;
  const val = tgt.getAttribute('value');
  const checks = Array.from(document.querySelectorAll('.report-chk')) as any[];
  const all = checks.find(c => c.getAttribute('value') === 'ALL') as any;
  if (val !== 'ALL' && all && all.checked) all.checked = false;
  if (val === 'ALL') handleReportsAllToggle();
}

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
        if (f) {
          const p = (msg.path ?? '').toString().trim();
          f.value = p;
          f.placeholder = '';
        }
        const browse = document.getElementById('browse-path-button-eclair') as HTMLElement | null;
        const editBtn = document.getElementById('edit-path-eclair') as HTMLElement | null;
        setEditMode(f as HTMLInputElement, browse, editBtn, false);
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
        if (f) {
          const t = (msg.text ?? '').toString();
          f.value = t;
          f.placeholder = '';
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
    }
  });
}

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
    }
  });

  updateUserRulesetVisibility();
  handleReportsAllToggle();
}

window.addEventListener("load", main);
