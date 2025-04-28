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
  if (!el) throw new Error(`Missing #${id} in Webview DOM`);
  return el as T;
}

/* VS Code bridge */
const vscode = acquireVsCodeApi();

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
});

/*────────────────── VS Code → Web‑view messages ──────────*/
function setVSCodeMessageListener(): void {
  window.addEventListener("message", (event) => {
    if (event.data.command !== "folderSelected") return;

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
  const isMinimal = (getEl<RadioGroup>("sdkType") as unknown as { value: string }).value === "minimal";
  Array.from(document.getElementsByClassName("toolchain-checkbox"))
       .forEach(cb => {
         if (isMinimal) { cb.removeAttribute("disabled"); }
         else           { cb.setAttribute("disabled", ""); }
       });
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

  addDropdownItemListeners(versionsDropdown, versionInput);

  /* pre‑select first version if any */
  const firstItem = versionsDropdown.querySelector<HTMLElement>(".dropdown-item");
  firstItem?.click();
}

/* generic item‑picker binding */
function addDropdownItemListeners(dropdown: HTMLElement, input: HTMLInputElement) {
  dropdown.querySelectorAll<HTMLElement>(".dropdown-item")
    .forEach(item => {
      item.addEventListener("pointerdown", () => {
        if (item.dataset.value === "browse") return;   // handled elsewhere
        input.value = item.dataset.label ?? "";
        input.setAttribute("data-value", item.dataset.value ?? "");
        input.dispatchEvent(new Event("input"));
        dropdown.style.display = "none";
      });
    });
}

/*──────────── util for “minimal” toolchains ──────────────*/
function getListSelectedToolchains(): string {
  const cbs = document.getElementsByClassName("toolchain-checkbox") as HTMLCollectionOf<Checkbox>;
  return Array.from(cbs)
    .filter(cb => cb.getAttribute("current-checked") === "true")
    .map(cb => (cb as unknown as { value: string }).value)
    .join(" ");
}