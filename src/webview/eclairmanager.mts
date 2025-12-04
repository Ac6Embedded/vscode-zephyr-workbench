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
  const input = document.getElementById('install-path') as HTMLInputElement | null;
  const browse = document.getElementById('browse-install') as HTMLElement | null;
  const editBtn = document.getElementById('edit-install') as HTMLElement | null;
  if (!input || !browse || !editBtn) return;
  const isEdit = (editBtn.textContent || '') === 'Edit';
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
      case "show-command": {
        const box = document.getElementById("cmd-output");
        if (box) (box as HTMLElement).textContent = msg.cmd || "";
        break;
      }
      case "set-install-path": {
        const f = document.getElementById("install-path") as any;
        if (f) {
          const p = (msg.path ?? '').toString().trim();
          f.value = p.length > 0 ? p : 'Not installed';
        }
        const browse = document.getElementById('browse-install') as HTMLElement | null;
        const editBtn = document.getElementById('edit-install') as HTMLElement | null;
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
        const f = document.getElementById("install-path") as any;
        if (f) {
          const t = (msg.text ?? '').toString();
          f.value = t;
        }
        break;
      }
      case "set-install-path-placeholder": {
        const f = document.getElementById("install-path") as any;
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
    webviewApi.postMessage({ command: "generate-command", data: collectConfig() });
  });
  document.getElementById("run-cmd")?.addEventListener("click", () => {
    webviewApi.postMessage({ command: "run-command", data: collectConfig() });
  });
  document.getElementById("check-license")?.addEventListener("click", () => {
    webviewApi.postMessage({ command: "check-license" });
  });
  document.getElementById("btn-refresh-status")?.addEventListener("click", () => {
    webviewApi.postMessage({ command: "refresh-status" });
  });
  document.getElementById("probe-btn")?.addEventListener("click", () => {
    webviewApi.postMessage({ command: "probe-eclair" });
  });
  document.getElementById('edit-install')?.addEventListener('click', () => toggleInstallEdit());
  document.getElementById('browse-install')?.addEventListener('click', () => {
    webviewApi.postMessage({ command: 'browse-install-path' });
  });
  document.getElementById('edit-config')?.addEventListener('click', () => toggleConfigEdit());
  document.getElementById('browse-config')?.addEventListener('click', () => {
    webviewApi.postMessage({ command: 'browse-extra-config' });
  });

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const active = document.activeElement as HTMLElement | null;
    if (!active) return;
    if (active.id === 'install-path') {
      const btn = document.getElementById('edit-install') as HTMLElement | null;
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
