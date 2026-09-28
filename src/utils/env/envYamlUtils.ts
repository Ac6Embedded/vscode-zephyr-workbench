import { readEnvYamlObject, writeEnvYamlObject } from './envYamlFileUtils';

// High-level helpers for the shared EXTRA_TOOLS / EXTRA_RUNNERS structure in env.yml.
// Use this module when the caller only needs to read, add, replace, or remove
// entries under other.EXTRA_TOOLS.path or other.EXTRA_RUNNERS.path without
// dealing with the full env.yml document shape.

export type ExtraKind = 'EXTRA_TOOLS' | 'EXTRA_RUNNERS';

function readEnv(): any {
  return readEnvYamlObject();
}

function writeEnv(jsEnv: any): any {
  return writeEnvYamlObject(jsEnv).data;
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

/**
 * Replace the whole list in one write, with forward slashes; an empty list
 * removes it, as removing its last entry does.
 */
export function setExtraPaths(kind: ExtraKind, paths: readonly string[]): any {
  const jsEnv = readEnv();
  const cleaned = paths.map(p => normalizePath(p.trim())).filter(p => p.length > 0);
  if (cleaned.length > 0) {
    ensurePaths(jsEnv, kind);
    jsEnv.other[kind].path = cleaned;
  } else if (jsEnv?.other?.[kind]) {
    delete jsEnv.other[kind].path;
    if (Object.keys(jsEnv.other[kind]).length === 0) {delete jsEnv.other[kind];}
    if (Object.keys(jsEnv.other).length === 0) {delete jsEnv.other;}
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
