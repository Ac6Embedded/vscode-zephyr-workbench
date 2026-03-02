import React from "react";
import * as wui from "@vscode/webview-ui-toolkit";
import { enableMapSet } from "immer";
import { createRoot } from "react-dom/client";
import { EclairManagerPanel } from "./main_element.js";

const CONTENT_ID = "eclair-manager-content";

export async function main() {
  enableMapSet();

  const body = document.getElementById(CONTENT_ID);
  if (!body) return;

  const root = createRoot(body);
  root.render(React.createElement(EclairManagerPanel));

  import_wui().catch((e) => {
    console.error("Failed to load VSCode Webview UI Toolkit:", e);
  });
}

export async function import_wui() {
  const { provideVSCodeDesignSystem, allComponents } = wui as any;
  provideVSCodeDesignSystem().register(allComponents);
}

window.addEventListener("load", main);
