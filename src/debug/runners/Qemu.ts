import { RunnerType, WestRunner } from './WestRunner';

/**
 * Runner for the Zephyr QEMU emulator.
 *
 * QEMU is not debugged through a west runner: `west debugserver -r qemu` is a
 * capability-less stub on most Zephyr versions (see zephyr#105430). Instead we
 * start QEMU halted with its GDB stub through the version-agnostic CMake target
 * `debugserver_qemu` (equivalent to `west build -t debugserver_qemu`). QEMU
 * loads the ELF itself and waits on a TCP GDB port (default 1234, configurable
 * with the Kconfig option CONFIG_QEMU_GDBSERVER_LISTEN_DEV), so there is no
 * flash or download step and no `--runner` / `--gdb-port` flag to pass.
 */
export class Qemu extends WestRunner {
  name = 'qemu';
  label = 'QEMU';
  types = [RunnerType.DEBUG];
  // Printed by the Zephyr build system right before QEMU starts with its GDB
  // stub halted (-S). Used as the server-ready banner for the west backend.
  serverStartedPattern = 'To exit from QEMU enter';

  override getWestDebugArgs(relativeBuildDir: string, domain?: string): string {
    // `west build` accepts --domain for sysbuild trees, so the emulator target
    // selects the right image the same way the hardware runners do.
    const domainArg = domain ? ` --domain ${domain}` : '';
    const base = `build -t debugserver_qemu --build-dir "\${workspaceFolder}/${relativeBuildDir}"${domainArg}`;
    return this.userArgs ? `${base} ${this.userArgs}` : base;
  }

  // No --runner / --gdb-port: the listen device comes from Kconfig.
  override get autoArgs(): string {
    return '';
  }

  protected override getGdbPortFlag(): string {
    return '';
  }

  protected override getServerPathFlags(): string[] {
    return [];
  }

  protected override getExtraAutoTokens() {
    return [{ flag: '-t', value: 'debugserver_qemu' }];
  }

  // QEMU is located by the Zephyr build (CMake find_program), not by the
  // extension. Report it as present and let the build surface its own error if
  // the emulator is missing.
  override async detect(): Promise<boolean> {
    return true;
  }

  override async detectVersion(): Promise<string | undefined> {
    return undefined;
  }
}
