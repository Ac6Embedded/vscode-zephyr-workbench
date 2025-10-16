import * as vscode from "vscode";
import fs from "fs";
import yaml from 'yaml';
import { fileExists } from "./utils";
import path from "path";

export const listHals: any[] = [
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

export function generateWestManifest(context: vscode.ExtensionContext, remotePath: string, remoteBranch: string, workspacePath: string, templateHal: string, isMinimal: boolean = false) {
  let templateManifestUri = vscode.Uri.joinPath(context.extensionUri, 'west_manifests', 'minimal_west.yml');
  const templateFile = fs.readFileSync(templateManifestUri.fsPath, 'utf8');
  const manifestYaml = yaml.parse(templateFile);
  // If caller indicates minimal template, force the remote base URL to ZephyrProject RTOS
  if (isMinimal === true) {
    remotePath = 'https://github.com/zephyrproject-rtos';
  }
  manifestYaml.manifest.remotes[0]['url-base'] = remotePath;
  manifestYaml.manifest.projects[0]['revision'] = remoteBranch;
  manifestYaml.manifest.projects[0]['import']['name-allowlist'].push(templateHal);
  const allowList: string[] =
    manifestYaml.manifest.projects[0].import["name-allowlist"];
  const keepCmsis6 = isAtLeast(remoteBranch, '4.1.0');

  if (isMinimal == true) {
    remotePath = "https://github.com/zephyrproject-rtos";
  }

  if (keepCmsis6) {
    const already = manifestYaml.manifest.projects.some(
      (p: any) => p.name === "cmsis_6"
    );
  } else {
    manifestYaml.manifest.projects[0].import["name-allowlist"] = allowList.filter(
      (n: string) => n !== "cmsis_6"
    );
  }

  if(!fileExists(workspacePath)) {
    fs.mkdirSync(workspacePath);
  }
  let manifestDir = path.join(workspacePath, 'manifest');
  fs.mkdirSync(manifestDir);

  const destFilePath = path.join(manifestDir, 'west.yml');
  const westManifestContent = yaml.stringify(manifestYaml);
  fs.writeFileSync(destFilePath, westManifestContent, 'utf8');

  return destFilePath;
}

function isAtLeast(version: string, floor = '4.1.0'): boolean {
  const parse = (v: string) =>
    v.replace(/^v/i, '')
     .split('-')[0]
     .split('.')
     .map(n => parseInt(n, 10) || 0);

  const [aMaj, aMin, aPat] = parse(version);
  const [bMaj, bMin, bPat] = parse(floor);

  if (aMaj !== bMaj) {return aMaj > bMaj;}
  if (aMin !== bMin) {return aMin > bMin;}
  return aPat >= bPat;
}