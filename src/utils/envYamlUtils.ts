import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { getInternalDirRealPath } from '../utils/utils';
import { formatYml } from '../utilities/formatYml';

// Utilities to manage env.yml extra paths for both Host Tools and Debug Runners.
// How to use:
// - In your panel message handler, call setExtraPath('EXTRA_TOOLS'|'EXTRA_RUNNERS', idx, newPath)
//   to append/replace a path (no empty placeholders are created). The function writes env.yml
//   and returns the updated parsed object. Use the returned value to refresh any in-memory state.
// - Call removeExtraPath('EXTRA_TOOLS'|'EXTRA_RUNNERS', idx) to delete an entry. If the list
//   becomes empty, the helper also removes empty containers from env.yml.
// - Call getExtraPaths('EXTRA_TOOLS'|'EXTRA_RUNNERS') to retrieve the current list of paths.

export type ExtraKind = 'EXTRA_TOOLS' | 'EXTRA_RUNNERS';

function getEnvYamlPath(): string {
  return path.join(getInternalDirRealPath(), 'env.yml');
}

function readEnv(): any {
  const p = getEnvYamlPath();
  if (!fs.existsSync(p)) {return {};}
  try {
    const txt = fs.readFileSync(p, 'utf8');
    return yaml.parse(txt) || {};
  } catch {
    return {};
  }
}

function writeEnv(jsEnv: any): any {
  // Serialize in block style
  const doc = yaml.parseDocument(yaml.stringify(jsEnv, { flow: false }));
  formatYml(doc.contents);
  const txt = yaml.stringify(yaml.parse(doc.toString()), { flow: false });
  fs.writeFileSync(getEnvYamlPath(), txt, 'utf8');
  try { return yaml.parse(txt); } catch { return undefined; }
}

function ensurePaths(jsEnv: any, kind: ExtraKind): string[] {
  jsEnv.other = jsEnv.other || {};
  jsEnv.other[kind] = jsEnv.other[kind] || {};
  const node = jsEnv.other[kind];
  if (!Array.isArray(node.path)) {node.path = [];}
  return node.path as string[];
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

export function getExtraPaths(kind: ExtraKind): string[] {
  const jsEnv = readEnv();
  const arr = jsEnv?.other?.[kind]?.path;
  return Array.isArray(arr) ? arr.slice() : [];
}

export function setExtraPath(kind: ExtraKind, idx: number, newPath: string): any {
  const jsEnv = readEnv();
  const arr = ensurePaths(jsEnv, kind);
  const defPath = normalizePath(newPath.trim());
  if (!defPath) {return jsEnv;} // do not write empty
  if (Number.isInteger(idx) && idx >= 0 && idx < arr.length) {
    arr[idx] = defPath;
  } else if (Number.isInteger(idx) && idx === arr.length) {
    arr.push(defPath);
  } else {
    arr.push(defPath);
  }
  return writeEnv(jsEnv);
}

export function removeExtraPath(kind: ExtraKind, idx: number): any {
  const jsEnv = readEnv();
  const arr = jsEnv?.other?.[kind]?.path;
  if (!Array.isArray(arr) || arr.length === 0) {
    return writeEnv(jsEnv);
  }
  if (Number.isInteger(idx) && idx >= 0 && idx < arr.length) {
    arr.splice(idx, 1);
  } else {
    // best-effort: remove last if out-of-range
    arr.pop();
  }
  if (arr.length === 0) {
    if (jsEnv.other && jsEnv.other[kind]) {
      delete jsEnv.other[kind].path;
      if (Object.keys(jsEnv.other[kind]).length === 0) {delete jsEnv.other[kind];}
    }
    if (jsEnv.other && Object.keys(jsEnv.other).length === 0) {delete jsEnv.other;}
  } else {
    ensurePaths(jsEnv, kind); // ensure structure
    jsEnv.other[kind].path = arr;
  }
  return writeEnv(jsEnv);
}

