import fs from "fs";
import path from "path";
import yaml from "yaml";

import { formatYml } from "../utilities/formatYml";
import { getInternalDirRealPath } from "./utils";

// Low-level env.yml helpers shared by panels and utils.
// This module owns locating env.yml, reading it as text/object/document,
// cloning a writable document, and writing normalized YAML back to disk.
// Higher-level modules should keep their own schema logic and use this file
// only for the common file access / parse / serialize behavior.

export function getEnvYamlPath(): string {
  return path.join(getInternalDirRealPath(), "env.yml");
}

export function readEnvYamlText(): string | undefined {
  const envYamlPath = getEnvYamlPath();
  if (!fs.existsSync(envYamlPath)) {
    return undefined;
  }

  return fs.readFileSync(envYamlPath, "utf8");
}

export function parseEnvYamlObject(text: string | undefined): any {
  if (text === undefined) {
    return {};
  }

  const parsed = yaml.parse(text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

export function readEnvYamlObject(): any {
  try {
    return parseEnvYamlObject(readEnvYamlText());
  } catch {
    return {};
  }
}

export function readEnvYamlObjectStrict(): any {
  return parseEnvYamlObject(readEnvYamlText());
}

export function readEnvYamlDocument(): any | undefined {
  const text = readEnvYamlText();
  if (text === undefined) {
    return undefined;
  }

  return yaml.parseDocument(text);
}

export function loadEnvYamlState(): { data: any | undefined; doc: any | undefined } {
  try {
    const text = readEnvYamlText();
    if (text === undefined) {
      return { data: undefined, doc: undefined };
    }

    return {
      data: parseEnvYamlObject(text),
      doc: yaml.parseDocument(text),
    };
  } catch {
    return { data: undefined, doc: undefined };
  }
}

export function cloneEnvYamlDocument(doc: any): any | undefined {
  if (!doc) {
    return undefined;
  }

  return doc.clone ? doc.clone() : yaml.parseDocument(String(doc));
}

export function createWritableEnvYamlDocument(existingDoc?: any): any {
  const envDoc = readEnvYamlDocument();
  if (envDoc) {
    return envDoc;
  }

  return cloneEnvYamlDocument(existingDoc) ?? yaml.parseDocument("{}");
}

function formatEnvYamlDocument(doc: any): string {
  if (doc?.contents) {
    formatYml(doc.contents);
  }

  return yaml.stringify(yaml.parse(doc.toString()), { flow: false });
}

export function writeEnvYamlDocument(doc: any): { data: any; doc: any; text: string } {
  const text = formatEnvYamlDocument(doc);
  const envYamlPath = getEnvYamlPath();
  fs.mkdirSync(path.dirname(envYamlPath), { recursive: true });
  fs.writeFileSync(envYamlPath, text, "utf8");

  return {
    data: parseEnvYamlObject(text),
    doc: yaml.parseDocument(text),
    text,
  };
}

export function writeEnvYamlObject(jsEnv: any): { data: any; doc: any; text: string } {
  const doc = yaml.parseDocument(yaml.stringify(jsEnv ?? {}, { flow: false }));
  return writeEnvYamlDocument(doc);
}
