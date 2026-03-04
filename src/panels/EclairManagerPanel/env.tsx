
import z from "zod";
import fs from "fs";
import path from "path";
import yaml from "yaml";
import { getInternalDirRealPath } from "../../utils/utils";
import { getOutputChannel } from "../../utils/execUtils";
import { Result } from "../../utils/typing_utils";
import * as vscode from "vscode";

const EnvDataSchema = z.looseObject({
  other: z
    .looseObject({
      EXTRA_TOOLS: z
        .looseObject({
          path: z.array(z.string()).catch([]).optional(),
        })
        .catch({})
        .optional(),
    })
    .catch({})
    .optional(),
});

export type EnvData = z.infer<typeof EnvDataSchema>;

export class EclairManagerEnv {
  private _data: EnvData | undefined = undefined;
  private _watcher: fs.FSWatcher | undefined;
  private _on_change_callbacks: ((data: Result<EnvData, string>) => void)[] = [];

  dispose(): void {
    this.stop_env_watcher();
  }

  get env_yaml_path(): string {
    return path.join(getInternalDirRealPath(), "env.yml");
  }

  get data(): EnvData | undefined {
    return this._data;
  }

  /**
   * Loads the env data from the env.yml file.
   *
   * If the file does not exist, an empty config is initialized.
   *
   * If the load fails, the error message is returned. No empty config
   * is initialized in this case, since the failure is likely due to a
   * malformed file that needs to be fixed and we don't want to
   * overwrite it with an empty config.
   */
  load(): Result<EnvData, string> {
    try {
      const env_yaml_path = this.env_yaml_path;
      if (fs.existsSync(env_yaml_path)) {
        const data = yaml.parse(fs.readFileSync(env_yaml_path, "utf-8"));
        this._data = EnvDataSchema.parse(data);
      } else {
        // the env.yml file does not exist yet, so we start with an
        // empty env config
        this._data = {};
      }
      return { ok: this._data };
    } catch (e: unknown) {
      const out = getOutputChannel();
      this._data = undefined;
      const message = e instanceof Error ? e.message : String(e);
      out.appendLine(`[EclairManagerEnv] Failed to load env data: ${message}`);
      return { err: message };
    }
  }

  save(): void {
    if (!this._data) {
      // Not loaded, nothing to save
      return;
    }

    try {
      const env_yaml_path = this.env_yaml_path;

      const yaml_data = yaml.stringify(this._data);
      const out = getOutputChannel();
      out.appendLine(`[EclairManagerEnv] Saving env data to ${env_yaml_path}:\n${yaml_data}`);
      fs.writeFileSync(env_yaml_path, yaml_data, "utf-8");
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`[EclairManagerEnv] Failed to save env data: ${message}`);
    }
  }

  start_env_watcher(): Result<void, string> {
    this.stop_env_watcher();

    try {
      this._watcher = fs.watch(this.env_yaml_path, () => {
        const load_result = this.load();
        if ("err" in load_result) {
          vscode.window.showErrorMessage(`[EclairManagerEnv] Failed to reload env data after change: ${load_result.err}`);
        }
        for (const callback of this._on_change_callbacks) {
          try {
            callback(load_result);
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`[EclairManagerEnv] Failure in env change callback: ${message}`);
          }
        }
      });
      return { ok: undefined };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { err: message };
    }
  }

  stop_env_watcher(): void {
    if (!this._watcher) {
      return;
    }
    this._watcher.close();
    this._watcher = undefined;
  }

  on_changed(callback: (data: Result<EnvData, string>) => void): void {
    this._on_change_callbacks.push(callback);
  }

  /**
   * Saves the given path to the env config
   * 
   * `idx` is the index of the existing path to replace. If not provided, the
   * new path is prepended to the list of existing paths.
   *
   * If `extra_path` is `undefined`, the existing path at `idx` is removed.
   *
   * This function also deduplicates paths in the config to avoid clutter,
   * since users may update the path multiple times and we don't want
   * duplicated entries to accumulate.
   * 
   * @param extra_path The path to save
   * @param idx The index of the existing path to replace
   */
  save_extra_path(extra_path: string | undefined, idx?: number): void {
    // NOTE a similar work is done in setExtraPath, but this should be slightly more robust
    // TODO consider refactoring to avoid code duplication

    if (!this._data) {
      const out = getOutputChannel();
      out.appendLine(`[EclairManagerEnv] No env data loaded, cannot save path`);
      return;
    }

    if (idx === undefined || idx < 0 || !this._data.other?.EXTRA_TOOLS?.path) {
      if (extra_path !== undefined) {
        // Prepend the new path to the existing ones (if any)
        this._data.other = {
          ...this._data.other,
          EXTRA_TOOLS: {
            ...this._data.other?.EXTRA_TOOLS,
            path: [extra_path, ...(this._data.other?.EXTRA_TOOLS?.path || [])],
          },
        };
      } else {
        // Nothing to save
        return;
      }
    } else {
      if (extra_path !== undefined) {
        // Replace the existing path at the specified index
        this._data.other.EXTRA_TOOLS.path[idx] = extra_path;
      } else {
        this._data.other.EXTRA_TOOLS.path.splice(idx, 1);
      }
    }

    // deduplicate paths while preserving order
    if (this._data.other?.EXTRA_TOOLS?.path) {
      const seen = new Set<string>();
      this._data.other.EXTRA_TOOLS.path = this._data.other.EXTRA_TOOLS.path.filter((p) => {
        // Windows and macOS are case insensitive so we normalize paths to
        // lowercase when checking for duplicates on those platforms
        const p2 = (process.platform === "win32" || process.platform === "darwin") ? p.toLowerCase() : p;
        if (seen.has(p2)) {
          return false;
        }
        seen.add(p2);
        return true;
      });
    }

    this.save();
  }
}
