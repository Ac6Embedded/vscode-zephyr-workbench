/**
 * Pure shell-quoting helpers, deliberately dependency-free so they can be
 * imported from both execUtils (vscode-dependent) and westArgUtils
 * (vscode-free) without creating an import cycle.
 */

/** POSIX-family shell kinds as returned by classifyShell(). */
export function isPosixShellKind(shellKind: string): boolean {
  return shellKind === 'bash' || shellKind === 'zsh'
    || shellKind === 'dash' || shellKind === 'fish';
}

/**
 * Wrap a value in double quotes when it contains whitespace.
 * Idempotent: values already wrapped in double quotes are returned unchanged.
 * Double quotes are valid in bash, cmd.exe and PowerShell command strings.
 */
export function quoteIfNeeded(value: string): string {
  if (!/\s/.test(value)) {
    return value;
  }
  if (/^".*"$/.test(value)) {
    return value;
  }
  return `"${value}"`;
}

/**
 * `value` as one literal word for a command line the given shell kind runs, or
 * undefined when that shell could still expand or split it however it is
 * quoted. Only printable ASCII is accepted, so no control character or
 * typographic quote (PowerShell reads those as quotes) reaches the shell.
 * bash/zsh/dash and PowerShell get single quotes, where nothing but the quote
 * itself is special. fish also reads backslashes inside single quotes, so a
 * value with one is refused there. cmd.exe gets double quotes and refuses what
 * it still expands inside them (% and !), a double quote, and a trailing
 * backslash, which the program would read as escaping the closing quote.
 */
export function quoteLiteralForShell(shellKind: string, value: string): string | undefined {
  if (!/^[\x20-\x7e]*$/.test(value)) {
    return undefined;
  }
  if (isPosixShellKind(shellKind)) {
    if (shellKind === 'fish' && value.includes('\\')) {
      return undefined;
    }
    return `'${value.replace(/'/g, "'\\''")}'`;
  }
  if (shellKind === 'powershell.exe' || shellKind === 'pwsh.exe') {
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (shellKind === 'cmd.exe') {
    return /["%!]/.test(value) || value.endsWith('\\') ? undefined : `"${value}"`;
  }
  return undefined;
}
