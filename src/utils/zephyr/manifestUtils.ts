import * as vscode from "vscode";
import fs from "fs";
import yaml from 'yaml';
import { fileExists } from "../utils";
import path from "path";

export const listHals: any[] = [
  { label: "Analog Devices", name: "hal_adi" },
  { label: "Altera", name: "hal_altera" },
  { label: "Ambiq", name: "hal_ambiq" },
  { label: "Atmel", name: "hal_atmel" },
  { label: "Espressif", name: "hal_espressif" },
  { label: "Ethos-U", name: "hal_ethos_u" },
  { label: "GigaDevice", name: "hal_gigadevice" },
  { label: "Infineon", name: "hal_infineon" },
  { label: "Intel", name: "hal_intel" },
  { label: "Microchip", name: "hal_microchip" },
  { label: "Nordic", name: "hal_nordic" },
  { label: "Nuvoton", name: "hal_nuvoton" },
  { label: "NXP", name: "hal_nxp" },
  { label: "OpenISA", name: "hal_openisa" },
  { label: "QuickLogic", name: "hal_quicklogic" },
  { label: "Renesas", name: "hal_renesas" },
  { label: "Raspberry Pi Pico", name: "hal_rpi_pico" },
  { label: "Silicon Labs", name: "hal_silabs" },
  { label: "STM32", name: "hal_stm32" },
  { label: "Telink", name: "hal_telink" },
  { label: "Texas Instruments", name: "hal_ti" },
  { label: "Würth Elektronik", name: "hal_wurthelektronik" },
  { label: "xtensa", name: "hal_xtensa" }
];

/**
 * Write a generated west.yml under `workspacePath`. By default it goes into a
 * `manifest/` subfolder (the legacy convention), but callers can override:
 *   - undefined / empty / 'manifest' → <workspacePath>/manifest/west.yml (default)
 *   - any other non-empty string → <workspacePath>/<subfolder>/west.yml
 * (An empty value falls back to the default — west.yml at the workspace root is
 *  not supported, the UI also enforces this on submit.)
 *
 * `pathPrefix` controls the `import.path-prefix` written into the manifest:
 *   - undefined / 'deps' → projects imported under <workspace>/deps/ (default)
 *   - any other non-empty string → imported under <workspace>/<value>/
 *   - empty string → no `path-prefix` (modules imported at workspace root)
 */
export function generateWestManifest(context: vscode.ExtensionContext, remotePath: string, remoteBranch: string, workspacePath: string, templateHal: string, isFull: boolean, manifestSubfolder?: string, pathPrefix?: string) {
  const prefix = (pathPrefix ?? 'deps').trim();

  let manifestYaml;
  if (isFull) {
    // Full manifest structure. `import: true` (vs an object with path-prefix) means
    // "import everything, no subfolder".
    manifestYaml = {
      manifest: {
        remotes: [
          { name: "zephyrproject", "url-base": remotePath.replace(/\/zephyr\/?$/, '') }
        ],
        projects: [
          {
            name: "zephyr",
            "repo-path": "zephyr",
            remote: "zephyrproject",
            revision: remoteBranch,
            import: prefix.length > 0 ? { "path-prefix": prefix } : true
          }
        ]
      }
    };
  } else {
    // Minimal manifest structure
    let templateManifestUri = vscode.Uri.joinPath(context.extensionUri, 'west_manifests', 'minimal_west.yml');
    const templateFile = fs.readFileSync(templateManifestUri.fsPath, 'utf8');
    manifestYaml = yaml.parse(templateFile);
    // Do not duplicate zephyr in url-base
    manifestYaml.manifest.remotes[0]['url-base'] = remotePath.replace(/\/zephyr\/?$/, '');
    manifestYaml.manifest.projects[0]['revision'] = remoteBranch;
    const importBlock = manifestYaml.manifest.projects[0]['import'];
    if (importBlock && typeof importBlock === 'object') {
      if (prefix.length > 0) {
        importBlock['path-prefix'] = prefix;
      } else {
        delete importBlock['path-prefix'];
      }
      if (importBlock['name-allowlist']) {
        const allowlist = importBlock['name-allowlist'];
        if (!allowlist.includes(templateHal)) {
          allowlist.push(templateHal);
        }
      }
    }
  }

  if(!fileExists(workspacePath)) {
    fs.mkdirSync(workspacePath);
  }
  // Empty / undefined falls back to the default 'manifest' folder.
  const subfolder = (manifestSubfolder ?? '').trim() || 'manifest';
  const manifestDir = path.join(workspacePath, subfolder);
  if (!fileExists(manifestDir)) {
    fs.mkdirSync(manifestDir, { recursive: true });
  }

  const destFilePath = path.join(manifestDir, 'west.yml');
  const westManifestContent = yaml.stringify(manifestYaml);
  fs.writeFileSync(destFilePath, westManifestContent, 'utf8');

  return destFilePath;
}
