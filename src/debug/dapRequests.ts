// Debug Adapter Protocol requests an agent's debug_app call sends to a
// running session, through DebugSession.customRequest: the standard requests
// both adapters answer (stackTrace, scopes, variables, evaluate, readMemory),
// the custom ones of cortex-debug 1.12 (read-memory, read-registers,
// read-register-list, execute-command), and gdb console commands, whose text
// comes back as output events the session tracker records.

import { outputAfter, TrackedDebugSession } from './sessionTracker';

/** What these helpers need of a vscode.DebugSession. */
export interface DapSessionLike {
  type: string;
  customRequest(command: string, args?: any): Thenable<any>;
}

export interface FrameView {
  index: number;
  id: number;
  function: string;
  file?: string;
  line?: number;
  column?: number;
  address?: string;
}

/** The frames of a thread, innermost first. */
export async function stackFrames(session: DapSessionLike, threadId: number, levels: number): Promise<FrameView[]> {
  const body = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels });
  const frames: any[] = Array.isArray(body?.stackFrames) ? body.stackFrames : [];
  return frames.slice(0, levels).map((frame, index) => ({
    index,
    id: frame.id,
    function: typeof frame.name === 'string' ? frame.name : '??',
    ...(typeof frame.source?.path === 'string' ? { file: frame.source.path } : typeof frame.source?.name === 'string' ? { file: frame.source.name } : {}),
    ...(typeof frame.line === 'number' && frame.line > 0 ? { line: frame.line } : {}),
    ...(typeof frame.column === 'number' && frame.column > 0 ? { column: frame.column } : {}),
    ...(typeof frame.instructionPointerReference === 'string' ? { address: frame.instructionPointerReference } : {}),
  }));
}

export async function threadList(session: DapSessionLike): Promise<{ id: number; name: string }[]> {
  const body = await session.customRequest('threads');
  const threads: any[] = Array.isArray(body?.threads) ? body.threads : [];
  return threads.map(thread => ({ id: thread.id, name: typeof thread.name === 'string' ? thread.name : String(thread.id) }));
}

export interface VariableView {
  name: string;
  value: string;
  type?: string;
  children?: VariableView[];
}

/** Caps on what one inspect returns, shared by every expansion of the call. */
export interface VariableBudget {
  /** Variables left to return in the whole call. */
  items: number;
  /** The longest value kept, in characters. */
  valueChars: number;
  /** The most children read of one structure or array. */
  perLevel: number;
}

export function defaultBudget(): VariableBudget {
  return { items: 400, valueChars: 300, perLevel: 64 };
}

const clip = (value: unknown, max: number) => {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}...` : text;
};

/** The variables of a reference, expanded `depth` levels down, within the budget. */
export async function expandVariables(session: DapSessionLike, reference: number, depth: number, budget: VariableBudget): Promise<VariableView[]> {
  if (budget.items <= 0) {
    return [];
  }
  const body = await session.customRequest('variables', { variablesReference: reference });
  const all: any[] = Array.isArray(body?.variables) ? body.variables : [];
  const out: VariableView[] = [];
  for (const variable of all.slice(0, budget.perLevel)) {
    if (budget.items <= 0) {
      break;
    }
    budget.items -= 1;
    const view: VariableView = {
      name: String(variable.name),
      value: clip(variable.value, budget.valueChars),
      ...(typeof variable.type === 'string' ? { type: variable.type } : {}),
    };
    if (depth > 0 && typeof variable.variablesReference === 'number' && variable.variablesReference > 0) {
      try {
        view.children = await expandVariables(session, variable.variablesReference, depth - 1, budget);
      } catch {
        // A child the adapter cannot read leaves the parent as it is.
      }
    }
    out.push(view);
  }
  const left = all.length - out.length;
  if (left > 0) {
    out.push({ name: '...', value: `${left} more not shown` });
  }
  return out;
}

const REGISTERS_SCOPE = /regist/i;
// cortex-debug lists every global and static of the program: far too much for "locals".
const NOT_LOCAL_SCOPE = /regist|global|static/i;

export async function scopesOf(session: DapSessionLike, frameId: number): Promise<any[]> {
  const body = await session.customRequest('scopes', { frameId });
  return Array.isArray(body?.scopes) ? body.scopes : [];
}

/** The arguments and local variables of a frame, scope by scope. */
export async function localsOf(session: DapSessionLike, frameId: number, depth: number, budget: VariableBudget): Promise<{ scope: string; variables: VariableView[] }[]> {
  const scopes = (await scopesOf(session, frameId)).filter(scope => !NOT_LOCAL_SCOPE.test(String(scope.name)) && scope.expensive !== true);
  const out: { scope: string; variables: VariableView[] }[] = [];
  for (const scope of scopes) {
    out.push({ scope: String(scope.name), variables: await expandVariables(session, scope.variablesReference, depth, budget) });
  }
  return out;
}

export interface ExpressionView {
  expression: string;
  value?: string;
  type?: string;
  children?: VariableView[];
  error?: string;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Evaluate one expression in a frame; a failure is reported for it alone. */
export async function evaluateExpression(
  session: DapSessionLike, expression: string, frameId: number | undefined, depth: number, budget: VariableBudget,
): Promise<ExpressionView> {
  try {
    const body = await session.customRequest('evaluate', { expression, context: 'watch', ...(frameId !== undefined ? { frameId } : {}) });
    const view: ExpressionView = {
      expression,
      value: clip(body?.result, budget.valueChars),
      ...(typeof body?.type === 'string' ? { type: body.type } : {}),
    };
    if (depth > 0 && typeof body?.variablesReference === 'number' && body.variablesReference > 0) {
      view.children = await expandVariables(session, body.variablesReference, depth - 1, budget);
    }
    return view;
  } catch (error) {
    return { expression, error: messageOf(error) };
  }
}

/** The address a value names: the first hexadecimal number in it, else a plain decimal one. */
export function parseAddress(text: string): number | undefined {
  const hex = /\b0x([0-9a-fA-F]{1,16})\b/.exec(text);
  if (hex) {
    const value = parseInt(hex[1], 16);
    return Number.isSafeInteger(value) ? value : undefined;
  }
  const decimal = /^\s*(\d{1,16})\s*$/.exec(text);
  return decimal ? Number(decimal[1]) : undefined;
}

export const hexAddress = (address: number) => `0x${address.toString(16).padStart(8, '0')}`;

/** Bytes from gdb's x/<n>xb output: "0x20000000 <buf>:\t0x01\t0x02 ...". */
export function parseGdbHexBytes(text: string): { address?: number; bytes: number[] } {
  let address: number | undefined;
  const bytes: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(0x[0-9a-fA-F]+)[^:]*:(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    address ??= parseInt(match[1], 16);
    for (const token of match[2].matchAll(/0x([0-9a-fA-F]{2})\b/g)) {
      bytes.push(parseInt(token[1], 16));
    }
  }
  return { ...(address !== undefined ? { address } : {}), bytes };
}

/** Registers from gdb's "info registers": "r0  0x20001000  536875008". */
export function parseInfoRegisters(text: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][\w.]*)\s+(0x[0-9a-fA-F]+|-?\d+)\b/.exec(line);
    if (match) {
      out.push({ name: match[1], value: match[2] });
    }
  }
  return out;
}

/** Runs one gdb console command in a session and returns what gdb printed. */
export type GdbExec = (command: string) => Promise<{ body: unknown; output: string }>;

/**
 * Run a gdb console command through the adapter: cppdbg's "-exec" in the repl,
 * cortex-debug's execute-command. The text gdb prints arrives as output events
 * after the response, so the output recorded until it has been quiet a moment
 * is returned with the response body.
 */
export async function runConsoleCommand(
  tracked: TrackedDebugSession, command: string, options: { frameId?: number; quietMs?: number; maxWaitMs?: number } = {},
): Promise<{ body: unknown; output: string }> {
  const mark = tracked.outputCount;
  const body = tracked.type === 'cortex-debug'
    ? await tracked.session.customRequest('execute-command', { command })
    : await tracked.session.customRequest('evaluate', {
      expression: `-exec ${command}`, context: 'repl', ...(options.frameId !== undefined ? { frameId: options.frameId } : {}),
    });
  const lines = await outputAfter(tracked, mark, { quietMs: options.quietMs ?? 250, deadline: Date.now() + (options.maxWaitMs ?? 1500) });
  return { body, output: lines.map(line => line.text).join('') };
}

export interface MemoryRead {
  address: number;
  bytes: number[];
  via: 'readMemory' | 'read-memory' | 'gdb x';
  /** Bytes after these the adapter could not read. */
  unreadable?: number;
}

/**
 * Read target memory: DAP readMemory when the adapter advertises it, else
 * cortex-debug's read-memory, else gdb's x command. Each failure falls through
 * to the next way; the last error is thrown when none works.
 */
export async function readTargetMemory(
  session: DapSessionLike, capabilities: Record<string, unknown> | undefined, address: number, length: number, gdbExec?: GdbExec,
): Promise<MemoryRead> {
  const errors: string[] = [];
  if (capabilities?.supportsReadMemoryRequest === true) {
    try {
      const body = await session.customRequest('readMemory', { memoryReference: hexAddress(address), offset: 0, count: length });
      const start = typeof body?.address === 'string' ? parseAddress(body.address) ?? address : address;
      const bytes = typeof body?.data === 'string' ? [...Buffer.from(body.data, 'base64')] : [];
      return {
        address: start, bytes, via: 'readMemory',
        ...(typeof body?.unreadableBytes === 'number' && body.unreadableBytes > 0 ? { unreadable: body.unreadableBytes } : {}),
      };
    } catch (error) {
      errors.push(`readMemory: ${messageOf(error)}`);
    }
  }
  if (session.type === 'cortex-debug') {
    try {
      const body = await session.customRequest('read-memory', { address: hexAddress(address), length });
      const bytes: number[] = Array.isArray(body?.bytes) ? body.bytes.map((byte: unknown) => Number(byte) & 0xff) : [];
      const start = typeof body?.startAddress === 'string' ? parseAddress(body.startAddress) ?? address
        : typeof body?.startAddress === 'number' ? body.startAddress : address;
      return { address: start, bytes, via: 'read-memory' };
    } catch (error) {
      errors.push(`read-memory: ${messageOf(error)}`);
    }
  }
  if (gdbExec) {
    try {
      const { body, output } = await gdbExec(`x/${length}xb ${hexAddress(address)}`);
      const result = typeof (body as { result?: unknown })?.result === 'string' ? (body as { result: string }).result : '';
      const parsed = parseGdbHexBytes(`${output}\n${result}`);
      if (parsed.bytes.length > 0) {
        return { address: parsed.address ?? address, bytes: parsed.bytes.slice(0, length), via: 'gdb x' };
      }
      errors.push(`gdb x: no bytes in its output${output.trim() ? ` (${clip(output.trim(), 200)})` : ''}`);
    } catch (error) {
      errors.push(`gdb x: ${messageOf(error)}`);
    }
  }
  throw new Error(errors.length > 0 ? errors.join('; ') : 'This adapter offers no way to read memory.');
}

export interface RegistersRead {
  via: 'Registers scope' | 'read-registers' | 'info registers';
  registers: { name: string; value: string; group?: string }[];
}

/**
 * The core registers of a frame: the adapter's Registers scope when it has
 * one, else cortex-debug's read-register-list and read-registers, else gdb's
 * "info registers".
 */
export async function readRegisters(
  session: DapSessionLike, frameId: number | undefined, gdbExec?: GdbExec, maxRegisters = 200,
): Promise<RegistersRead> {
  const errors: string[] = [];
  if (frameId !== undefined) {
    try {
      const scope = (await scopesOf(session, frameId)).find(entry => REGISTERS_SCOPE.test(String(entry.name)));
      if (scope && scope.variablesReference > 0) {
        const budget: VariableBudget = { items: maxRegisters, valueChars: 100, perLevel: maxRegisters };
        const top = await expandVariables(session, scope.variablesReference, 1, budget);
        const registers: RegistersRead['registers'] = [];
        for (const entry of top) {
          // cppdbg groups its registers ("CPU", "FPU"): a group holds children.
          if (entry.children && entry.children.length > 0) {
            for (const child of entry.children) {
              if (child.name !== '...') {
                registers.push({ name: child.name, value: child.value, group: entry.name });
              }
            }
          } else if (entry.name !== '...') {
            registers.push({ name: entry.name, value: entry.value });
          }
        }
        if (registers.length > 0) {
          return { via: 'Registers scope', registers: registers.slice(0, maxRegisters) };
        }
      }
    } catch (error) {
      errors.push(`Registers scope: ${messageOf(error)}`);
    }
  }
  if (session.type === 'cortex-debug') {
    try {
      const names = await session.customRequest('read-register-list');
      const values = await session.customRequest('read-registers', { hex: true });
      const list: unknown[] = Array.isArray(names) ? names : [];
      const read: any[] = Array.isArray(values) ? values : [];
      const registers = read
        .map(entry => ({ name: String(list[Number(entry.number)] ?? `r${entry.number}`), value: String(entry.value) }))
        .filter(entry => entry.name.length > 0);
      if (registers.length > 0) {
        return { via: 'read-registers', registers: registers.slice(0, maxRegisters) };
      }
      errors.push('read-registers: no register came back');
    } catch (error) {
      errors.push(`read-registers: ${messageOf(error)}`);
    }
  }
  if (gdbExec) {
    try {
      const { body, output } = await gdbExec('info registers');
      const result = typeof (body as { result?: unknown })?.result === 'string' ? (body as { result: string }).result : '';
      const registers = parseInfoRegisters(`${output}\n${result}`);
      if (registers.length > 0) {
        return { via: 'info registers', registers: registers.slice(0, maxRegisters) };
      }
      errors.push('info registers: nothing could be read from its output');
    } catch (error) {
      errors.push(`info registers: ${messageOf(error)}`);
    }
  }
  throw new Error(errors.length > 0 ? errors.join('; ') : 'This adapter offers no way to read the registers.');
}
