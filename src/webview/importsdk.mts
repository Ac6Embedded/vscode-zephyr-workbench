/******************************************************************
 *  vscode‑zephyr‑workbench  ·  importsdk.mts  (Web‑view side)
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

/*──────────────────────── helpers ────────────────────────*/
function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {throw new Error(`Missing #${id} in Webview DOM`);}
  return el as T;
}

/* VS Code bridge */
const vscode = acquireVsCodeApi();
let cachedToolchains: string[] = [];
let lastToolchainVersion = "";
let pendingToolchainVersion = "";

/*──────────────────────── entry point ─────────────────────*/
window.addEventListener("load", () => {
  setVSCodeMessageListener();
  initVersionsDropdown();
  initIarSdkDropdown();


  /* category / sub‑choice listeners */
  const sourceCat  = getEl<RadioGroup>("sourceCategory");
  const zephyrSub  = getEl<RadioGroup>("srcTypeZephyr");
  const sdkTypeSub = getEl<RadioGroup>("sdkType");

  sourceCat.addEventListener("click",  modifyCategoryHandler);
  sourceCat.addEventListener("select", modifyCategoryHandler);
  zephyrSub.addEventListener("click",  modifySrcTypeHandler);
  zephyrSub.addEventListener("select", modifySrcTypeHandler);
  getEl<RadioGroup>("srcTypeIar")
    .addEventListener("select", modifySrcTypeHandler);

  sdkTypeSub.addEventListener("click",  modifySdkTypeHandler);
  sdkTypeSub.addEventListener("select", modifySdkTypeHandler);

  /* browse + import */
  getEl<Button>("browseLocationButton")
    .addEventListener("click", () => {
      vscode.postMessage({ command: "openLocationDialog", id: "workspacePath" });
    });

  getEl<Button>("importButton")
    .addEventListener("click", importHandler);

  /* first layout refresh */
  sourceCat.dispatchEvent(new Event("select"));
  modifySdkTypeHandler();
});

/*────────────────── VS Code → Web‑view messages ──────────*/
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

/*──────────────────── visibility helpers ─────────────────*/
function modifyCategoryHandler(): void {
  const cat = (getEl<RadioGroup>("sourceCategory") as unknown as { value: string }).value;
  getEl("zephyrOptions").style.display = cat === "zephyr" ? "block" : "none";
  getEl("iarOptions").style.display    = cat === "iar"    ? "block" : "none";

  modifySrcTypeHandler();
}

function modifySrcTypeHandler(): void {
  const catRadio     = getEl<RadioGroup>("sourceCategory") as unknown as { value: string };
  const zephyrGroup  = getEl<RadioGroup>("srcTypeZephyr")  as unknown as { value: string };

  const officialForm = getEl("official-form");
  const remotePath   = getEl<TextField>("remotePath");
  const iarForm      = getEl("iar-form");

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
    } else { /* local */ 
      officialForm.style.display = "none";
      remotePath.setAttribute("disabled", "");
      remotePath.style.display = "none";
      iarForm.style.display = "none";
    }
  } else { /* IAR branch */
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
    toggleVersionSpinner(false);
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
  const version = getSelectedVersionTag();
  if (!version) {
    renderToolchainError("Select a version to load toolchains.", version);
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

  container.innerHTML = ordered.map(t => `
    <div>
      <vscode-checkbox class="toolchain-checkbox"
                       value="${t}"
                       current-value="${t}"
                       ${enabled ? "" : "disabled"}>${t}</vscode-checkbox>
    </div>
  `).join("");

  setToolchainsEnabled(enabled);
}

function renderToolchainPlaceholder(message: string): void {
  const container = getToolchainContainer();
  container.innerHTML = `<div class="toolchain-placeholder">${message}</div>`;
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
  toggleVersionSpinner(false);
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

    // Stable fallback: preserve original order
    return toolchains.indexOf(a) - toolchains.indexOf(b);
  });
}

function toggleVersionSpinner(show: boolean): void {
  const sp = document.getElementById("toolchainSpinner") as HTMLElement | null;
  if (!sp) { return; }
  sp.style.display = show ? "inline-block" : "none";
}

/*──────────────────── IAR‑SDK dropdown ───────────────────*/
function initIarSdkDropdown(): void {
  const sdkInput    = getEl<HTMLInputElement>("sdkInput");
  const sdkDropdown = getEl("sdkDropdown");

  /* show / hide */
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

/*──────────── IMPORT payload to extension ────────────────*/
function importHandler(): void {
  const isZephyr = (getEl<RadioGroup>("sourceCategory") as unknown as { value: string }).value === "zephyr";
  const srcType  = isZephyr
      ? (getEl<RadioGroup>("srcTypeZephyr") as unknown as { value: string }).value
      : "iar";

  vscode.postMessage({
    command:        "import",
    srcType,
    remotePath:     (getEl<TextField>("remotePath") as unknown as { value: string }).value,
    workspacePath:  (getEl<TextField>("workspacePath") as unknown as { value: string }).value,
    sdkType:        (getEl<RadioGroup>("sdkType") as unknown as { value: string }).value,
    sdkVersion:     getEl<HTMLInputElement>("versionInput").getAttribute("data-value"),
    listToolchains: getListSelectedToolchains(),
    iarZephyrSdkPath:     getEl<HTMLInputElement>("sdkInput").getAttribute("data-value") || "",
    iarToken:       (getEl<TextField>("iarToken") as unknown as { value: string }).value,
  });
}

/*──────────────── dropdown helpers (Version) ─────────────*/
function initVersionsDropdown(): void {
  const versionInput    = getEl<HTMLInputElement>("versionInput");
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
  });

  /* pre‑select first version if any */
  const firstItem = versionsDropdown.querySelector<HTMLElement>(".dropdown-item");
  firstItem?.dispatchEvent(new PointerEvent("pointerdown"));
}

/* generic item‑picker binding */
function addDropdownItemListeners(dropdown: HTMLElement, input: HTMLInputElement, onSelect?: () => void) {
  dropdown.querySelectorAll<HTMLElement>(".dropdown-item")
    .forEach(item => {
      item.addEventListener("pointerdown", () => {
        if (item.dataset.value === "browse") return;   // handled elsewhere
        input.value = item.dataset.label ?? "";
        input.setAttribute("data-value", item.dataset.value ?? "");
        input.dispatchEvent(new Event("input"));
        dropdown.style.display = "none";
        onSelect?.();
      });
    });
}

/*──────────── util for “minimal” toolchains ──────────────*/
function getListSelectedToolchains(): string {
  const cbs = document.getElementsByClassName("toolchain-checkbox") as HTMLCollectionOf<Checkbox>;
  return Array.from(cbs)
    .filter(cb => (cb as unknown as { checked: boolean }).checked)
    .map(cb => (cb as unknown as { value: string }).value || "")
    .filter(Boolean)
    .join(" ");
}
