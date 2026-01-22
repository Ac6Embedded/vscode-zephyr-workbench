import * as path from 'path';
import * as vscode from 'vscode';
import { fileExists } from './utils';
import {
  ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY,
  ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
  ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY
} from '../constants';

const WEST_WORD_RE = /\bwest(\.exe)?\b/i;
const WEST_START_RE = /^west(\.exe)?(\s+|$)/i;
const SYSBUILD_RE = /(^|\s)--sysbuild(\s|$)/i;
const SYSBUILD_INJECTED_RE = /(%WEST_ARGS%|\$env:WEST_ARGS|\$\{WEST_ARGS\}|\$WEST_ARGS)/i;

const psEscape = (s: string) => s.replace(/'/g, "''");
const stripQuotes = (s: string) => {
  const t = (s ?? '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
};

const normalizePathSetting = (s?: string) => stripQuotes(
  (s ?? '').replace(
    /%([^%]+)%|\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (match, p1: string, p2: string, p3: string) => {
      const name = (p1 || p2 || p3) as string;
      const val = process.env[name] ?? process.env[name.toUpperCase()];
      return val ?? match;
    }
  )
);

const quoteArg = (shellKind: string, arg: string) => {
  const pwsh = shellKind === 'powershell.exe' || shellKind === 'pwsh.exe';
  return pwsh ? `'${psEscape(arg)}'` : `"${arg.replace(/"/g, '\\"')}"`;
};

export function sysbuildPython(
  shellKind: string,
  envScriptPath: string,
  cmd: string
): { cmd: string; postEnv?: string } {

  const fullCmd = cmd ?? '';
  const westIndex = fullCmd.search(WEST_WORD_RE);
  if (westIndex < 0) return { cmd };

  const prefix = fullCmd.slice(0, westIndex).trimEnd();
  const westCmd = fullCmd.slice(westIndex).trimStart();
  if (!WEST_START_RE.test(westCmd)) return { cmd };

  const hasSysbuild = SYSBUILD_RE.test(westCmd) || SYSBUILD_INJECTED_RE.test(westCmd);
  if (!hasSysbuild) return { cmd };

  const cfg = vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY);
  const envScriptFromCfg = cfg.get<string>(ZEPHYR_WORKBENCH_PATH_TO_ENV_SCRIPT_SETTING_KEY);
  const expandedEnvScript = normalizePathSetting(envScriptPath || envScriptFromCfg || '');

  let venvPath = normalizePathSetting(cfg.get<string>(ZEPHYR_WORKBENCH_VENV_PATH_SETTING_KEY));
  if (!venvPath && expandedEnvScript) {
    const inferred = path.join(path.dirname(expandedEnvScript), '.venv');
    if (fileExists(inferred)) venvPath = inferred;
  }
  if (!venvPath) return { cmd };

  const isWin = process.platform === 'win32';
  const pythonExe = isWin
    ? path.join(venvPath, 'Scripts', 'python.exe')
    : path.join(venvPath, 'bin', 'python');
  if (!fileExists(pythonExe)) return { cmd };

  const venvBinDir = isWin ? path.join(venvPath, 'Scripts') : path.join(venvPath, 'bin');
  const pythonCmakePath = pythonExe.replace(/\\/g, '/');
  const baseDefine3 = `-DPython3_EXECUTABLE:FILEPATH=${pythonCmakePath}`;
  const baseDefine = `-DPython_EXECUTABLE:FILEPATH=${pythonCmakePath}`;
  const mcubootList = `${baseDefine3};${baseDefine}`;

  const pythonCmakeArgs = [
    baseDefine3,
    baseDefine,
    `-Dmcuboot_CMAKE_ARGS=${mcubootList}`,
    `-Dmcuboot_EXTRA_CMAKE_ARGS=${mcubootList}`,
  ].map((t) => quoteArg(shellKind, t)).join(' ');

  let cmdWithArgs = westCmd.trim();
  const sepIndex = cmdWithArgs.indexOf(' -- ');
  const sysIndex = cmdWithArgs.search(/\s--sysbuild(\s|$)/i);
  if (sepIndex >= 0 && sysIndex > sepIndex) {
    cmdWithArgs = cmdWithArgs.replace(/\s--sysbuild(\s|$)/i, ' ');
    cmdWithArgs = `${cmdWithArgs.slice(0, sepIndex)} --sysbuild${cmdWithArgs.slice(sepIndex)}`;
  }
  if (!/Python3_EXECUTABLE/i.test(cmdWithArgs)) {
    cmdWithArgs = cmdWithArgs.includes(' -- ')
      ? `${cmdWithArgs} ${pythonCmakeArgs}`
      : `${cmdWithArgs} -- ${pythonCmakeArgs}`;
  }

  const rest = cmdWithArgs.replace(/^west(\.exe)?\b/i, '').trim();

  const pwsh = shellKind === 'powershell.exe' || shellKind === 'pwsh.exe';
  const cmdExe = shellKind === 'cmd.exe';

  const postEnv = pwsh
    ? `$env:WEST_PYTHON='${psEscape(pythonExe)}' ; $env:Path='${psEscape(venvBinDir)};' + $env:Path`
    : cmdExe
      ? `set "WEST_PYTHON=${pythonExe}" && set "PATH=${venvBinDir};%PATH%"`
      : `export WEST_PYTHON="${pythonExe.replace(/\"/g, '\\"')}" ; export PATH="${venvBinDir.replace(/\\/g, '/').replace(/\"/g, '\\"')}:$PATH"`;

  const adaptedCmd = pwsh
    ? `& '${psEscape(pythonExe)}' -m west${rest ? ` ${rest}` : ''}`
    : `"${pythonExe.replace(/\"/g, '\\"')}" -m west${rest ? ` ${rest}` : ''}`;

  if (prefix && postEnv) {
    const sep = cmdExe ? ' && ' : ' ; ';
    const prefixEndsWithSep = cmdExe ? /(&&|&)\s*$/.test(prefix) : /;\s*$/.test(prefix);
    return { cmd: `${prefix}${prefixEndsWithSep ? ' ' : sep}${postEnv}${sep}${adaptedCmd}` };
  }

  return { cmd: adaptedCmd, postEnv };
}
