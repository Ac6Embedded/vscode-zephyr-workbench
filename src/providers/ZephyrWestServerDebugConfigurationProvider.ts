import * as vscode from 'vscode';
import path from 'path';
import { randomUUID } from 'crypto';

import { getZephyrApplication } from '../utils/utils';
import {
  createOpenocdCfg,
  extractDebugBuildConfigName,
  extractWorkspaceApplicationPathFromDebugConfigName,
  getRunner,
  syncLaunchConfigurationProjectPaths,
} from '../utils/debugTools/debugUtils';
import { runWestBuildPreLaunch } from '../utils/debugTools/debugPreLaunch';
import { WestRunner } from '../debug/runners/WestRunner';
import { ZephyrApplication } from '../models/ZephyrApplication';
import { activateCortexDebug, ensureCortexDebugAvailable } from '../debug/backends/cortexDebugExtension';
import { transformToExternalCortexConfig } from '../debug/backends/cortexWest';
import {
  getDebugServerOutputChannel,
  probeTcpPortBusy,
  spawnWestDebugServer,
  waitForWestDebugServerReady,
} from '../debug/backends/serverProcess';
import {
  disposeServerForToken,
  findManagedServerByAppAndPort,
  registerManagedServer,
} from '../debug/backends/serverRegistry';
import {
  DEFAULT_SERVER_READY_TIMEOUT_MS,
  ZW_DEBUG_TYPE,
  getDefaultGdbPort,
} from '../debug/backends/types';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];

function splitGdbTarget(gdbTarget: unknown): { host?: string; port?: string } {
  if (typeof gdbTarget !== 'string' || !gdbTarget.includes(':')) {
    return {};
  }
  const separatorIndex = gdbTarget.lastIndexOf(':');
  return {
    host: gdbTarget.slice(0, separatorIndex).trim() || undefined,
    port: gdbTarget.slice(separatorIndex + 1).trim() || undefined,
  };
}

/**
 * Provider for the `zephyr-workbench` debug type (Cortex-Debug via
 * `west debugserver`).
 *
 * Two-phase resolution:
 *  - `resolveDebugConfiguration` (pre variable substitution): dependency
 *    check, project resolution, generated-path re-sync and pre-launch build —
 *    the same responsibilities the cppdbg provider has.
 *  - `resolveDebugConfigurationWithSubstitutedVariables` (all `${...}` tokens
 *    expanded by VS Code): spawns `west debugserver` directly with the Zephyr
 *    environment (no wrapper script), waits for server readiness, then returns
 *    the session transformed into a cortex-debug `servertype: "external"`
 *    configuration pointed at the started server.
 */
export class ZephyrWestServerDebugConfigurationProvider implements vscode.DebugConfigurationProvider {

  async resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined | null> {
    if (!config.type && !config.request && !config.name) {
      // F5 with no launch.json: this type has no meaningful default config.
      return null;
    }

    if (!(await ensureCortexDebugAvailable('resolve'))) {
      return undefined;
    }

    if (!folder) {
      void vscode.window.showErrorMessage('Zephyr Workbench Debug: cannot resolve the workspace folder for this session.');
      return undefined;
    }

    const project = await this.resolveProject(folder, config.name);
    if (!project) {
      return undefined;
    }

    const buildConfigName = extractDebugBuildConfigName(config.name);
    syncLaunchConfigurationProjectPaths(config, project, buildConfigName);

    if (buildConfigName) {
      await runWestBuildPreLaunch(project, buildConfigName);
    }

    if (WestRunner.extractRunner(config.debugServerArgs) === 'openocd') {
      createOpenocdCfg(project);
    }

    return config;
  }

  async resolveDebugConfigurationWithSubstitutedVariables(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    token?: vscode.CancellationToken,
  ): Promise<vscode.DebugConfiguration | undefined> {
    if (config.type !== ZW_DEBUG_TYPE || !folder) {
      return config;
    }

    const project = await this.resolveProject(folder, config.name);
    if (!project) {
      return undefined;
    }
    const buildConfigName = extractDebugBuildConfigName(config.name);
    const buildConfig = buildConfigName ? project.getBuildConfiguration(buildConfigName) : undefined;
    if (!buildConfig) {
      void vscode.window.showErrorMessage(`Zephyr Workbench Debug: cannot find build configuration for '${config.name}'.`);
      return undefined;
    }

    if (typeof config.debugServerArgs !== 'string' || config.debugServerArgs.trim().length === 0) {
      void vscode.window.showErrorMessage('Zephyr Workbench Debug: the launch configuration has no debugServerArgs. Re-apply the configuration from the Debug Manager.');
      return undefined;
    }

    // The stored debugServerArgs are authoritative for the port (they contain
    // the explicit --gdb-port passed to west); gdbTarget only supplies the
    // host and is the fallback for hand-edited entries.
    const runnerName = WestRunner.extractRunner(config.debugServerArgs);
    const runner = runnerName ? getRunner(runnerName) : undefined;
    runner?.loadArgs(config.debugServerArgs);
    const target = splitGdbTarget(config.gdbTarget);
    const host = target.host ?? 'localhost';
    const port = runner?.serverPort ?? target.port ?? getDefaultGdbPort(runnerName);
    const gdbTarget = `${host}:${port}`;

    const finishTransform = async (serverToken?: string): Promise<undefined> => {
      await activateCortexDebug();
      const transformed = transformToExternalCortexConfig(config, {
        program: typeof config.program === 'string' ? config.program : '',
        cwd: typeof config.cwd === 'string' && config.cwd.length > 0 ? config.cwd : folder.uri.fsPath,
        gdbTarget,
        runnerName,
        serverToken,
      });
      // Returning a config whose `type` differs from the provider's is not
      // honored by VS Code (the session keeps the adapter-less
      // zephyr-workbench type and dies silently). Use the sanctioned redirect
      // instead: explicitly start the cortex-debug session and abort this one
      // by returning undefined.
      getDebugServerOutputChannel().appendLine(`[session] starting cortex-debug (servertype external) against ${gdbTarget}`);
      const started = await vscode.debug.startDebugging(folder, transformed);
      if (started && runnerName === 'qemu') {
        // QEMU writes its serial console (printk / printf) to the
        // debugserver_qemu process stdout, which we stream into this channel.
        // Reveal it (without stealing focus) so the console output is visible
        // for the emulated target, which has no physical UART to watch.
        getDebugServerOutputChannel().show(true);
      }
      if (!started) {
        void vscode.window.showErrorMessage(
          'Zephyr Workbench Debug: VS Code could not start the Cortex-Debug session. Check the "Zephyr Workbench: Debug Server" output for details.',
          'Show Log',
        ).then(choice => {
          if (choice === 'Show Log') {
            getDebugServerOutputChannel().show(true);
          }
        });
        if (serverToken) {
          await disposeServerForToken(serverToken);
        }
      }
      return undefined;
    };

    if (!LOCAL_HOSTS.includes(host)) {
      // Remote GDB server: never spawn or probe (single-connection servers
      // treat any probe as their one client) — attach straight to it. The
      // token marks the session as prepared so the cortex-debug pre-launch
      // provider does not run the West Build a second time (no registry entry
      // exists for it, so lifecycle disposal is a no-op).
      return finishTransform(randomUUID());
    }

    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber <= 0 || portNumber > 65535) {
      void vscode.window.showErrorMessage(`Zephyr Workbench Debug: '${port}' is not a valid GDB server port. Fix the port in the Debug Manager or in launch.json.`);
      return undefined;
    }
    if (await probeTcpPortBusy(portNumber)) {
      const staleServer = findManagedServerByAppAndPort(project.appRootPath, port);
      if (staleServer) {
        await disposeServerForToken(staleServer.token);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (await probeTcpPortBusy(portNumber)) {
        void vscode.window.showErrorMessage(
          `Zephyr Workbench Debug: port ${port} is already in use — another debug session or a stale GDB server may be running. Stop it or change the GDB port in the Debug Manager.`,
        );
        return undefined;
      }
    }

    let proc;
    try {
      proc = spawnWestDebugServer(project, buildConfig, config.debugServerArgs);
    } catch (error) {
      void vscode.window.showErrorMessage(`Zephyr Workbench Debug: cannot start west debugserver. ${(error as Error).message}`);
      return undefined;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Starting west debugserver${runnerName ? ` (${runnerName})` : ''}...`,
          cancellable: true,
        },
        (_progress, progressToken) => waitForWestDebugServerReady(proc, {
          port: portNumber,
          startedPattern: runner?.serverStartedPattern,
          timeoutMs: typeof config.serverReadyTimeout === 'number' ? config.serverReadyTimeout : DEFAULT_SERVER_READY_TIMEOUT_MS,
          cancellationTokens: [token, progressToken],
        }),
      );
    } catch (error) {
      await proc.dispose();
      const reason = (error as Error).message;
      if (reason !== 'cancelled') {
        const tail = proc.outputTail();
        void vscode.window.showErrorMessage(
          `Zephyr Workbench Debug: the GDB server did not start. ${reason}${tail ? `\n${tail.split('\n').slice(-3).join('\n')}` : ''}`,
          'Show Log',
        ).then(choice => {
          if (choice === 'Show Log') {
            getDebugServerOutputChannel().show(true);
          }
        });
      }
      return undefined;
    }

    const serverToken = randomUUID();
    registerManagedServer({
      token: serverToken,
      appRootPath: project.appRootPath,
      buildConfigName,
      port,
      proc,
    });
    return finishTransform(serverToken);
  }

  private async resolveProject(folder: vscode.WorkspaceFolder, configName: string): Promise<ZephyrApplication | undefined> {
    try {
      const workspaceApplicationPath = extractWorkspaceApplicationPathFromDebugConfigName(configName);
      return await getZephyrApplication(workspaceApplicationPath
        ? path.join(folder.uri.fsPath, workspaceApplicationPath)
        : folder.uri.fsPath);
    } catch (error) {
      void vscode.window.showErrorMessage(`Zephyr Workbench Debug: cannot resolve the application for '${configName}'. ${(error as Error).message ?? ''}`);
      return undefined;
    }
  }
}
