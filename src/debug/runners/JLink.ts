import { probeInstalledVersion } from "../../utils/debugTools/debugToolVersionUtils";
import { RunnerType, WestRunner } from "./WestRunner";

export class JLink extends WestRunner {
  name = 'jlink';
  label = 'J-Link';
  types = [ RunnerType.FLASH, RunnerType.DEBUG ];
  serverStartedPattern = 'GDB Server start settings';

  get executable(): string | undefined {
    const exec = super.executable;
    if(!exec) {
      return process.platform === 'win32' ? 'JLinkGDBServerCL.exe' : 'JLinkGDBServerCL';
    }
  }

  /**
   * Detect installation like the Install Runners panel: run J-Link's `version-command`
   * from debug-tools.yml in the env-sourced shell and use the `installed` flag. Reuses
   * the same by-id probe `detectVersion()` already uses (`probeInstalledVersion`); the
   * base `detect()` instead runs a single `${executable} --version` which fails for
   * J-Link (its real Linux/macOS binary is `JLinkGDBServerCLExe`, not `JLinkGDBServerCL`)
   * and which treats a non-zero exit as not-installed even when the command ran.
   */
  override async detect(): Promise<boolean> {
    return (await probeInstalledVersion(this.name)).installed;
  }

  /**
   * J-Link's saved args can carry the server path under either flag:
   *   - `--jlink <path>`     — injected by `runnerPathArg` in DebugManagerPanel
   *   - `--gdbserver <path>` — emitted by this runner's own `autoArgs`
   * Both must be recognized so a round-trip doesn't leave one of them in `userArgs`.
   */
  protected getServerPathFlags(): string[] {
    return [`--${this.name}`, '--gdbserver'];
  }

  get autoArgs(): string {
    let cmdArgs = super.autoArgs;
    if(this.serverPath) {
      cmdArgs += ` --gdbserver ${this.serverPath}`;
    }
    return cmdArgs;
  }
}
