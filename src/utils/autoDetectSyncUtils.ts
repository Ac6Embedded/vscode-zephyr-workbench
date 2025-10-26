// Syncs auto-detect runner entries from scripts/runners/debug-tools.yml
// into %USERPROFILE%/.zinstaller/env.yml when versions differ or env.yml is missing.
// This runs best-effort during extension activation and should never throw.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import yaml from 'yaml';
import { getInstallDirRealPath } from './utils';

interface DebugToolEntry {
  tool: string;
  [key: string]: any;
}

// Minimal shape we care about from debug-tools.yml
interface DebugToolsYaml {
  version?: string | number;
  debug_tools?: DebugToolEntry[];
}

// Minimal shape we write to env.yml (we only manage version and auto-detect)
interface EnvYamlShape {
  global?: {
    version?: string | number;
    description?: string;
    ['version_auto-detect']?: string | number;
  };
  ['auto-detect']?: Record<string, any>;
  [key: string]: any;
}

// Safely parse YAML from file; return undefined on any error
function readYamlFile<T = any>(filePath: string): T | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return yaml.parse(content) as T;
  } catch (e) {
    return undefined;
  }
}

// Write YAML to disk, creating parent directory if needed
function writeYamlFile(filePath: string, data: any) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const text = yaml.stringify(data);
  fs.writeFileSync(filePath, text, 'utf8');
}

export async function syncAutoDetectEnv(context: vscode.ExtensionContext): Promise<void> {
  try {
    // Load debug-tools.yml from the extension bundle
    const debugToolsUri = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'runners', 'debug-tools.yml');
    const debugToolsPath = debugToolsUri.fsPath;
    const debugDoc = readYamlFile<DebugToolsYaml>(debugToolsPath);
    if (!debugDoc) {
      return;
    }

    const debugVersion = debugDoc.version;
    // env.yml is stored in the user (or portable) .zinstaller folder
    const envYamlPath = path.join(getInstallDirRealPath(), '.zinstaller', 'env.yml');
    const envDoc = readYamlFile<EnvYamlShape>(envYamlPath) || {};

    const envAutoDetectVersion = envDoc.global?.['version_auto-detect'];
    // Update if env.yml missing auto-detect version or differs from debug-tools.yml
    const needsUpdate = !envAutoDetectVersion || String(envAutoDetectVersion) !== String(debugVersion);

    if (!needsUpdate) {
      return;
    }

    // Collect all tools that define an auto-detect section
    const autoDetect: Record<string, any> = {};
    if (Array.isArray(debugDoc.debug_tools)) {
      for (const tool of debugDoc.debug_tools) {
        if (tool && tool.tool && tool['auto-detect']) {
          autoDetect[tool.tool] = tool['auto-detect'];
        }
      }
    }

    // Preserve other env.yml keys, update global.version_auto-detect and auto-detect map
    const newEnv: EnvYamlShape = {
      ...envDoc,
      global: {
        description: envDoc.global?.description ?? 'Host tools configuration for Zephyr Workbench',
        version: envDoc.global?.version ?? 1,
        'version_auto-detect': debugVersion,
      },
      'auto-detect': autoDetect,
    };

    writeYamlFile(envYamlPath, newEnv);
  } catch (err) {
    // Best-effort; do not throw during activation
    return;
  }
}
