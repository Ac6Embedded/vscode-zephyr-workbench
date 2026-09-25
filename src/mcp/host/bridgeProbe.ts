// Starts the bridge exactly as an agent would and talks MCP to it over stdio.
//
// This is the only check that proves the whole path an agent depends on: the
// command in its config runs, the runtime it names exists, the bridge speaks
// MCP on stdout and nothing else, and a call reaches this window. Kept free
// of `vscode` so it is tested against the real bundled bridge.

import { spawn } from 'child_process';

export interface ProbeSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Where the agent would run, which the bridge routes by. */
  cwd?: string;
  /** A tool to call after listing, to prove a call reaches a window. */
  call?: { name: string; arguments: Record<string, unknown> };
  timeoutMs?: number;
}

export interface ProbeResult {
  ok: boolean;
  ms: number;
  serverName?: string;
  serverVersion?: string;
  tools?: string[];
  /** The called tool's parsed result, or its error body. */
  callResult?: unknown;
  callFailed?: boolean;
  error?: string;
  stderr?: string;
}

export function probeBridge(spec: ProbeSpec): Promise<ProbeResult> {
  const started = Date.now();
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ok: false, ms: 0, error: `Could not start ${spec.command}: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const result: ProbeResult = { ok: false, ms: 0 };
    const finish = (patch: Partial<ProbeResult>) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdin?.end();
      child.kill();
      resolve({ ...result, ...patch, ms: Date.now() - started, ...(stderr.trim() ? { stderr: stderr.trim().slice(-2000) } : {}) });
    };
    const timer = setTimeout(
      () => finish({ error: `The bridge did not answer within ${Math.round((spec.timeoutMs ?? 15000) / 1000)} seconds.` }),
      spec.timeoutMs ?? 15000,
    );
    const send = (message: Record<string, unknown>) => child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

    child.on('error', error => finish({ error: `Could not start ${spec.command}: ${error.message}` }));
    child.on('exit', code => finish({ error: `The bridge exited with code ${code} before answering.` }));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      let newline: number;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) {
          continue;
        }
        let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
        try {
          message = JSON.parse(line);
        } catch {
          // Anything but JSON-RPC on stdout breaks every agent, so it is a failure.
          finish({ error: `The bridge wrote something that is not JSON-RPC to stdout: ${line.slice(0, 200)}` });
          return;
        }
        if (message.error) {
          finish({ error: `The bridge answered request ${message.id} with an error: ${message.error.message ?? 'unknown'}` });
          return;
        }
        if (message.id === 1) {
          const info = message.result?.serverInfo as { name?: string; version?: string } | undefined;
          result.serverName = info?.name;
          result.serverVersion = info?.version;
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2) {
          result.tools = ((message.result?.tools ?? []) as { name: string }[]).map(tool => tool.name);
          if (!spec.call) {
            finish({ ok: true });
            return;
          }
          send({ id: 3, method: 'tools/call', params: { name: spec.call.name, arguments: spec.call.arguments } });
        } else if (message.id === 3) {
          const content = (message.result?.content ?? []) as { type: string; text?: string }[];
          const text = content.find(item => item.type === 'text')?.text;
          let parsed: unknown = text;
          try {
            parsed = text ? JSON.parse(text) : undefined;
          } catch {
            // Keep the raw text.
          }
          const failed = message.result?.isError === true;
          finish({ ok: !failed, callResult: parsed, callFailed: failed });
        }
      }
    });

    send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'zephyr-workbench-doctor', version: '1' },
      },
    });
  });
}
