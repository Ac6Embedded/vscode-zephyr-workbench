// A debug session that answers scripted DAP requests, with the adapter
// tracker VS Code would install on it, so the debug_app tests drive the real
// session tracker without any debug adapter. Every request is recorded, and
// its successful response goes through the tracker as the adapter's would.

import * as vscode from 'vscode';
import { adapterTrackerFor, TrackedDebugSession, workbenchDebugSessions } from '../../../debug/sessionTracker';

export type RequestHandler = (args: any, fake: FakeDebugSession) => unknown;

export interface FakeDebugSession {
  session: vscode.DebugSession;
  tracked: TrackedDebugSession;
  requests: { command: string; args: any }[];
  handlers: Record<string, RequestHandler>;
  /** Send an event from the adapter, now or after `delayMs`. */
  event(name: string, body?: Record<string, unknown>, delayMs?: number): void;
  /** gdb console output, as an output event. */
  print(text: string, delayMs?: number, category?: string): void;
  stop(reason: string, threadId?: number, delayMs?: number): void;
}

export interface FakeSessionOptions {
  id?: string;
  type?: 'cppdbg' | 'cortex-debug';
  name?: string;
  folder: string;
  configuration?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  handlers?: Record<string, RequestHandler>;
  /** What getDebugProtocolBreakpoint answers, by breakpoint id. */
  dapBreakpoints?: Record<string, unknown>;
  state?: 'running' | 'stopped';
  /** The thread of the first stop, when state is stopped. */
  threadId?: number;
}

let counter = 0;

export function fakeDebugSession(options: FakeSessionOptions): FakeDebugSession {
  counter += 1;
  const name = options.name ?? 'Zephyr Workbench Debug [primary]';
  const requests: { command: string; args: any }[] = [];
  const handlers: Record<string, RequestHandler> = { ...(options.handlers ?? {}) };
  let tracker: vscode.DebugAdapterTracker;
  let seq = 0;
  const send = (message: unknown) => tracker.onDidSendMessage?.(message);
  const fake = {} as FakeDebugSession;
  const session = {
    id: options.id ?? `fake-${counter}`,
    type: options.type ?? 'cppdbg',
    name,
    configuration: { name, type: options.type ?? 'cppdbg', ...(options.configuration ?? {}) },
    workspaceFolder: { uri: { fsPath: options.folder } },
    customRequest: async (command: string, args?: any) => {
      requests.push({ command, args });
      // As VS Code: the request goes through the tracker first, and its answer carries its seq.
      seq += 1;
      const requestSeq = seq;
      tracker.onWillReceiveMessage?.({ type: 'request', seq: requestSeq, command, arguments: args });
      const handler = handlers[command];
      if (!handler) {
        throw new Error(`The fake adapter has no answer for ${command}.`);
      }
      const body = await handler(args, fake);
      send({ type: 'response', request_seq: requestSeq, command, success: true, body });
      return body;
    },
    getDebugProtocolBreakpoint: async (bp: vscode.Breakpoint) => options.dapBreakpoints?.[bp.id],
  } as unknown as vscode.DebugSession;
  tracker = adapterTrackerFor(session) as vscode.DebugAdapterTracker;
  const later = (delayMs: number | undefined, action: () => void) => (delayMs === undefined ? action() : void setTimeout(action, delayMs));
  Object.assign(fake, {
    session,
    tracked: workbenchDebugSessions().find(entry => entry.session.id === session.id) as TrackedDebugSession,
    requests,
    handlers,
    event: (event: string, body: Record<string, unknown> = {}, delayMs?: number) => later(delayMs, () => send({ type: 'event', event, body })),
    print: (text: string, delayMs?: number, category = 'console') => later(delayMs, () => send({ type: 'event', event: 'output', body: { category, output: text } })),
    stop: (reason: string, threadId = 1, delayMs?: number) => later(delayMs, () => send({ type: 'event', event: 'stopped', body: { reason, threadId, allThreadsStopped: true } })),
  });
  send({ type: 'response', command: 'initialize', success: true, body: options.capabilities ?? {} });
  send({ type: 'response', command: 'configurationDone', success: true });
  if (options.state === 'stopped') {
    fake.stop('breakpoint', options.threadId ?? 1);
  }
  return fake;
}

/** A frame as the adapters answer stackTrace. */
export function frame(id: number, name: string, file?: string, line?: number) {
  return { id, name, ...(file ? { source: { path: file, name: file.split(/[\\/]/).pop() } } : {}), ...(line ? { line, column: 1 } : {}) };
}
