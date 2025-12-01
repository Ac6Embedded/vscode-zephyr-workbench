import { provideVSCodeDesignSystem, allComponents } from "@vscode/webview-ui-toolkit";

provideVSCodeDesignSystem().register(allComponents);

const webviewApi = acquireVsCodeApi();

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
  if (selected === "USER") div.style.display = "grid";
  else div.style.display = "none";
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
      case "eclair-status": {
        const line = document.getElementById("status-line");
        if (line) {
          if (msg.installed) line.innerHTML = `Eclair: <span class="status-installed">Installed</span> (version ${msg.version})`;
          else line.innerHTML = `Eclair: <span class="status-missing">Not installed version</span>`;
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
        if (f) f.value = msg.path || "";
        break;
      }
      case "set-extra-config": {
        const f = document.getElementById("extra-config") as any;
        if (f) f.value = msg.path || "";
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
    webviewApi.postMessage({ command: "open-license" });
  });
  document.getElementById("manage-license")?.addEventListener("click", () => {
    webviewApi.postMessage({ command: "open-license" });
  });
  document.getElementById("probe-btn")?.addEventListener("click", () => {
    webviewApi.postMessage({ command: "probe-eclair" });
  });
  document.getElementById("browse-install")?.addEventListener("click", () => {
    webviewApi.postMessage({ command: "browse-install-path" });
  });
  document.getElementById("browse-config")?.addEventListener("click", () => {
    webviewApi.postMessage({ command: "browse-extra-config" });
  });

  updateUserRulesetVisibility();
  handleReportsAllToggle();
}

window.addEventListener("load", main);
