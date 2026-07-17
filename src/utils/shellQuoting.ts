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
