/**
 * Debugging one core of a multicore target.
 *
 * A GDB server that serves every core of a target from one process gives each
 * core its own port: the server listens on a base port for the first core and
 * on the next ports for the following ones. OpenOCD does this, so
 * `--gdb-port 3333` serves core 0 on 3333, core 1 on 3334, and so on.
 *
 * The launch entries keep the base port, which is what the server is started
 * with, in the `--gdb-port` of `debugServerArgs`, and the port the debugger
 * connects to, base + core, where they already hold it (`gdbTarget`, or the
 * `target-select` of the cppdbg setup commands). The core is the difference.
 *
 * Pure on purpose: the Debug Manager's webview imports this file too.
 */

/** The west runners whose server serves each core of a target on its own port. */
export const MULTI_CORE_RUNNERS: readonly string[] = ['openocd'];

/**
 * The highest core read back from an entry. A gap wider than this between the
 * server's port and the debugger's is a hand edit, not a core.
 */
export const MAX_GDB_CORE = 15;

export function runnerHasCores(runnerName: string | undefined): boolean {
  return !!runnerName && MULTI_CORE_RUNNERS.includes(runnerName.toLowerCase());
}

function asPort(value: string | undefined): number | undefined {
  const text = value?.trim();
  return text && /^\d+$/.test(text) ? Number(text) : undefined;
}

/** Whether a Debug Manager "Core" value is a core number. */
export function isGdbCore(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_GDB_CORE;
}

/**
 * The port the debugger connects to for `core` of a server on `serverPort`.
 * Anything that is not a number is returned as it is, so a bad port is still
 * reported by the checks that follow, not hidden here.
 */
export function gdbClientPort(serverPort: string, core: number | undefined): string {
  const base = asPort(serverPort);
  return base === undefined || !core ? serverPort : String(base + core);
}

/**
 * The server's base port and the core, from the two ports an entry holds.
 * Undefined when they do not describe a core: a port missing or not a number,
 * or a debugger port below the server's or too far above it.
 */
export function splitGdbCore(
  serverPort: string | undefined, clientPort: string | undefined,
): { serverPort: string; clientPort: string; core: number } | undefined {
  const base = asPort(serverPort);
  const client = asPort(clientPort);
  if (base === undefined || client === undefined) {
    return undefined;
  }
  const core = client - base;
  return core >= 0 && core <= MAX_GDB_CORE
    ? { serverPort: String(base), clientPort: String(client), core }
    : undefined;
}

/**
 * The port the debugger connects to, from what a stored entry holds: the
 * server's port (the `--gdb-port` of its arguments) wins over gdbTarget's,
 * except for a runner that has cores, whose gdbTarget holds the core's port.
 */
export function resolveDebuggerPort(
  runnerName: string | undefined, serverPort: string | undefined, targetPort: string | undefined,
): string | undefined {
  const cores = runnerHasCores(runnerName) ? splitGdbCore(serverPort, targetPort) : undefined;
  return cores?.clientPort ?? serverPort ?? targetPort;
}
