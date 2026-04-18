import * as vscode from 'vscode';
import path from "path";
import { ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from "../../constants";
import { execCommandWithEnv } from '../../utils/execUtils';
import { detectRunnerVersion } from '../../utils/debugTools/debugToolVersionUtils';

export const ZEPHYR_WORKBENCH_DEBUG_PATH_SETTING_KEY = 'pathExec';

export enum RunnerType {
  FLASH,
  DEBUG
}

/** A flag/value pair the parser should recognize as runner-generated and strip out. */
interface AutoTokenPair {
  flag: string;
  value: string;
}

export class WestRunner {
  name!: string;
  label!: string;
  binDirPath: string = "";
  types?: RunnerType[];
  serverPath?: string;
  serverStartedPattern?: string;
  serverAddress?: string;
  serverPort?: string;
  args: { [key: string]: string } = {};
  userArgs: string = "";

  private getSettingKey(key: string): string {
    return `debug.${this.name}.${key}`;
  }

  get executable(): string | undefined {
    if(this.serverPath) {
      return path.basename(this.serverPath);
    } else {
      return undefined;
    }
  }

  /**
   * Parse a saved `debugServerArgs` string and populate `serverPath`, `serverPort`
   * and `userArgs`.
   *
   * The parser walks tokens and consumes anything it recognizes as runner-generated
   * (--runner / --build-dir / server-path / gdb-port / per-runner extras) regardless
   * of where it appears in the string. Whatever is not recognized is kept verbatim in
   * `userArgs`, so a user can hand-edit `launch.json` (add custom flags, reorder
   * things) and the Debug Manager will round-trip those edits without losing them.
   *
   * Subclasses customize the parser via three small hooks:
   *   - `getServerPathFlags()`  — which flag(s) carry the executable path
   *   - `getGdbPortFlag()`      — which flag carries the port (default `--gdb-port`)
   *   - `getExtraAutoTokens()`  — extra flag/value pairs the runner emits in
   *                                `autoArgs` (e.g. OpenOCD's two `--config` files)
   */
  loadArgs(args: string | undefined) {
    if (!args) {
      return;
    }

    const tokens = WestRunner.tokenizeArgs(args);
    const serverPathFlags = new Set(this.getServerPathFlags());
    const gdbPortFlag = this.getGdbPortFlag();
    const extraTokens = this.getExtraAutoTokens();
    const remaining: string[] = [];

    let i = 0;
    // Skip the leading west subcommand when present (`debugserver` for debug,
    // `flash` for flash). Anything else means the args were stored without the
    // command prefix — start parsing from the first token.
    if (tokens[0] === 'debugserver' || tokens[0] === 'flash') {
      i = 1;
    }

    while (i < tokens.length) {
      const tok = tokens[i];
      const next = tokens[i + 1];
      const hasNext = next !== undefined;

      // Always-known runner-emitted pairs.
      if (hasNext && (tok === '--build-dir' || tok === '--runner')) {
        i += 2;
        continue;
      }

      if (hasNext && serverPathFlags.has(tok)) {
        this.serverPath = WestRunner.unquote(next);
        i += 2;
        continue;
      }

      if (hasNext && tok === gdbPortFlag) {
        this.serverPort = next;
        i += 2;
        continue;
      }

      // Runner-declared extras (e.g. OpenOCD's `--config <file>` lines). Compare
      // unquoted values so quoting differences between save/read don't matter.
      if (hasNext && extraTokens.some(p => p.flag === tok && WestRunner.unquote(p.value) === WestRunner.unquote(next))) {
        i += 2;
        continue;
      }

      // Anything else is treated as a user-provided argument.
      remaining.push(tok);
      i++;
    }

    this.userArgs = remaining.join(' ');
  }

  /**
   * Flag(s) used to pass this runner's executable path on the west command line.
   * Default is `--<runner-name>` because that is what `runnerPathArg` injects.
   * Override to add more (e.g. JLink also accepts `--gdbserver`).
   */
  protected getServerPathFlags(): string[] {
    return [`--${this.name}`];
  }

  /** Flag used to pass the GDB server port. Override per runner if it differs. */
  protected getGdbPortFlag(): string {
    return '--gdb-port';
  }

  /**
   * Flag/value pairs that this runner appends in `autoArgs` (config files, etc.).
   * Declaring them here lets `loadArgs` strip them on read so they don't leak into
   * `userArgs` and accumulate on every save/open round-trip.
   */
  protected getExtraAutoTokens(): AutoTokenPair[] {
    return [];
  }

  /**
   * Shell-style tokenizer: splits on whitespace but treats a `"…"` span as one token
   * (quotes are kept on the token; `unquote` strips them when needed). Sufficient for
   * the args VS Code stores in launch.json.
   */
  protected static tokenizeArgs(input: string): string[] {
    const tokens: string[] = [];
    let i = 0;
    while (i < input.length) {
      while (i < input.length && /\s/.test(input[i])) {i++;}
      if (i >= input.length) {break;}

      let token = '';
      if (input[i] === '"') {
        token += input[i++];
        while (i < input.length && input[i] !== '"') {token += input[i++];}
        if (i < input.length) {token += input[i++];} // consume closing quote
      } else {
        while (i < input.length && !/\s/.test(input[i])) {token += input[i++];}
      }
      tokens.push(token);
    }
    return tokens;
  }

  /** Strip a single pair of surrounding double quotes, if any. */
  protected static unquote(value: string): string {
    return value.replace(/^"(.*)"$/, '$1');
  }

  async loadInternalArgs() {
  }

  /**
   * Kept as a no-op for backward compatibility with subclasses (notably the
   * flash-only runners) that still call `this.loadUserArgs(args)` after
   * `super.loadArgs(args)`. The new token-based `loadArgs` now extracts user args
   * itself, so there is nothing left to do here.
   */
  protected loadUserArgs(_args: string) {
    // intentionally empty
  }

  getWestDebugArgs(relativeBuildDir: string): string {
    return `debugserver --build-dir "\${workspaceFolder}/${relativeBuildDir}" ${this.autoArgs} ${this.userArgs}`;
  }

  getWestFlashArgs(relativeBuildDir: string): string {
    return `flash --build-dir "\${workspaceFolder}/build/${relativeBuildDir}" ${this.autoArgs} ${this.userArgs}`;
  }

  get autoArgs(): string {
    let args = `--runner ${this.name}`;
    if(this.serverPort) {
       args += ` --gdb-port ${this.serverPort}`;
    }
    return args;
  }

  loadSettings() {
    // No-op: runner paths are detected from environment; settings removed
  }

  async updateSettings() {
    // No-op: do not persist runner path to settings
  }

  getSetting(key: string): string | undefined {
    // Settings for debug runner paths are no longer used
    return undefined;
  }

  async updateSetting(key: string, value: string) {
    await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).update(this.getSettingKey(key), value);
  }

  async detect(): Promise<boolean> {
    let execPath = '';
    if(this.serverPath) {
      execPath = this.serverPath;
    } else if(this.executable) {
      execPath = this.executable;
    }

    if(execPath.includes(' ')) {
      execPath=`"${execPath}"`;
    }

    let versionCmd = `${execPath} --version`;
    if(process.platform === 'linux' || process.platform === 'darwin') {
      versionCmd = `${versionCmd} 2>&1`;
    }
    return new Promise<boolean>((resolve, reject) => {
      execCommandWithEnv(`${versionCmd}`, undefined, (error: any, stdout: string, stderr: any) => {
        if (error) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  async detectVersion(): Promise<string | undefined> {
    const execPath = this.serverPath || this.executable;
    const normalizedExecPath = execPath?.replace(/^"(.*)"$/, '$1');
    return detectRunnerVersion(this.name, normalizedExecPath);
  }

  get versionRegex(): any | undefined {
    return undefined;
  }

  static extractRunner(args: any): string | undefined {
    const runnerRegex = /--runner\s+("[^"]+"|\S+)/;
    const runnerMatch = args.match(runnerRegex);

    if(runnerMatch) {
      return runnerMatch[1];
    }

    return undefined;
  }

}
