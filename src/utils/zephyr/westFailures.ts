// What the stderr of a failed west run says about why it failed. Kept free of
// any `vscode` import so the listing runner in WestCommands and the agent
// tools read a failure the same way, and both are unit tested directly.

/** True when west does not know the command at all, as with `west shields` before Zephyr 3.7. */
export function isUnknownWestCommand(stderr: string): boolean {
  return /unknown command|invalid choice/i.test(stderr);
}

/**
 * True when west itself could not start, because the shell found no west on
 * PATH or the Python environment lacks the west package. Every shell words
 * this differently:
 *   bash, sh    "bash: line 1: west: command not found"
 *   dash        "sh: 1: west: not found"
 *   zsh         "zsh:1: command not found: west" (the macOS default)
 *   fish        "fish: Unknown command: west"
 *   cmd.exe     "'west' is not recognized as an internal or external command"
 *   PowerShell  "The term 'west' is not recognized as a name of a cmdlet"
 * Check it before isUnknownWestCommand, whose pattern the fish text also fits.
 */
export function isWestMissing(stderr: string): boolean {
  return /west: (?:command )?not found|command not found: west|unknown command: west\b|'west' is not recognized|No module named ['"]?west/i
    .test(stderr);
}
