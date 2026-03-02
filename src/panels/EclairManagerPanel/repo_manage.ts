import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { getInternalToolsDirRealPath } from "../../utils/utils";
import { Result } from "../../utils/typing_utils";
import { exec } from "child_process";
import yaml from "yaml";
import type { ExtensionMessage } from "../../utils/eclairEvent";
import { extract_yaml_from_ecl_content, parse_eclair_template_from_any } from "../../utils/eclair/template_utils";
import type { EclairPresetTemplateSource } from "../../utils/eclair/config";

export class PresetRepositories {
  private readonly post_message: (m: ExtensionMessage) => void;
  private readonly log: (line: string) => void;

  constructor(post_message: (m: ExtensionMessage) => void, log: (line: string) => void) {
    this.post_message = post_message;
    this.log = log;
  }

  async scanRepoPresets(
    name: string,
    origin: string,
    ref: string,
    rev: string | undefined,
    workspace: string,
  ): Promise<void> {
    let checkoutDir: string;
    try {
      this.log(`[PresetRepositories] Scanning repo '${name}' for presets...`);
      checkoutDir = await ensureRepoCheckout(name, origin, ref, rev);
      this.log(`[PresetRepositories] Checked out repo '${name}' to '${checkoutDir}'.`);
    } catch (err: any) {
      this.log(`[PresetRepositories] Failed to checkout repo '${name}': ${err}`);
      this.post_message({
        command: "repo-scan-failed",
        name,
        message: err?.message || String(err),
        workspace,
      });
      return;
    }

    const eclFiles = await findEclFiles(checkoutDir);

    await Promise.allSettled(
      eclFiles.map(async (absPath) => {
        const relPath = path.relative(checkoutDir, absPath).replace(/\\/g, "/");
        const source: EclairPresetTemplateSource = { type: "repo-path", repo: name, path: relPath };

        let content: string;
        try {
          content = await fs.promises.readFile(absPath, { encoding: "utf8" });
        } catch (err: any) {
          this.post_message({ command: "preset-content", source, template: { error: `Could not read file: ${err?.message || err}` }, workspace });
          return;
        }

        const yaml_content = extract_yaml_from_ecl_content(content);
        if (yaml_content === undefined) {
          return;
        }

        let data: any;
        try {
          data = yaml.parse(yaml_content);
        } catch (err: any) {
          this.post_message({ command: "preset-content", source, template: { error: `Failed to parse preset: ${err?.message || err}` }, workspace });
          return;
        }

        try {
          const template = parse_eclair_template_from_any(data);
          this.post_message({ command: "preset-content", source, template, workspace });
        } catch (err: any) {
          this.post_message({ command: "preset-content", source, template: { error: `Invalid preset content: ${err?.message || err}` }, workspace });
        }
      })
    );
  }

  async updateRepoCheckout(
    name: string,
    origin: string,
    ref: string,
    rev: string | undefined,
    delete_rev: string | undefined,
    workspace: string,
  ): Promise<void> {
    this.log(`[PresetRepositories] Deleting cached checkout for '${name}' to force update...`);
    try {
      const delete_target = delete_rev ?? rev;
      if (delete_target) {
        await deleteRepoCheckout(origin, ref, delete_target);
      }
      await deleteRepoCheckout(origin, ref);
    } catch (err: any) {
      this.log(`[PresetRepositories] Failed to delete checkout for '${name}': ${err}`);
      this.post_message({ command: "repo-scan-failed", name, message: err?.message || String(err), workspace });
      return;
    }
    await this.scanRepoPresets(name, origin, ref, rev, workspace);
  }
}

/**
 * Recurses through `dir` and collects all files whose name ends with `.ecl`.
 */
async function findEclFiles(dir: string): Promise<string[]> {
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
      results.push(...await findEclFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ecl")) {
      results.push(full);
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
function get_checkout_dir(origin: string, ref: string, rev?: string): string {
  const hash = origin_hash(origin);
  const checkout_key = (rev && rev.trim()) ? rev : ref;
  const safe_ref = sanitize_path_component(checkout_key);
  return path.join(get_repo_checkouts_root(), hash, safe_ref);
}

/**
 * Returns a unique temporary checkout dir for a given origin/ref. This is used
 * when no revision is known yet, to avoid conflicts between concurrent
 * workspaces that share the same origin+ref.
 */
function get_temp_checkout_dir(origin: string, ref: string): string {
  const hash = origin_hash(origin);
  const safe_ref = sanitize_path_component(ref);
  const suffix = crypto.randomBytes(4).toString("hex");
  return path.join(get_repo_checkouts_root(), hash, "tmp", `${safe_ref}-${suffix}`);
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

function looks_like_sha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value.trim());
}

async function resolve_ref_to_rev(origin: string, ref: string): Promise<string | undefined> {
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
  return (
    refs[`refs/tags/${trimmed}^{}`] ||
    refs[`refs/heads/${trimmed}`] ||
    refs[`refs/tags/${trimmed}`] ||
    refs[trimmed]
  );
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
export async function ensureRepoCheckout(name: string, origin: string, ref: string, rev?: string): Promise<string> {
  const resolved_rev = rev ?? await resolve_ref_to_rev(origin, ref);
  if (resolved_rev) {
    const checkoutDir = get_checkout_dir(origin, ref, resolved_rev);
    await checkout_repo_into_dir(checkoutDir, origin, ref, resolved_rev);
    return checkoutDir;
  }

  // We don't know the revision ahead of time. Check out into a unique temp
  // directory, then move it to a revision-scoped location once we can read HEAD.
  const tempDir = get_temp_checkout_dir(origin, ref);
  await checkout_repo_into_dir(tempDir, origin, ref);

  const head_rev = await read_head_rev(tempDir);
  if (!head_rev) {
    return tempDir;
  }

  const finalDir = get_checkout_dir(origin, ref, head_rev);
  if (finalDir === tempDir) {
    return tempDir;
  }

  // If another process already created the rev-scoped checkout, prefer it.
  if (await is_checkout_usable(finalDir, origin, head_rev)) {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    return finalDir;
  }

  await fs.promises.mkdir(path.dirname(finalDir), { recursive: true });
  try {
    await fs.promises.rename(tempDir, finalDir);
    return finalDir;
  } catch {
    if (await is_checkout_usable(finalDir, origin, head_rev)) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
      return finalDir;
    }
    return tempDir;
  }
}

export async function deleteRepoCheckout(origin: string, ref: string, rev?: string): Promise<void> {
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
