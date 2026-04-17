/******************************************************************
 *  vscode-zephyr-workbench · importsdk.mts  (Webview side)
 ******************************************************************/

import {
  provideVSCodeDesignSystem,
  Button,
  Checkbox,
  RadioGroup,
  TextField,
  vsCodeButton,
  vsCodeCheckbox,
  vsCodeTextField,
  vsCodeRadio,
  vsCodeRadioGroup,
  vsCodePanels,
  vsCodePanelView,
  vsCodePanelTab,
} from "@vscode/webview-ui-toolkit/";

provideVSCodeDesignSystem().register(
  vsCodeButton(),
  vsCodeCheckbox(),
  vsCodeTextField(),
  vsCodeRadio(),
  vsCodeRadioGroup(),
  vsCodePanels(),
  vsCodePanelTab(),
  vsCodePanelView(),
);

type IarSdkEntry = {
  path: string;
  name: string;
  version: string;
};

function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) { throw new Error(`Missing #${id} in Webview DOM`); }
  return el as T;
}

const vscode = acquireVsCodeApi();
let cachedToolchains: string[] = [];
let lastToolchainVersion = "";
let pendingToolchainVersion = "";
let versionsLoading = false;
let versionsLoaded = false;
let versionLoadError = "";

window.addEventListener("load", () => {
  setVSCodeMessageListener();
  initVersionsDropdown();
  initIarSdkDropdown();
  requestImportSdkData();

  const sourceCat = getEl<RadioGroup>("sourceCategory");
  const zephyrSub = getEl<RadioGroup>("srcTypeZephyr");
  const sdkTypeSub = getEl<RadioGroup>("sdkType");

  sourceCat.addEventListener("click", modifyCategoryHandler);
  sourceCat.addEventListener("select", modifyCategoryHandler);
  zephyrSub.addEventListener("click", modifySrcTypeHandler);
  zephyrSub.addEventListener("select", modifySrcTypeHandler);
  getEl<RadioGroup>("srcTypeIar")
    .addEventListener("select", modifySrcTypeHandler);

  sdkTypeSub.addEventListener("click", modifySdkTypeHandler);
  sdkTypeSub.addEventListener("select", modifySdkTypeHandler);

  getEl<Button>("browseLocationButton")
    .addEventListener("click", () => {
      vscode.postMessage({ command: "openLocationDialog", id: "workspacePath" });
    });

  getEl<Button>("importButton")
    .addEventListener("click", importHandler);

  sourceCat.dispatchEvent(new Event("select"));
  modifySdkTypeHandler();
});

function setVSCodeMessageListener(): void {
  window.addEventListener("message", (event) => {
    const { command } = event.data;
    switch (command) {
      case "folderSelected":
        switch (event.data.id) {
          case "sdkInput": {
            const sdkInput = getEl<HTMLInputElement>("sdkInput");
            sdkInput.value = event.data.folderUri;
            sdkInput.setAttribute("data-value", event.data.folderUri);
            break;
          }
          case "workspacePath": {
            (getEl<TextField>("workspacePath") as unknown as { value: string }).value =
              event.data.folderUri;
            break;
          }
          case "iarPath": {
            (getEl<TextField>("iarPath") as unknown as { value: string }).value =
              event.data.folderUri;
            break;
          }
        }
        break;

      case "importSdkData":
        applyVersionList(event.data.versions ?? [], event.data.versionError);
        applyIarSdkList(event.data.sdks ?? [], event.data.sdkError);
        break;

      case "toolchainList":
        applyToolchainList(event.data.toolchains ?? [], event.data.version);
        break;

      case "toolchainError":
        renderToolchainError(
          event.data.message ?? "Unable to load toolchains.",
          event.data.version,
        );
        break;
    }
  });
}

function requestImportSdkData(): void {
  versionsLoading = true;
  versionsLoaded = false;
  versionLoadError = "";
  renderVersionLoading();
  renderIarSdkLoading();
  vscode.postMessage({ command: "fetchImportSdkData" });
}

function modifyCategoryHandler(): void {
  const cat = (getEl<RadioGroup>("sourceCategory") as unknown as { value: string }).value;
  getEl("zephyrOptions").style.display = cat === "zephyr" ? "block" : "none";
  getEl("iarOptions").style.display = cat === "iar" ? "block" : "none";

  modifySrcTypeHandler();
}

function modifySrcTypeHandler(): void {
  const catRadio = getEl<RadioGroup>("sourceCategory") as unknown as { value: string };
  const zephyrGroup = getEl<RadioGroup>("srcTypeZephyr") as unknown as { value: string };

  const officialForm = getEl("official-form");
  const remotePath = getEl<TextField>("remotePath");
  const iarForm = getEl("iar-form");

  if (catRadio.value === "zephyr") {
    if (zephyrGroup.value === "official") {
      officialForm.style.display = "block";
      remotePath.setAttribute("disabled", "");
      remotePath.style.display = "none";
      iarForm.style.display = "none";
    } else if (zephyrGroup.value === "remote") {
      officialForm.style.display = "none";
      remotePath.removeAttribute("disabled");
      remotePath.style.display = "block";
      iarForm.style.display = "none";
    } else {
      officialForm.style.display = "none";
      remotePath.setAttribute("disabled", "");
      remotePath.style.display = "none";
      iarForm.style.display = "none";
    }
  } else {
    officialForm.style.display = "none";
    remotePath.setAttribute("disabled", "");
    remotePath.style.display = "none";
    iarForm.style.display = "block";
  }
}

function modifySdkTypeHandler(): void {
  const minimal = isMinimalSelected();
  toggleToolchainContainer(minimal);
  setToolchainsEnabled(minimal);
  if (minimal) {
    loadMinimalToolchains();
  } else {
    clearToolchainContainer();
    if (!versionsLoading) {
      toggleVersionSpinner(false);
    }
  }
  updateLlvmRowVisibility();
}

function isV1OrLater(versionTag: string): boolean {
  const v = versionTag.startsWith("v") ? versionTag.slice(1) : versionTag;
  const major = parseInt(v.split(".")[0], 10);
  return Number.isFinite(major) && major >= 1;
}

function updateLlvmRowVisibility(): void {
  const row = document.getElementById("llvmToolchainRow");
  if (!row) { return; }
  const show = isMinimalSelected() && isV1OrLater(getSelectedVersionTag());
  if (show) {
    row.style.display = "block";
    row.style.paddingBottom = "10px";
  } else {
    row.style.display = "none";
    row.style.paddingBottom = "";
    const cb = document.getElementById("llvmToolchain") as unknown as { checked: boolean } | null;
    if (cb) { cb.checked = false; }
  }
}

function isMinimalSelected(): boolean {
  return (getEl<RadioGroup>("sdkType") as unknown as { value: string }).value === "minimal";
}

function getSelectedVersionTag(): string {
  const raw = getEl<HTMLInputElement>("versionInput").getAttribute("data-value") ?? "";
  if (!raw) { return ""; }
  return raw.startsWith("v") ? raw : `v${raw}`;
}

function loadMinimalToolchains(): void {
  updateLlvmRowVisibility();
  toggleToolchainContainer(true);

  if (versionsLoading) {
    renderToolchainPlaceholder("Loading SDK versions...");
    setToolchainsEnabled(false);
    return;
  }

  if (versionLoadError) {
    renderToolchainPlaceholder(`Failed to load SDK versions: ${versionLoadError}`);
    setToolchainsEnabled(false);
    return;
  }

  const version = getSelectedVersionTag();
  if (!version) {
    renderToolchainPlaceholder(
      versionsLoaded
        ? "Select a version to load toolchains."
        : "No SDK versions available.",
    );
    setToolchainsEnabled(false);
    return;
  }

  if (version === pendingToolchainVersion) {
    return;
  }

  if (version === lastToolchainVersion && cachedToolchains.length) {
    renderToolchainList(cachedToolchains, true);
    return;
  }

  pendingToolchainVersion = version;
  renderToolchainLoading(version);
  vscode.postMessage({
    command: "fetchMinimalToolchains",
    version,
  });
}

function applyToolchainList(toolchains: string[], version?: string): void {
  if (version && pendingToolchainVersion && version !== pendingToolchainVersion) {
    return;
  }
  cachedToolchains = toolchains ?? [];
  lastToolchainVersion = version ?? "";
  pendingToolchainVersion = "";
  renderToolchainList(cachedToolchains, isMinimalSelected());
}

function renderToolchainLoading(version: string): void {
  toggleToolchainContainer(true);
  toggleVersionSpinner(true);
  renderToolchainPlaceholder(`Loading toolchains for ${version}...`);
  setToolchainsEnabled(false);
}

function renderToolchainError(message: string, version?: string): void {
  const suffix = version ? ` (${version})` : "";
  renderToolchainPlaceholder(`Failed to load toolchains${suffix}: ${message}`);
  setToolchainsEnabled(false);
  pendingToolchainVersion = "";
  toggleVersionSpinner(false);
}

function renderToolchainList(toolchains: string[], enabled: boolean): void {
  toggleToolchainContainer(true);
  toggleVersionSpinner(false);
  const container = getToolchainContainer();
  const ordered = orderToolchains(toolchains);
  if (!toolchains.length) {
    renderToolchainPlaceholder("No toolchains available for this platform.");
    return;
  }

  const primaryToolchains = ordered.filter(toolchain => !isXtensaToolchain(toolchain));
  const xtensaToolchains = ordered.filter(isXtensaToolchain);

  const primaryMarkup = renderToolchainItems(primaryToolchains, enabled);
  const xtensaMarkup = xtensaToolchains.length
    ? `
      <details class="toolchain-collapse">
        <summary>Xtensa toolchains (${xtensaToolchains.length})</summary>
        <div class="toolchain-collapse-content">
          ${renderToolchainItems(xtensaToolchains, enabled)}
        </div>
      </details>
    `
    : "";

  container.innerHTML = `${primaryMarkup}${xtensaMarkup}`;
  setToolchainsEnabled(enabled);
}

function renderToolchainPlaceholder(message: string): void {
  const container = getToolchainContainer();
  container.innerHTML = `<div class="toolchain-placeholder">${escapeHtml(message)}</div>`;
}

function setToolchainsEnabled(enabled: boolean): void {
  const cbs = document.getElementsByClassName("toolchain-checkbox") as HTMLCollectionOf<Checkbox>;
  Array.from(cbs).forEach(cb => {
    if (enabled) { cb.removeAttribute("disabled"); }
    else { cb.setAttribute("disabled", ""); }
  });
}

function getToolchainContainer(): HTMLElement {
  return getEl("toolchainsContainer");
}

function toggleToolchainContainer(visible: boolean): void {
  const container = getToolchainContainer();
  const section = document.getElementById("toolchainSection");
  container.style.display = visible ? "grid" : "none";
  if (section) {
    section.style.display = visible ? "block" : "none";
  }
}

function clearToolchainContainer(): void {
  const container = getToolchainContainer();
  container.innerHTML = "";
  pendingToolchainVersion = "";
  setToolchainsEnabled(false);
  if (!versionsLoading) {
    toggleVersionSpinner(false);
  }
}

function orderToolchains(toolchains: string[]): string[] {
  const priority = [
    "aarch64",
    "arm",
    "riscv64",
    "xtensa-espressif_esp32s3",
  ];
  const priorityMap = new Map(priority.map((name, idx) => [name, idx]));

  return [...toolchains].sort((a, b) => {
    const aPrio = priorityMap.has(a) ? priorityMap.get(a)! : Number.MAX_SAFE_INTEGER;
    const bPrio = priorityMap.has(b) ? priorityMap.get(b)! : Number.MAX_SAFE_INTEGER;

    if (aPrio !== bPrio) {
      return aPrio - bPrio;
    }

    return toolchains.indexOf(a) - toolchains.indexOf(b);
  });
}

function renderToolchainItems(toolchains: string[], enabled: boolean): string {
  return toolchains.map(toolchain => `
    <div>
      <vscode-checkbox class="toolchain-checkbox"
                       value="${escapeHtml(toolchain)}"
                       current-value="${escapeHtml(toolchain)}"
                       ${enabled ? "" : "disabled"}>${escapeHtml(toolchain)}</vscode-checkbox>
    </div>
  `).join("");
}

function isXtensaToolchain(toolchain: string): boolean {
  return toolchain.startsWith("xtensa-");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function toggleVersionSpinner(show: boolean): void {
  const sp = document.getElementById("toolchainSpinner") as HTMLElement | null;
  if (!sp) { return; }
  sp.style.display = show ? "inline-block" : "none";
}

function initIarSdkDropdown(): void {
  const sdkInput = getEl<HTMLInputElement>("sdkInput");
  const sdkDropdown = getEl("sdkDropdown");

  ["focusin", "click"].forEach(evt => {
    sdkInput.addEventListener(evt, () => {
      sdkDropdown.style.display = "block";
    });
  });
  sdkInput.addEventListener("focusout", () => {
    setTimeout(() => { sdkDropdown.style.display = "none"; }, 80);
  });

  addDropdownItemListeners(sdkDropdown, sdkInput);
}

function renderIarSdkLoading(): void {
  const sdkInput = getEl<HTMLInputElement>("sdkInput");
  const sdkDropdown = getEl("sdkDropdown");
  sdkInput.value = "";
  sdkInput.setAttribute("data-value", "");
  sdkInput.placeholder = "Loading SDKs...";
  sdkInput.setAttribute("disabled", "");
  sdkDropdown.innerHTML = `<div class="dropdown-placeholder">Loading SDKs...</div>`;
}

function applyIarSdkList(sdks: IarSdkEntry[], error?: string): void {
  const sdkInput = getEl<HTMLInputElement>("sdkInput");
  const sdkDropdown = getEl("sdkDropdown");

  if (error) {
    sdkInput.value = "";
    sdkInput.setAttribute("data-value", "");
    sdkInput.placeholder = "Unable to load SDKs";
    sdkInput.setAttribute("disabled", "");
    sdkDropdown.innerHTML = `<div class="dropdown-placeholder">${escapeHtml(error)}</div>`;
    return;
  }

  if (!sdks.length) {
    sdkInput.value = "";
    sdkInput.setAttribute("data-value", "");
    sdkInput.placeholder = "No registered SDKs";
    sdkInput.setAttribute("disabled", "");
    sdkDropdown.innerHTML = `<div class="dropdown-placeholder">No registered SDKs found.</div>`;
    return;
  }

  sdkInput.removeAttribute("disabled");
  sdkInput.placeholder = "Choose your SDK...";
  sdkDropdown.innerHTML = sdks.map((sdk) => `
    <div class="dropdown-item"
         data-value="${escapeHtml(sdk.path)}"
         data-label="${escapeHtml(sdk.name)}">
      ${escapeHtml(sdk.name)}
      <span class="description">${escapeHtml(sdk.version)}</span>
    </div>
  `).join("");
}

function importHandler(): void {
  const isZephyr = (getEl<RadioGroup>("sourceCategory") as unknown as { value: string }).value === "zephyr";
  const srcType = isZephyr
    ? (getEl<RadioGroup>("srcTypeZephyr") as unknown as { value: string }).value
    : "iar";

  vscode.postMessage({
    command: "import",
    srcType,
    remotePath: (getEl<TextField>("remotePath") as unknown as { value: string }).value,
    workspacePath: (getEl<TextField>("workspacePath") as unknown as { value: string }).value,
    sdkType: (getEl<RadioGroup>("sdkType") as unknown as { value: string }).value,
    sdkVersion: getEl<HTMLInputElement>("versionInput").getAttribute("data-value"),
    listToolchains: getListSelectedToolchains(),
    includeLlvm: isLlvmSelected(),
    iarZephyrSdkPath: getEl<HTMLInputElement>("sdkInput").getAttribute("data-value") || "",
    iarToken: (getEl<TextField>("iarToken") as unknown as { value: string }).value,
  });
}

function isLlvmSelected(): boolean {
  const cb = document.getElementById("llvmToolchain") as unknown as { checked?: boolean } | null;
  return !!cb?.checked;
}

function initVersionsDropdown(): void {
  const versionInput = getEl<HTMLInputElement>("versionInput");
  const versionsDropdown = getEl("versionsDropdown");

  ["focusin", "click"].forEach(evt => {
    versionInput.addEventListener(evt, () => {
      versionsDropdown.style.display = "block";
    });
  });
  versionInput.addEventListener("focusout", () => {
    setTimeout(() => { versionsDropdown.style.display = "none"; }, 80);
  });

  addDropdownItemListeners(versionsDropdown, versionInput, () => {
    if (isMinimalSelected()) {
      loadMinimalToolchains();
    }
    updateLlvmRowVisibility();
  });
}

function renderVersionLoading(): void {
  const versionInput = getEl<HTMLInputElement>("versionInput");
  const versionsDropdown = getEl("versionsDropdown");

  versionInput.value = "";
  versionInput.setAttribute("data-value", "");
  versionInput.placeholder = "Loading SDK versions...";
  versionInput.setAttribute("disabled", "");
  versionsDropdown.innerHTML = `<div class="dropdown-placeholder">Loading SDK versions...</div>`;
  toggleVersionSpinner(true);
}

function applyVersionList(versions: string[], error?: string): void {
  const versionInput = getEl<HTMLInputElement>("versionInput");
  const versionsDropdown = getEl("versionsDropdown");
  const currentValue = versionInput.getAttribute("data-value") ?? "";

  versionsLoading = false;
  versionLoadError = error ?? "";
  toggleVersionSpinner(false);

  if (error) {
    versionsLoaded = false;
    versionInput.value = "";
    versionInput.setAttribute("data-value", "");
    versionInput.placeholder = "Unable to load SDK versions";
    versionInput.setAttribute("disabled", "");
    versionsDropdown.innerHTML = `<div class="dropdown-placeholder">${escapeHtml(error)}</div>`;
    if (isMinimalSelected()) {
      loadMinimalToolchains();
    }
    updateLlvmRowVisibility();
    return;
  }

  versionsLoaded = versions.length > 0;
  if (!versions.length) {
    versionInput.value = "";
    versionInput.setAttribute("data-value", "");
    versionInput.placeholder = "No SDK versions available";
    versionInput.setAttribute("disabled", "");
    versionsDropdown.innerHTML = `<div class="dropdown-placeholder">No SDK versions available.</div>`;
    if (isMinimalSelected()) {
      loadMinimalToolchains();
    }
    updateLlvmRowVisibility();
    return;
  }

  versionInput.removeAttribute("disabled");
  versionInput.placeholder = "Choose the SDK version...";
  versionsDropdown.innerHTML = versions.map((version) => {
    const clean = version.replace(/^v/, "");
    return `<div class="dropdown-item"
                 data-value="${escapeHtml(clean)}"
                 data-label="${escapeHtml(version)}">${escapeHtml(version)}</div>`;
  }).join("");

  const preferredValue = currentValue && versions.some((version) => version.replace(/^v/, "") === currentValue)
    ? currentValue
    : versions[0].replace(/^v/, "");
  const preferredLabel = versions.find((version) => version.replace(/^v/, "") === preferredValue) ?? versions[0];

  versionInput.value = preferredLabel;
  versionInput.setAttribute("data-value", preferredValue);

  if (isMinimalSelected()) {
    loadMinimalToolchains();
  }
  updateLlvmRowVisibility();
}

function addDropdownItemListeners(
  dropdown: HTMLElement,
  input: HTMLInputElement,
  onSelect?: () => void,
): void {
  if (dropdown.dataset.bound === "true") {
    return;
  }
  dropdown.dataset.bound = "true";

  dropdown.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement | null;
    const item = target?.closest<HTMLElement>(".dropdown-item");
    if (!item || !dropdown.contains(item)) {
      return;
    }
    if (item.dataset.value === "browse") {
      return;
    }
    input.value = item.dataset.label ?? "";
    input.setAttribute("data-value", item.dataset.value ?? "");
    input.dispatchEvent(new Event("input"));
    dropdown.style.display = "none";
    onSelect?.();
  });
}

function getListSelectedToolchains(): string {
  const cbs = document.getElementsByClassName("toolchain-checkbox") as HTMLCollectionOf<Checkbox>;
  return Array.from(cbs)
    .filter(cb => (cb as unknown as { checked: boolean }).checked)
    .map(cb => (cb as unknown as { value: string }).value || "")
    .filter(Boolean)
    .join(" ");
}
