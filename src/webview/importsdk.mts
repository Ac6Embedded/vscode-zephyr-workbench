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

type ArmGnuReleaseEntry = {
  version: string;
  displayVersion: string;
  releasedAt?: string;
};

type ArmGnuAssetEntry = {
  version: string;
  displayVersion: string;
  releasedAt?: string;
  hostId: string;
  hostLabel: string;
  targetTriple: string;
  targetLabel: string;
  filename: string;
  url: string;
};

type RustupStatusData = {
  installed?: boolean;
  managed?: boolean;
  rustupPath?: string;
  version?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  managedRootDir?: string;
  toolchainsDir?: string;
  prereqOk?: boolean;
  prereqMessage?: string;
  prereqInstallable?: boolean;
  error?: string;
};

type RustImportData = {
  versions?: string[];
  targets?: string[];
  targetDescriptions?: Record<string, string>;
  error?: string;
};

type RegisteredArmGnuEntry = {
  name: string;
  path: string;
};

type LlvmImportData = {
  versions?: string[];
  error?: string;
};

// rustup channel offered on top of numbered versions (rustup method only;
// standalone dist archives exist for numbered releases).
const RUST_STABLE_CHANNEL = "stable";

// Pre-checked in Minimal mode: the Cortex-M4 (thumbv7em) and Cortex-M33
// (thumbv8m.main) compilers, soft and hard float ABIs.
const RUST_MINIMAL_PRESELECTED_TARGETS = [
  "thumbv7em-none-eabi",
  "thumbv7em-none-eabihf",
  "thumbv8m.main-none-eabi",
  "thumbv8m.main-none-eabihf",
];

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
let armGnuAssets: ArmGnuAssetEntry[] = [];
let armGnuReleases: ArmGnuReleaseEntry[] = [];
let lastSuggestedArmGnuFolderName = "";
let availableRustTargets: string[] = [];
let availableRustTargetDescriptions: Record<string, string> = {};
let availableRustVersions: string[] = [];
let lastSuggestedRustFolderName = "";

window.addEventListener("load", () => {
  setVSCodeMessageListener();
  initVersionsDropdown();
  initSdkAssociationDropdown("sdkInput", "sdkDropdown");
  initSdkAssociationDropdown("rustCToolchainInput", "rustCToolchainDropdown");
  initArmGnuVersionDropdown();
  initRustVersionDropdown();
  initLlvmVersionDropdown();
  requestImportSdkData();

  const sourceCat = getEl<RadioGroup>("sourceCategory");
  const zephyrSub = getEl<RadioGroup>("srcTypeZephyr");
  const armGnuSub = getEl<RadioGroup>("srcTypeArmGnu");
  const sdkTypeSub = getEl<RadioGroup>("sdkType");

  sourceCat.addEventListener("click", modifyCategoryHandler);
  sourceCat.addEventListener("select", modifyCategoryHandler);
  zephyrSub.addEventListener("click", modifySrcTypeHandler);
  zephyrSub.addEventListener("select", modifySrcTypeHandler);
  armGnuSub.addEventListener("click", modifySrcTypeHandler);
  armGnuSub.addEventListener("select", modifySrcTypeHandler);
  getEl<RadioGroup>("srcTypeIar")
    .addEventListener("select", modifySrcTypeHandler);
  const armGnuTargetGroup = getEl<RadioGroup>("armGnuTargetGroup");
  armGnuTargetGroup.addEventListener("click", updateArmGnuRecommendation);
  armGnuTargetGroup.addEventListener("select", updateArmGnuRecommendation);
  getEl<TextField>("armGnuFolderName").addEventListener("input", handleArmGnuFolderNameInput);

  sdkTypeSub.addEventListener("click", modifySdkTypeHandler);
  sdkTypeSub.addEventListener("select", modifySdkTypeHandler);

  getEl<Button>("browseLocationButton")
    .addEventListener("click", () => {
      vscode.postMessage({ command: "openLocationDialog", id: "workspacePath" });
    });

  getEl<Button>("importButton")
    .addEventListener("click", importHandler);

  getEl<Button>("installRustupButton")
    .addEventListener("click", installRustupHandler);

  getEl<Button>("installPrereqButton")
    .addEventListener("click", installPrereqHandler);

  const rustTypeSub = getEl<RadioGroup>("rustType");
  rustTypeSub.addEventListener("click", modifyRustTypeHandler);
  rustTypeSub.addEventListener("select", modifyRustTypeHandler);

  const rustMethodSub = getEl<RadioGroup>("srcTypeRust");
  rustMethodSub.addEventListener("click", modifySrcTypeHandler);
  rustMethodSub.addEventListener("select", modifySrcTypeHandler);

  getEl<TextField>("rustFolderName").addEventListener("input", handleRustFolderNameInput);

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
        applyArmGnuImportData(event.data.armGnu);
        applyRustupStatus(event.data.rustup);
        applyRustImportData(event.data.rust);
        applyRustLinkOptions(event.data.sdks ?? [], event.data.armGnuRegistered ?? []);
        applyLlvmVersionList(event.data.llvm);
        break;

      case "rustupStatus":
        applyRustupStatus(event.data.rustup);
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
  renderArmGnuVersionLoading();
  renderRustImportLoading();
  vscode.postMessage({ command: "fetchImportSdkData" });
}

function modifyCategoryHandler(): void {
  const cat = (getEl<RadioGroup>("sourceCategory") as unknown as { value: string }).value;
  getEl("zephyrOptions").style.display = cat === "zephyr" ? "block" : "none";
  getEl("armGnuOptions").style.display = cat === "arm-gnu" ? "block" : "none";
  getEl("iarOptions").style.display = cat === "iar" ? "block" : "none";

  modifySrcTypeHandler();
}

function modifySrcTypeHandler(): void {
  const catRadio = getEl<RadioGroup>("sourceCategory") as unknown as { value: string };
  const zephyrGroup = getEl<RadioGroup>("srcTypeZephyr") as unknown as { value: string };
  const armGnuGroup = getEl<RadioGroup>("srcTypeArmGnu") as unknown as { value: string };

  const officialForm = getEl("official-form");
  const remotePath = getEl<TextField>("remotePath");
  const armGnuForm = getEl("arm-gnu-form");
  const iarForm = getEl("iar-form");
  const rustForm = getEl("rust-form");
  const commonLocationForm = getEl("commonLocationForm");
  const importButtonRow = getEl("importButtonRow");

  officialForm.style.display = "none";
  remotePath.setAttribute("disabled", "");
  remotePath.style.display = "none";
  armGnuForm.style.display = "none";
  iarForm.style.display = "none";
  rustForm.style.display = "none";
  commonLocationForm.style.display = "";
  importButtonRow.style.display = "";

  if (catRadio.value === "zephyr") {
    if (zephyrGroup.value === "official") {
      officialForm.style.display = "block";
    } else if (zephyrGroup.value === "remote") {
      remotePath.removeAttribute("disabled");
      remotePath.style.display = "block";
    }
  } else if (catRadio.value === "arm-gnu") {
    armGnuForm.style.display = armGnuGroup.value === "arm-gnu" ? "block" : "none";
  } else if (catRadio.value === "rust") {
    rustForm.style.display = "block";
    const rustMethod = (getEl<RadioGroup>("srcTypeRust") as unknown as { value: string }).value;
    const standalone = rustMethod !== "rust-rustup";
    // Standalone assembles dist archives into a chosen Location; rustup
    // installs into the fixed managed location instead.
    commonLocationForm.style.display = standalone ? "" : "none";
    getEl("rustupSection").style.display = standalone ? "none" : "";
    getEl("rustFolderRow").style.display = standalone ? "" : "none";
    // Windows-only row (not rendered on other platforms).
    const mingwRow = document.getElementById("rustMingwRow");
    if (mingwRow) {
      mingwRow.style.display = standalone ? "" : "none";
    }
    renderRustVersionOptions();
  } else {
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

function initSdkAssociationDropdown(inputId: string, dropdownId: string): void {
  const sdkInput = getEl<HTMLInputElement>(inputId);
  const sdkDropdown = getEl(dropdownId);

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

function initArmGnuVersionDropdown(): void {
  const versionInput = getEl<HTMLInputElement>("armGnuVersionInput");
  const versionsDropdown = getEl("armGnuVersionsDropdown");

  ["focusin", "click"].forEach(evt => {
    versionInput.addEventListener(evt, () => {
      versionsDropdown.style.display = "block";
    });
  });
  versionInput.addEventListener("focusout", () => {
    setTimeout(() => { versionsDropdown.style.display = "none"; }, 80);
  });

  addDropdownItemListeners(versionsDropdown, versionInput, updateArmGnuRecommendation);
}

function renderArmGnuVersionLoading(): void {
  const versionInput = getEl<HTMLInputElement>("armGnuVersionInput");
  const versionsDropdown = getEl("armGnuVersionsDropdown");
  const folderField = getArmGnuFolderField();

  versionInput.value = "";
  versionInput.setAttribute("data-value", "");
  versionInput.placeholder = "Looking online for Arm GNU releases...";
  versionInput.setAttribute("disabled", "");
  versionsDropdown.innerHTML = `<div class="dropdown-placeholder">Looking online for Arm GNU releases...</div>`;
  folderField.value = "";
  setArmGnuFolderNameState("", false);
  toggleArmGnuSpinner(true);
}

function applyArmGnuImportData(data: {
  releases?: ArmGnuReleaseEntry[];
  assets?: ArmGnuAssetEntry[];
  error?: string;
} | undefined): void {
  armGnuAssets = data?.assets ?? [];
  armGnuReleases = data?.releases ?? [];

  const versionInput = getEl<HTMLInputElement>("armGnuVersionInput");
  const versionsDropdown = getEl("armGnuVersionsDropdown");
  toggleArmGnuSpinner(false);

  if (data?.error) {
    versionInput.value = "";
    versionInput.setAttribute("data-value", "");
    versionInput.placeholder = "Unable to load Arm GNU versions";
    versionInput.setAttribute("disabled", "");
    versionsDropdown.innerHTML = `<div class="dropdown-placeholder">${escapeHtml(data.error)}</div>`;
    setArmGnuTargetEnabled(false);
    setArmGnuFolderNameState("", false);
    return;
  }

  if (!armGnuReleases.length) {
    versionInput.value = "";
    versionInput.setAttribute("data-value", "");
    versionInput.placeholder = "No Arm GNU releases available";
    versionInput.setAttribute("disabled", "");
    versionsDropdown.innerHTML = `<div class="dropdown-placeholder">No Arm GNU releases available.</div>`;
    setArmGnuTargetEnabled(false);
    setArmGnuFolderNameState("", false);
    return;
  }

  versionInput.removeAttribute("disabled");
  versionInput.placeholder = "Choose the Arm GNU release...";
  versionsDropdown.innerHTML = armGnuReleases.map(release => {
    const description = release.releasedAt ? ` (${release.releasedAt})` : "";
    return `<div class="dropdown-item"
                 data-value="${escapeHtml(release.version)}"
                 data-label="${escapeHtml(`${release.displayVersion}${description}`)}">${escapeHtml(`${release.displayVersion}${description}`)}</div>`;
  }).join("");

  versionInput.value = "";
  versionInput.setAttribute("data-value", "");
  setArmGnuTargetEnabled(true);
  setArmGnuFolderNameState("", true);
}

function toggleArmGnuSpinner(show: boolean): void {
  const spinner = document.getElementById("armGnuSpinner") as HTMLElement | null;
  if (!spinner) { return; }
  spinner.style.display = show ? "inline-block" : "none";
}

function setArmGnuTargetEnabled(enabled: boolean): void {
  const targetGroup = getEl<RadioGroup>("armGnuTargetGroup");
  if (enabled) {
    targetGroup.removeAttribute("disabled");
  } else {
    targetGroup.setAttribute("disabled", "");
  }
}

function updateArmGnuRecommendation(): void {
  const version = getEl<HTMLInputElement>("armGnuVersionInput").getAttribute("data-value") ?? "";
  const targetTriple = (getEl<RadioGroup>("armGnuTargetGroup") as unknown as { value: string }).value;
  const folderField = getArmGnuFolderField();

  const selectedAsset = armGnuAssets.find(asset =>
    asset.version === version && asset.targetTriple === targetTriple
  );

  if (!selectedAsset) {
    updateArmGnuFolderName("", folderField.value);
    return;
  }

  updateArmGnuFolderName(getSuggestedArmGnuFolderName(selectedAsset.filename), folderField.value);
}

let rustupInstallInProgress = false;

function applyRustupStatus(status: RustupStatusData | undefined): void {
  rustupInstallInProgress = false;
  rustPrereqInstallInProgress = false;
  const statusLine = getEl("rustupStatusLine");
  const updateLine = getEl("rustupUpdateLine");
  const locationLine = getEl("rustupLocationLine");
  const prereqLine = getEl("rustupPrereqLine");
  const installRow = getEl("rustupInstallRow");
  const installButton = getEl<Button>("installRustupButton");
  const installPrereqButton = getEl<Button>("installPrereqButton");

  installButton.removeAttribute("disabled");
  installButton.textContent = "Download and install rustup";
  installPrereqButton.removeAttribute("disabled");
  installPrereqButton.textContent = "Install C++ Build Tools";

  if (!status || status.error) {
    statusLine.textContent = `Unable to check rustup: ${status?.error ?? "unknown error"}`;
    updateLine.style.display = "none";
    locationLine.textContent = "";
    prereqLine.textContent = "";
    installRow.style.display = "none";
    getEl("rustupActionsRow").style.display = "none";
    return;
  }

  if (status.installed) {
    const isLatest = !!status.version && !!status.latestVersion && !status.updateAvailable
      ? " (latest)"
      : "";
    const version = status.version ? ` ${status.version}${isLatest}` : "";
    const origin = status.managed ? "managed by Zephyr Workbench" : "found on PATH";
    statusLine.textContent = `rustup${version} is installed (${origin}): ${status.rustupPath ?? ""}`;
    installRow.style.display = "none";
  } else {
    const latest = status.latestVersion ? ` Latest version: ${status.latestVersion}.` : "";
    statusLine.textContent = `rustup is not installed.${latest}`;
    installRow.style.display = "";
  }

  if (status.installed && status.toolchainsDir) {
    locationLine.textContent = `Toolchains location: ${status.toolchainsDir}`;
  } else {
    locationLine.textContent = `Install location: ${status.managedRootDir ?? ""}`;
  }

  if (status.updateAvailable && status.latestVersion) {
    updateLine.textContent = `Warning: a newer rustup version is available (${status.latestVersion}, installed ${status.version}).`;
    updateLine.style.display = "";
  } else {
    updateLine.style.display = "none";
  }

  prereqLine.textContent = status.prereqMessage ?? "";
  prereqLine.style.color = status.prereqOk === false
    ? "var(--vscode-editorWarning-foreground)"
    : "";
  getEl("rustupActionsRow").style.display = status.prereqInstallable ? "" : "none";
}

let rustPrereqInstallInProgress = false;

function installPrereqHandler(): void {
  if (rustPrereqInstallInProgress) {
    return;
  }
  rustPrereqInstallInProgress = true;

  const installPrereqButton = getEl<Button>("installPrereqButton");
  installPrereqButton.setAttribute("disabled", "");
  installPrereqButton.textContent = "Installing C++ Build Tools...";

  vscode.postMessage({ command: "installRustPrereq" });
}

function initRustVersionDropdown(): void {
  const versionInput = getEl<HTMLInputElement>("rustVersionInput");
  const versionsDropdown = getEl("rustVersionsDropdown");

  ["focusin", "click"].forEach(evt => {
    versionInput.addEventListener(evt, () => {
      versionsDropdown.style.display = "block";
    });
  });
  versionInput.addEventListener("focusout", () => {
    setTimeout(() => { versionsDropdown.style.display = "none"; }, 80);
  });

  addDropdownItemListeners(versionsDropdown, versionInput, updateRustFolderSuggestion);
}

function renderRustImportLoading(): void {
  const versionInput = getEl<HTMLInputElement>("rustVersionInput");
  const versionsDropdown = getEl("rustVersionsDropdown");

  versionInput.value = "";
  versionInput.setAttribute("data-value", "");
  versionInput.placeholder = "Looking online for Rust releases...";
  versionInput.setAttribute("disabled", "");
  versionsDropdown.innerHTML = `<div class="dropdown-placeholder">Looking online for Rust releases...</div>`;
  availableRustVersions = [];
  availableRustTargets = [];
  availableRustTargetDescriptions = {};
  renderRustTargetsPlaceholder("Loading Zephyr Rust targets...");
  setRustFolderNameState("", false);
  toggleRustSpinner(true);

  const linkInput = getEl<HTMLInputElement>("rustCToolchainInput");
  const linkDropdown = getEl("rustCToolchainDropdown");
  linkInput.value = "";
  linkInput.setAttribute("data-value", "");
  linkInput.placeholder = "Loading toolchains...";
  linkInput.setAttribute("disabled", "");
  linkDropdown.innerHTML = `<div class="dropdown-placeholder">Loading toolchains...</div>`;

  renderLlvmLoading();
}

function applyRustImportData(data: RustImportData | undefined): void {
  const versionInput = getEl<HTMLInputElement>("rustVersionInput");
  const versionsDropdown = getEl("rustVersionsDropdown");
  toggleRustSpinner(false);

  const versions = data?.versions ?? [];

  if (data?.error || !versions.length) {
    const message = data?.error ?? "No Rust releases available.";
    versionInput.value = "";
    versionInput.setAttribute("data-value", "");
    versionInput.placeholder = data?.error
      ? "Unable to load Rust versions"
      : "No Rust releases available";
    versionInput.setAttribute("disabled", "");
    versionsDropdown.innerHTML = `<div class="dropdown-placeholder">${escapeHtml(message)}</div>`;
    availableRustVersions = [];
    availableRustTargets = [];
    availableRustTargetDescriptions = {};
    renderRustTargetsPlaceholder(message);
    setRustFolderNameState("", false);
    return;
  }

  availableRustVersions = versions;
  availableRustTargets = data?.targets ?? [];
  availableRustTargetDescriptions = data?.targetDescriptions ?? {};

  renderRustVersionOptions();
  modifyRustTypeHandler();
}

function isRustStandaloneSelected(): boolean {
  return (getEl<RadioGroup>("srcTypeRust") as unknown as { value: string }).value !== "rust-rustup";
}

// The 'stable' channel only exists for the rustup method; standalone dist
// archives are published per numbered release.
function renderRustVersionOptions(): void {
  if (!availableRustVersions.length) {
    return;
  }

  const versionInput = getEl<HTMLInputElement>("rustVersionInput");
  const versionsDropdown = getEl("rustVersionsDropdown");
  const versions = isRustStandaloneSelected()
    ? availableRustVersions.filter(version => version !== RUST_STABLE_CHANNEL)
    : availableRustVersions;

  versionInput.removeAttribute("disabled");
  versionInput.placeholder = "Choose the Rust version...";
  versionsDropdown.innerHTML = versions.map(version => `
    <div class="dropdown-item"
         data-value="${escapeHtml(version)}"
         data-label="${escapeHtml(version)}">${escapeHtml(version)}</div>
  `).join("");

  const current = versionInput.getAttribute("data-value") ?? "";
  const preferred = current && versions.includes(current) ? current : versions[0];
  versionInput.value = preferred;
  versionInput.setAttribute("data-value", preferred);

  updateRustFolderSuggestion();
  setRustFolderNameEnabled(true);
}

function updateRustFolderSuggestion(): void {
  const version = getEl<HTMLInputElement>("rustVersionInput").getAttribute("data-value") ?? "";
  const folderField = getRustFolderField();
  updateRustFolderName(version ? `rust-${version}` : "", folderField.value);
}

function handleRustFolderNameInput(): void {
  const folderField = getRustFolderField();
  const trimmed = folderField.value.trim();
  folderField.value = trimmed;
  folderField.setAttribute("data-dirty", trimmed !== "" && trimmed !== lastSuggestedRustFolderName ? "true" : "false");
}

function updateRustFolderName(suggestedName: string, currentValue: string): void {
  const folderField = getRustFolderField();
  const isDirty = folderField.getAttribute("data-dirty") === "true";
  const trimmedCurrentValue = currentValue.trim();

  if (!isDirty || trimmedCurrentValue === "" || trimmedCurrentValue === lastSuggestedRustFolderName) {
    folderField.value = suggestedName;
    folderField.setAttribute("data-dirty", "false");
  }

  lastSuggestedRustFolderName = suggestedName;
}

function setRustFolderNameState(value: string, enabled: boolean): void {
  const folderField = getRustFolderField();
  folderField.value = value;
  folderField.setAttribute("data-dirty", "false");
  lastSuggestedRustFolderName = value;
  setRustFolderNameEnabled(enabled);
}

function setRustFolderNameEnabled(enabled: boolean): void {
  const folderField = getRustFolderField();
  if (enabled) {
    folderField.removeAttribute("disabled");
  } else {
    folderField.setAttribute("disabled", "");
  }
}

function getRustFolderField(): HTMLElement & { value: string } {
  return getEl<TextField>("rustFolderName") as unknown as HTMLElement & { value: string };
}

function initLlvmVersionDropdown(): void {
  const versionInput = getEl<HTMLInputElement>("llvmVersionInput");
  const versionsDropdown = getEl("llvmVersionsDropdown");

  ["focusin", "click"].forEach(evt => {
    versionInput.addEventListener(evt, () => {
      versionsDropdown.style.display = "block";
    });
  });
  versionInput.addEventListener("focusout", () => {
    setTimeout(() => { versionsDropdown.style.display = "none"; }, 80);
  });

  addDropdownItemListeners(versionsDropdown, versionInput);
}

function renderLlvmLoading(): void {
  const versionInput = getEl<HTMLInputElement>("llvmVersionInput");
  const versionsDropdown = getEl("llvmVersionsDropdown");

  versionInput.value = "";
  versionInput.setAttribute("data-value", "");
  versionInput.placeholder = "Looking online for LLVM releases...";
  versionInput.setAttribute("disabled", "");
  versionsDropdown.innerHTML = `<div class="dropdown-placeholder">Looking online for LLVM releases...</div>`;
  toggleLlvmSpinner(true);
}

function applyLlvmVersionList(data: LlvmImportData | undefined): void {
  const versionInput = getEl<HTMLInputElement>("llvmVersionInput");
  const versionsDropdown = getEl("llvmVersionsDropdown");
  toggleLlvmSpinner(false);

  const versions = data?.versions ?? [];

  if (data?.error || !versions.length) {
    const message = data?.error ?? "No LLVM releases available.";
    versionInput.value = "";
    versionInput.setAttribute("data-value", "");
    versionInput.placeholder = data?.error
      ? "Unable to load LLVM versions"
      : "No LLVM releases available";
    versionInput.setAttribute("disabled", "");
    versionsDropdown.innerHTML = `<div class="dropdown-placeholder">${escapeHtml(message)}</div>`;
    return;
  }

  versionInput.removeAttribute("disabled");
  versionInput.placeholder = "Choose the LLVM version...";
  versionsDropdown.innerHTML = versions.map(version => `
    <div class="dropdown-item"
         data-value="${escapeHtml(version)}"
         data-label="${escapeHtml(version)}">${escapeHtml(version)}</div>
  `).join("");

  versionInput.value = versions[0];
  versionInput.setAttribute("data-value", versions[0]);
}

function toggleLlvmSpinner(show: boolean): void {
  const spinner = document.getElementById("llvmSpinner") as HTMLElement | null;
  if (!spinner) { return; }
  spinner.style.display = show ? "inline-block" : "none";
}

function isRustMinimalSelected(): boolean {
  return (getEl<RadioGroup>("rustType") as unknown as { value: string }).value === "minimal";
}

function modifyRustTypeHandler(): void {
  const minimal = isRustMinimalSelected();
  getEl("rustTargetsSection").style.display = minimal ? "" : "none";
  if (minimal && availableRustTargets.length) {
    renderRustTargets(availableRustTargets);
  }
}

function renderRustTargets(targets: string[]): void {
  if (!targets.length) {
    renderRustTargetsPlaceholder("No Zephyr Rust targets available.");
    return;
  }

  const container = getEl("rustTargetsContainer");
  container.innerHTML = targets.map(target => {
    const description = availableRustTargetDescriptions[target] ?? "";
    return `
    <div>
      <vscode-checkbox class="rust-target-checkbox"
                       value="${escapeHtml(target)}"
                       current-value="${escapeHtml(target)}"
                       ${description ? `title="${escapeHtml(description)}"` : ""}
                       ${RUST_MINIMAL_PRESELECTED_TARGETS.includes(target) ? "checked" : ""}>${escapeHtml(target)}</vscode-checkbox>
    </div>
  `;
  }).join("");
}

function renderRustTargetsPlaceholder(message: string): void {
  const container = getEl("rustTargetsContainer");
  container.innerHTML = `<div class="toolchain-placeholder">${escapeHtml(message)}</div>`;
}

function getSelectedRustTargets(): string[] {
  const cbs = document.getElementsByClassName("rust-target-checkbox") as HTMLCollectionOf<Checkbox>;
  return Array.from(cbs)
    .filter(cb => (cb as unknown as { checked: boolean }).checked)
    .map(cb => (cb as unknown as { value: string }).value || "")
    .filter(Boolean);
}

function applyRustLinkOptions(sdks: IarSdkEntry[], armGnuRegistered: RegisteredArmGnuEntry[]): void {
  const linkInput = getEl<HTMLInputElement>("rustCToolchainInput");
  const linkDropdown = getEl("rustCToolchainDropdown");

  const items = [
    ...sdks.map(sdk => ({
      value: `zephyr-sdk|${sdk.path}`,
      label: sdk.name,
      description: sdk.version,
    })),
    ...armGnuRegistered.map(toolchain => ({
      value: `gnuarmemb|${toolchain.path}`,
      label: toolchain.name,
      description: "",
    })),
  ];

  if (!items.length) {
    linkInput.value = "";
    linkInput.setAttribute("data-value", "");
    linkInput.placeholder = "No registered SDK or Arm GNU toolchain";
    linkInput.setAttribute("disabled", "");
    linkDropdown.innerHTML = `<div class="dropdown-placeholder">No registered Zephyr SDK or Arm GNU toolchain found. Add one first.</div>`;
    return;
  }

  linkInput.removeAttribute("disabled");
  linkInput.placeholder = "Choose the C toolchain...";
  linkDropdown.innerHTML = items.map(item => `
    <div class="dropdown-item"
         data-value="${escapeHtml(item.value)}"
         data-label="${escapeHtml(item.label)}">
      ${escapeHtml(item.label)}
      <span class="description">${escapeHtml(item.description)}</span>
    </div>
  `).join("");
}

function getSelectedRustCToolchain(): { type: string; path: string } {
  const raw = getEl<HTMLInputElement>("rustCToolchainInput").getAttribute("data-value") ?? "";
  const separatorIndex = raw.indexOf("|");
  if (separatorIndex <= 0) {
    return { type: "", path: "" };
  }
  return {
    type: raw.slice(0, separatorIndex),
    path: raw.slice(separatorIndex + 1),
  };
}

function toggleRustSpinner(show: boolean): void {
  const spinner = document.getElementById("rustSpinner") as HTMLElement | null;
  if (!spinner) { return; }
  spinner.style.display = show ? "inline-block" : "none";
}

function installRustupHandler(): void {
  if (rustupInstallInProgress) {
    return;
  }
  rustupInstallInProgress = true;

  const installButton = getEl<Button>("installRustupButton");
  installButton.setAttribute("disabled", "");
  installButton.textContent = "Installing rustup...";
  getEl("rustupStatusLine").textContent = "Installing rustup into .zinstaller/tools/rustup/ ...";

  vscode.postMessage({ command: "installRustup" });
}

function importHandler(): void {
  const sourceCategory = (getEl<RadioGroup>("sourceCategory") as unknown as { value: string }).value;
  let srcType = "iar";
  if (sourceCategory === "zephyr") {
    srcType = (getEl<RadioGroup>("srcTypeZephyr") as unknown as { value: string }).value;
  } else if (sourceCategory === "arm-gnu") {
    srcType = (getEl<RadioGroup>("srcTypeArmGnu") as unknown as { value: string }).value;
  } else if (sourceCategory === "rust") {
    srcType = (getEl<RadioGroup>("srcTypeRust") as unknown as { value: string }).value;
  }

  const armGnuVersion = getEl<HTMLInputElement>("armGnuVersionInput").getAttribute("data-value") || "";
  const armGnuTarget = (getEl<RadioGroup>("armGnuTargetGroup") as unknown as { value: string }).value;
  const armGnuFolderName = (getArmGnuFolderField().value || "").trim();
  const armGnuSelection = armGnuAssets.find(asset =>
    asset.version === armGnuVersion && asset.targetTriple === armGnuTarget
  );

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
    armGnuVersion,
    armGnuTarget,
    armGnuUrl: armGnuSelection?.url ?? "",
    armGnuFolderName,
    rustVersion: getEl<HTMLInputElement>("rustVersionInput").getAttribute("data-value") || "",
    rustTargets: isRustMinimalSelected() ? getSelectedRustTargets() : [...availableRustTargets],
    rustFolderName: (getRustFolderField().value || "").trim(),
    rustInstallMingw: (document.getElementById("rustMingwCheckbox") as unknown as { checked?: boolean } | null)?.checked === true,
    rustCToolchainType: getSelectedRustCToolchain().type,
    rustCToolchainPath: getSelectedRustCToolchain().path,
    llvmVersion: getEl<HTMLInputElement>("llvmVersionInput").getAttribute("data-value") || "",
  });
}

function getSuggestedArmGnuFolderName(filename: string): string {
  return filename.replace(/(\.tar\.xz|\.zip)$/i, "");
}

function handleArmGnuFolderNameInput(): void {
  const folderField = getArmGnuFolderField();
  const trimmed = folderField.value.trim();
  const suggested = folderFieldValueSuggestion();
  folderField.value = trimmed;
  folderField.setAttribute("data-dirty", trimmed !== "" && trimmed !== suggested ? "true" : "false");
}

function updateArmGnuFolderName(suggestedName: string, currentValue: string): void {
  const folderField = getArmGnuFolderField();
  const isDirty = folderField.getAttribute("data-dirty") === "true";
  const trimmedCurrentValue = currentValue.trim();

  if (!isDirty || trimmedCurrentValue === "" || trimmedCurrentValue === lastSuggestedArmGnuFolderName) {
    folderField.value = suggestedName;
    folderField.setAttribute("data-dirty", "false");
  }

  lastSuggestedArmGnuFolderName = suggestedName;
}

function setArmGnuFolderNameState(value: string, enabled: boolean): void {
  const folderField = getArmGnuFolderField();
  folderField.value = value;
  folderField.setAttribute("data-dirty", "false");
  lastSuggestedArmGnuFolderName = value;
  if (enabled) {
    folderField.removeAttribute("disabled");
  } else {
    folderField.setAttribute("disabled", "");
  }
}

function folderFieldValueSuggestion(): string {
  return lastSuggestedArmGnuFolderName;
}

function getArmGnuFolderField(): HTMLElement & { value: string } {
  return getEl<TextField>("armGnuFolderName") as unknown as HTMLElement & { value: string };
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
