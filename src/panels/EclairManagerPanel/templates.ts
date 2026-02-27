import fs from "fs";
import path from "path";
import yaml from "yaml";
import { EclairTemplate } from "../../utils/eclair/template";
import { Result } from "../../utils/typing_utils";
import { extract_yaml_from_ecl_content, parse_eclair_template_from_any } from "../../utils/eclair/template_utils";
import { ensureRepoCheckout } from "./repo_manage";
import { EclairPresetTemplateSource, EclairRepos } from "../../utils/eclair/config";
import { match } from "ts-pattern";

export async function load_preset_from_path(
  preset_path: string,
  on_progress: (message: string) => void,
): Promise<Result<EclairTemplate, string>> {
  preset_path = preset_path.trim();
  if (!preset_path) {
    return { err: "Invalid preset path." };
  }

  on_progress("Reading file...");
  let content: string;
  try {
    content = await fs.promises.readFile(preset_path, { encoding: "utf8" });
  } catch (err: any) {
    return { err: `Failed to read preset: ${err?.message || err}` };
  }

  on_progress("Parsing file...");
  const yaml_content = extract_yaml_from_ecl_content(content);
  if (yaml_content === undefined) {
    return { err: "The selected file does not contain valid ECL template content." };
  }

  let data: any;
  try {
    data = yaml.parse(yaml_content);
  } catch (err: any) {
    return { err: `Failed to parse preset: ${err?.message || err}` };
  }

  on_progress("Validating file...");
  let template: EclairTemplate;
  try {
    template = parse_eclair_template_from_any(data);
  } catch (err: any) {
    return { err: `Invalid preset content: ${err?.message || err}` };
  }

  return { ok: template };
}

/**
 * Loads a single preset file from a named repository.
 * `origin` and `ref` are internal parameters used by `ensureRepoCheckout`;
 * they do NOT appear in the `repo-path` source emitted to the webview.
 *
 * @param name Logical repo name (matches EclairScaConfig.repos key).
 * @param origin Git remote URL (internal only).
 * @param ref Branch or tag used to resolve revisions (internal only).
 * @param rev Optional locked commit SHA (internal only).
 * @param filePath Preset file path relative to the repository root.
 * @param on_progress Progress callback.
 */
export async function load_preset_from_repo(
  name: string,
  origin: string,
  ref: string,
  rev: string | undefined,
  filePath: string,
  on_progress: (message: string) => void,
): Promise<Result<[EclairTemplate, string], string>> {
  on_progress("Cloning repository...");

  let checkoutDir: string;
  try {
    checkoutDir = await ensureRepoCheckout(name, origin, ref, rev);
  } catch (err: any) {
    return { err: `Failed to checkout repository: ${err?.message || err}` };
  }

  const absolutePath = path.join(checkoutDir, filePath);

  const r = await load_preset_from_path(absolutePath, on_progress);
  if ("err" in r) {
    return { err: `Failed to load preset from repository: ${r.err}` };
  }

  return { ok: [r.ok, absolutePath] };
}

export async function load_preset_from_ref(
  source: EclairPresetTemplateSource,
  repos: EclairRepos,
  on_progress: (message: string) => void,
): Promise<Result<[EclairTemplate, string], string>> {
  return await match(source)
    .with({ type: "system-path" }, async ({ path }) => {
      const r = await load_preset_from_path(path, on_progress);
      if ("err" in r) {
        return { err: `Failed to load preset from path: ${r.err}` };
      }
      return { ok: [r.ok, path] as [EclairTemplate, string] };
    })
    .with({ type: "repo-path" }, async ({ repo, path }) => {
      const entry = repos[repo];
      if (!entry) {
        return { err: `Repository '${repo}' not found in repos configuration.` };
      }
      return await load_preset_from_repo(repo, entry.origin, entry.ref, entry.rev, path, on_progress);
    })
    .exhaustive();
}
