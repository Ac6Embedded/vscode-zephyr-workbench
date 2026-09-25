import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { getInternalToolsDirRealPath } from "../../utils/utils";
import { Result } from "../../utils/typing_utils";
import { exec } from "child_process";
import yaml from "yaml";
import type { ExtensionMessage } from "../../utils/eclair/eclairEvent";
import { extract_yaml_from_ecl_content, parse_eclair_template_from_any } from "../../utils/eclair/template_utils";
import type { EclairPresetTemplateSource, EclairRepos } from "../../utils/eclair/config";
import { EclairTemplate } from "../../utils/eclair/template";
import { match } from "ts-pattern";

export class PresetRepositories {
  private readonly post_message: (m: ExtensionMessage) => void;
  private readonly log: (line: string) => void;

  constructor(post_message: (m: ExtensionMessage) => void, log: (line: string) => void) {
    this.post_message = post_message;
    this.log = (message) => log(`[PresetRepositories] ${message}`);
  }

  async scan_repo_presets(
    name: string,
    origin: string,
    ref: string,
    rev: string | undefined,
    workspace: string,
  ): Promise<void> {
    this.post_message({ command: "clear-repo-presets", repo: name, workspace });

    let checkout_dir: string;
    let checkout_rev: string;
    try {
      [checkout_dir, checkout_rev] = await ensure_repo_checkout(name, origin, ref, rev);
      this.log(`Checked out repo '${name}' to '${checkout_dir}'.`);
    } catch (err: any) {
      this.log(`Failed to checkout repo '${name}': ${err}`);
      this.post_message({ command: "repo-scan-failed", name, message: err?.message || String(err), workspace, });
      return;
    }

    this.log(`Scanning repo '${name}' for .ecl presets...`);
    const ecl_files = await find_ecl_preset_files(checkout_dir);
    this.log(`Found ${ecl_files.length} .ecl files in repo '${name}'. Loading presets...`);

    if (!ecl_files) {
      this.post_message({ command: "repo-scan-done", name, workspace, rev: checkout_rev, checkout_dir });
      return;
    }

    for (const abs_path of ecl_files) {
      const rel_path = path.relative(checkout_dir, abs_path).replace(/\\/g, "/");
      const source: EclairPresetTemplateSource = { type: "repo-path", repo: name, path: rel_path };
      const _ = await this._load_preset_from_path(workspace, abs_path, source);
    }

    // TODO DRY for repo-scan-done and avoid hidden return paths
    this.post_message({ command: "repo-scan-done", name, workspace, rev: checkout_rev, checkout_dir });
  }

  async update_repo_checkout(
    name: string,
    origin: string,
    ref: string,
    rev: string | undefined,
    workspace: string,
  ): Promise<void> {
    const resolved_rev = rev ?? await resolve_ref_to_rev(origin, ref);
    if (!resolved_rev) {
      const message = `Failed to resolve ref '${ref}' for repo '${name}'.`;
      this.log(message);
      this.post_message({ command: "repo-scan-failed", name, message, workspace });
      return;
    }

    try {
      await this.scan_repo_presets(name, origin, ref, resolved_rev, workspace);
    } catch (err: any) {
      const message = `Failed to update checkout for repo '${name}': ${err}`;
      this.log(message);
      this.post_message({ command: "repo-scan-failed", name, message, workspace });
    }
  }

  async load_preset_no_checkout(
    workspace: string,
    source: EclairPresetTemplateSource,
    repos: EclairRepos,
    repo_revs: Record<string, string>,
  ): Promise<Result<[EclairTemplate, string], string>> {
    let abs_path: string;
    try {
      abs_path = match(source)
        .with({ type: "system-path" }, ({ path }) => path)
        .with({ type: "repo-path" }, ({ repo, path: rel_path }) => {
          const entry = repos[repo];
          if (!entry) {
            throw new Error(`Repository '${repo}' not found in repos configuration.`);
          }
          const rev = repo_revs[repo];
          if (!rev) {
            throw new Error(`Revision for repository '${repo}' is not known, cannot load preset ${rel_path}. Known revs: ${JSON.stringify(repo_revs)}`);
          }
          return path.join(get_checkout_dir(entry.origin, entry.ref, rev), rel_path);
        })
        .exhaustive();
    } catch (err: any) {
      const e = `Failed to resolve preset path: ${err?.message || err}`;
      this._tell_preset_error(workspace, source, e);
      return { err: e };
    }

    return this._load_preset_from_path(workspace, abs_path, source);
  }

  private async _load_preset_from_path(
    workspace: string,
    abs_path: string,
    source: EclairPresetTemplateSource,
  ): Promise<Result<[EclairTemplate, string], string>> {
    try {
      const template_r = await load_preset_from_path(abs_path, (progress) => {
        this._tell_preset_loading(workspace, source, progress);
      });
      if ("err" in template_r) {
        throw new Error(template_r.err);
      }
      const template = template_r.ok;
      this._tell_preset_loaded(workspace, source, template);
      return { ok: [template, abs_path] };
    } catch (err: any) {
      const e = `Invalid preset content: ${err?.message || err}`;
      this._tell_preset_error(workspace, source, e);
      return { err: e };
    }
  }

  private async _tell_preset_loading(workspace: string, source: EclairPresetTemplateSource, message: string) {
    this.post_message({ command: "preset-content", source, template: { loading: message }, workspace });
  }

  private async _tell_preset_error(workspace: string, source: EclairPresetTemplateSource, message: string) {
    this.post_message({ command: "preset-content", source, template: { error: message }, workspace });
  }

  private async _tell_preset_loaded(workspace: string, source: EclairPresetTemplateSource, template: EclairTemplate) {
    this.post_message({ command: "preset-content", source, template, workspace });
  }
}

/**
 * Recurses through `dir` and collects all files whose name ends with `.ecl`.
 */
async function find_ecl_preset_files(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await find_ecl_preset_files(full));
    } else if (entry.isFile() && entry.name.endsWith(".ecl")) {
      const content = await fs.promises.readFile(full, { encoding: "utf8" });
      const yaml_content = await extract_yaml_from_ecl_content(content);
      if (yaml_content) {
        results.push(full);
      }
    }
  }
  return results;
}

/**
 * Returns the root directory used to cache repo checkouts.
 * Structure: `<internalToolsDir>/sca/eclair/repos/checkouts/`
 */
function get_repo_checkouts_root(): string {
  return path.join(getInternalToolsDirRealPath(), "sca", "eclair", "repos", "checkouts");
}

/**
 * Returns a stable 12-character hex identifier derived from a git origin URL.
 */
function origin_hash(origin: string): string {
  return crypto.createHash("sha256").update(origin).digest("hex").slice(0, 12);
}

function sanitize_path_component(value: string): string {
  return value.replace(/[/\\:*?"<>|]/g, "_");
}

/**
 * Returns the on-disk path for a specific (origin, ref[, rev]) checkout:
 * `<internalToolsDir>/sca/eclair/repos/checkouts/<origin-hash>/<ref-or-rev>/`
 *
 * The `ref` component is sanitized so it cannot contain path separators or
 * characters illegal on common filesystems. The logical repo `name` is
 * intentionally NOT part of the path: two workspace projects may use repos
 * with different names that point at the same origin, and they should share
 * the same cached checkout. Conversely, two repos with the same name but
 * different origins must occupy distinct directories (the hash ensures this).
 */
function get_checkout_dir(origin: string, ref: string, rev: string): string {
  const hash = origin_hash(origin);
  const safe_ref = sanitize_path_component(rev);
  return path.join(get_repo_checkouts_root(), hash, safe_ref);
}

/** The refs the ECLAIR Manager resolved for `origin`, recorded next to its checkouts. */
function resolved_refs_file(origin: string): string {
  return path.join(get_repo_checkouts_root(), origin_hash(origin), "resolved-refs.json");
}

type ResolvedRefs = Record<string, { rev?: unknown; at?: unknown }>;

function read_resolved_refs(origin: string): ResolvedRefs {
  try {
    const data = JSON.parse(fs.readFileSync(resolved_refs_file(origin), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/**
 * Records the revision `ref` of `origin` resolved to, and when, so a run that
 * must not reach git servers finds the checkout of any ref: HEAD, a pull
 * request ref, or a ref whose revision is the checkout of another ref, which
 * git's own files name only for the first ref it was fetched for. A failure
 * only loses the record.
 */
function record_resolved_ref(origin: string, ref: string, rev: string): void {
  try {
    const refs = read_resolved_refs(origin);
    refs[ref] = { rev, at: Date.now() };
    const file = resolved_refs_file(origin);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(refs, null, 2));
  } catch {
    // A run offline then goes by what git recorded.
  }
}

/**
 * The refs a checkout is known to have been made for, read from its git files
 * without running git: the ref FETCH_HEAD records it was fetched for, and,
 * for a checkout cloned in full, the branches and tags of its packed-refs that
 * name its revision `rev`.
 */
function checkout_ref_names(dir: string, rev: string): Set<string> {
  const read = (file: string) => {
    try {
      return fs.readFileSync(path.join(dir, ".git", file), "utf8");
    } catch {
      return "";
    }
  };
  const names = new Set<string>();
  // "<sha>\t[not-for-merge]\tbranch 'main' of <origin>", "tag 'v1.0' of", or
  // "'refs/pull/1/head' of" for any other ref. A fetch of HEAD leaves out the
  // "<ref> of" and records the origin alone.
  for (const line of read("FETCH_HEAD").split(/\r?\n/)) {
    const fetched = /^[0-9a-f]+\t[^\t]*\t(.+)$/.exec(line);
    if (!fetched) {
      continue;
    }
    const named = /^(?:(?:branch|tag) )?'(.+)' of /.exec(fetched[1]);
    if (named) {
      names.add(named[1]);
    } else if (!fetched[1].startsWith("remote-tracking branch ")) {
      names.add("HEAD");
    }
  }
  // "<sha> refs/tags/v1.0", followed by "^<sha>" when the tag is annotated.
  const wanted = rev.toLowerCase();
  let previous: string | undefined;
  for (const line of read("packed-refs").split(/\r?\n/)) {
    const peeled = /^\^([0-9a-f]+)$/.exec(line);
    const entry = /^([0-9a-f]+) refs\/(?:remotes\/origin|heads|tags)\/(.+)$/.exec(line);
    if (peeled && previous && peeled[1].startsWith(wanted)) {
      names.add(previous);
    } else if (entry && entry[1].startsWith(wanted)) {
      names.add(entry[2]);
    }
    previous = entry ? entry[2] : undefined;
  }
  return names;
}

/**
 * The revisions of `origin` checked out on this machine for `ref`, the one
 * most recently known to be what `ref` names first: by the ECLAIR Manager
 * resolving it, or by git fetching it. Found without any network access, for
 * a run that must not reach git servers. A checkout made for another ref of
 * the same origin is left out, even when it is newer.
 */
export function local_checkout_revs(origin: string, ref: string): string[] {
  const dir = path.join(get_repo_checkouts_root(), origin_hash(origin));
  const trimmed = ref.trim();
  const name = trimmed.replace(/^refs\/(?:heads|tags)\//, "");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const fetched_at = (checkout: string) => {
    try {
      return fs.statSync(path.join(checkout, ".git", "FETCH_HEAD")).mtimeMs;
    } catch {
      return fs.statSync(checkout).mtimeMs;
    }
  };
  /** Per checkout folder, when it was last known to be what `ref` names. */
  const known = new Map<string, number>();
  const checkouts = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const checkout of checkouts) {
    if (checkout_ref_names(path.join(dir, checkout), checkout).has(name)) {
      known.set(checkout, fetched_at(path.join(dir, checkout)));
    }
  }
  const resolved = read_resolved_refs(origin)[trimmed];
  if (resolved && typeof resolved.rev === "string" && typeof resolved.at === "number") {
    const checkout = sanitize_path_component(resolved.rev);
    if (checkouts.includes(checkout)) {
      known.set(checkout, Math.max(known.get(checkout) ?? 0, resolved.at));
    }
  }
  return [...known]
    .sort((a, b) => b[1] - a[1])
    .map(([checkout]) => checkout);
}

/**
 * Reads the `remote.origin.url` of an existing checkout using `git remote
 * get-url origin`.  Returns `undefined` if the command fails (e.g. the
 * directory is not a git repo or has no remote named "origin").
 */
async function read_remote_origin(dir: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const { exec } = require("child_process") as typeof import("child_process");
    exec("git remote get-url origin", { cwd: dir }, (_err, stdout) => {
      resolve(stdout.trim() || undefined);
    });
  });
}

export function looks_like_sha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value.trim());
}

export async function resolve_ref_to_rev(origin: string, ref: string): Promise<string | undefined> {
  const trimmed = ref.trim();
  if (!trimmed) {
    return undefined;
  }
  if (looks_like_sha(trimmed)) {
    return trimmed;
  }
  const refsResult = await ls_remote(origin);
  if ("err" in refsResult) {
    return undefined;
  }
  const refs = refsResult.ok;
  const rev =
    refs[`refs/tags/${trimmed}^{}`] ||
    refs[`refs/heads/${trimmed}`] ||
    refs[`refs/tags/${trimmed}`] ||
    refs[trimmed];
  if (rev) {
    record_resolved_ref(origin, trimmed, rev);
  }
  return rev;
}

async function read_head_rev(dir: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const { exec } = require("child_process") as typeof import("child_process");
    exec("git rev-parse HEAD", { cwd: dir }, (_err, stdout) => {
      resolve(stdout.trim() || undefined);
    });
  });
}

async function is_checkout_usable(dir: string, origin: string, expected_rev?: string): Promise<boolean> {
  const isGitDir = fs.existsSync(path.join(dir, ".git")) || fs.existsSync(path.join(dir, "HEAD"));
  if (!isGitDir) {
    return false;
  }

  const storedOrigin = await read_remote_origin(dir);
  if (storedOrigin !== origin) {
    return false;
  }

  if (expected_rev) {
    const head = await read_head_rev(dir);
    return !!head && head.startsWith(expected_rev);
  }

  return true;
}

async function checkout_repo_into_dir(checkoutDir: string, origin: string, ref: string, rev?: string): Promise<void> {
  if (await is_checkout_usable(checkoutDir, origin, rev)) {
    return;
  }

  if (fs.existsSync(checkoutDir)) {
    await fs.promises.rm(checkoutDir, { recursive: true, force: true });
  }

  await fs.promises.mkdir(checkoutDir, { recursive: true });

  const run = (cmd: string, cwd: string) =>
    new Promise<void>((resolve, reject) => {
      const { exec } = require("child_process") as typeof import("child_process");
      exec(cmd, { cwd }, (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`Command failed (${cmd}): ${stderr || err.message}`));
        } else {
          resolve();
        }
      });
    });

  // Init an empty repo and fetch the desired ref.
  await run("git init", checkoutDir);
  await run(`git remote add origin ${JSON.stringify(origin)}`, checkoutDir);

  try {
    if (rev) {
      if (rev === ref) {
        await run(`git fetch origin ${JSON.stringify(ref)}`, checkoutDir);
      } else {
        await run(`git fetch --depth=1 origin ${JSON.stringify(ref)}`, checkoutDir);
      }
      await run(`git checkout ${JSON.stringify(rev)}`, checkoutDir);
    } else {
      // Fetch the specific ref-spec. Works for both branches and tags.
      // For a commit SHA this fetch won't work on servers that don't allow
      // uploadpack.allowReachableSHA1InWant; in that case we fall back to a
      // shallow clone below.
      await run(`git fetch --depth=1 origin ${JSON.stringify(ref)}`, checkoutDir);
      await run("git checkout FETCH_HEAD", checkoutDir);
    }
  } catch {
    // Fallback: clone fresh.
    await fs.promises.rm(checkoutDir, { recursive: true, force: true });
    await fs.promises.mkdir(checkoutDir, { recursive: true });
    if (rev) {
      await run(
        `git clone ${JSON.stringify(origin)} ${JSON.stringify(checkoutDir)}`,
        os.homedir()
      );
      await run(`git checkout ${JSON.stringify(rev)}`, checkoutDir);
    } else {
      await run(
        `git clone --depth=1 --branch ${JSON.stringify(ref)} ${JSON.stringify(origin)} ${JSON.stringify(checkoutDir)}`,
        os.homedir()
      );
    }
  }
}

/**
 * Ensures `origin`@`ref` is available at the canonical checkout directory and
 * returns the directory path.  Acts like a minimal package manager:
 *
 * - If the directory already exists AND its remote.origin.url matches the
 *   expected `origin`, it is returned immediately (fast path, no network).
 * - If the directory exists but the remote URL has changed (e.g. the user
 *   edited the repo entry), the stale checkout is deleted and re-cloned.
 * - Otherwise the repo is cloned with `--no-checkout`, the requested revision
 *   is fetched, and then checked out with `git checkout`.
 *
 * The checkout directory layout is:
 * `<internalToolsDir>/sca/eclair/repos/checkouts/<origin-hash>/<ref-or-rev>/`
 *
 * @param name Logical / human-readable name (used only for log messages).
 * @param origin Git remote URL.
 * @param ref Branch or tag to resolve the revision.
 * @param rev Optional locked commit SHA to check out.
 * @returns The absolute path to the checked-out working tree.
 */
async function ensure_repo_checkout(name: string, origin: string, ref: string, rev?: string): Promise<[string, string]> {
  const resolved_rev = rev ?? await resolve_ref_to_rev(origin, ref);
  if (!resolved_rev) {
    throw new Error(`Failed to resolve ref '${ref}' for repo '${name}'.`);
  }
  const checkoutDir = get_checkout_dir(origin, ref, resolved_rev);
  await checkout_repo_into_dir(checkoutDir, origin, ref, resolved_rev);
  return [checkoutDir, resolved_rev];
}

export async function deleteRepoCheckout(origin: string, ref: string, rev: string): Promise<void> {
  const checkoutDir = get_checkout_dir(origin, ref, rev);
  if (fs.existsSync(checkoutDir)) {
    await fs.promises.rm(checkoutDir, { recursive: true, force: true });
  }
}

export async function getRepoHeadRevision(dir: string): Promise<string | undefined> {
  return read_head_rev(dir);
}

/**
 * Returns a mapping of all refs (branches and tags) to their corresponding commit hashes for the given remote URL.
 * 
 * Uses `git ls-remote` under the hood.
 *
 * @param url The Git remote URL to query.
 * @returns A promise that resolves to an object mapping ref names to commit hashes, or an error message if the command fails.
 */
async function ls_remote(
  url: string,
): Promise<Result<{ [ref: string]: string }, string>> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      exec(`git ls-remote ${JSON.stringify(url)}`, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Failed to list remote refs: ${stderr || err.message}`));
        } else {
          resolve(stdout);
        }
      });
    });

    const refs: { [ref: string]: string } = {};
    stdout.split(/\r?\n/).forEach((line) => {
      const [hash, ref] = line.split(/\s+/);
      if (hash && ref) {
        refs[ref] = hash;
      }
    });
    return { ok: refs };
  } catch (err) {
    return { err: (err as Error).message };
  }
}

async function load_preset_from_path(
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
