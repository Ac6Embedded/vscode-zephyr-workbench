import * as vscode from 'vscode';

export const CORTEX_DEBUG_EXTENSION_ID = 'marus25.cortex-debug';
const CORTEX_DEBUG_MARKETPLACE_URL =
  'https://marketplace.visualstudio.com/items?itemName=marus25.cortex-debug';

export function isCortexDebugInstalled(): boolean {
  return !!vscode.extensions.getExtension(CORTEX_DEBUG_EXTENSION_ID);
}

/**
 * Make sure cortex-debug's debug adapter is registered before a session that
 * needs it starts. No-op when the extension is missing or already active.
 */
export async function activateCortexDebug(): Promise<void> {
  const extension = vscode.extensions.getExtension(CORTEX_DEBUG_EXTENSION_ID);
  if (extension && !extension.isActive) {
    try {
      await extension.activate();
    } catch {
      // cortex-debug activates on onDebugResolve anyway; failure here is not fatal.
    }
  }
}

export async function installCortexDebug(): Promise<boolean> {
  return installCortexDebugWithProgress();
}

async function installCortexDebugWithProgress(): Promise<boolean> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Installing Cortex-Debug extension...',
        cancellable: false,
      },
      async () => {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', CORTEX_DEBUG_EXTENSION_ID);
        // The extensions API can lag behind the install command; wait until
        // the extension is visible so callers can refresh their UI reliably.
        for (let attempt = 0; attempt < 10 && !isCortexDebugInstalled(); attempt++) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      },
    );
  } catch {
    void vscode.env.openExternal(vscode.Uri.parse(CORTEX_DEBUG_MARKETPLACE_URL));
  }
  return isCortexDebugInstalled();
}

/**
 * Check that cortex-debug is present, offering a one-click install when it is
 * not. Returns whether the caller can proceed. The extension is deliberately
 * NOT declared in `extensionDependencies` so users who never select a
 * Cortex-Debug backend install nothing extra.
 */
export async function ensureCortexDebugAvailable(reason: 'apply' | 'resolve'): Promise<boolean> {
  if (isCortexDebugInstalled()) {
    return true;
  }

  const message = reason === 'resolve'
    ? 'This debug session requires the Cortex-Debug extension (marus25.cortex-debug), which is not installed or is disabled.'
    : 'This debug backend requires the Cortex-Debug extension (marus25.cortex-debug), which is not installed or is disabled.';

  const choice = await vscode.window.showErrorMessage(message, 'Install Cortex-Debug', 'Open Marketplace');
  if (choice === 'Install Cortex-Debug') {
    return installCortexDebugWithProgress();
  }
  if (choice === 'Open Marketplace') {
    void vscode.env.openExternal(vscode.Uri.parse(CORTEX_DEBUG_MARKETPLACE_URL));
  }
  return false;
}
