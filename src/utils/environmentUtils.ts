import * as vscode from 'vscode';

/**
 * Why a graphical sudo prompt is unavailable, or undefined when one should work.
 * Returned by detectGuiSudoAvailability so callers can both branch and log the reason.
 */
export type NoGuiSudoReason = 'remote' | 'headless';

export interface GuiSudoAvailability {
  /** True when sudo-prompt's graphical askpass (pkexec) can plausibly work. */
  available: boolean;
  /** Set only when available is false; explains which signal triggered the fallback. */
  reason?: NoGuiSudoReason;
}

/**
 * Decide whether sudo-prompt's graphical password dialog can be attempted on this host,
 * or whether elevation should go straight to an interactive terminal sudo.
 *
 * The platform, remoteName, and env are injected (with sensible defaults) so this stays a
 * pure function that is deterministically unit-testable.
 *
 * Rules:
 *  - Non-Linux (darwin, win32): GUI is always available (macOS osascript dialog, Windows UAC),
 *    so existing behavior is preserved.
 *  - Linux inside any VS Code remote host (wsl, ssh-remote, dev-container, codespaces): no GUI.
 *  - Linux in WSL detected via env even when remoteName is empty: no GUI.
 *  - Linux with no X11 or Wayland display (headless): no GUI.
 *  - Linux, local, with a display: GUI available.
 */
export function detectGuiSudoAvailability(
  platform: NodeJS.Platform = process.platform,
  remoteName: string | undefined = vscode.env.remoteName,
  env: NodeJS.ProcessEnv = process.env,
): GuiSudoAvailability {
  if (platform !== 'linux') {
    return { available: true };
  }
  if (remoteName) {
    return { available: false, reason: 'remote' };
  }
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    return { available: false, reason: 'remote' };
  }
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return { available: false, reason: 'headless' };
  }
  return { available: true };
}
