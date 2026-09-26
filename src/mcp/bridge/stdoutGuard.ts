// Imported first by the bridge entry point, for its side effect.
//
// On a stdio transport, stdout IS the JSON-RPC channel: one stray console.log
// anywhere in the process corrupts the stream and the agent reports a broken
// server with no useful error. Redirecting the console before anything else
// loads makes that failure impossible rather than unlikely.

const stderrWrite = (parts: unknown[]) => {
  try {
    process.stderr.write(`${parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`);
  } catch {
    // Never throw from a logger.
  }
};

console.log = (...parts: unknown[]) => stderrWrite(parts);
console.info = (...parts: unknown[]) => stderrWrite(parts);
console.warn = (...parts: unknown[]) => stderrWrite(parts);
console.debug = (...parts: unknown[]) => stderrWrite(parts);
// console.error already goes to stderr.

export const STDOUT_GUARDED = true;
