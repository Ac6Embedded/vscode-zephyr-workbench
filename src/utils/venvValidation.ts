import path from 'path';
import { isSpdxOnlyVenvPath } from './execUtils';
import { fileExists } from './utils';

/**
 * Why `venvPath` cannot be used as a Python virtual environment, in the words
 * the Set Local Python Virtual Environment input shows, or undefined when it
 * can. The SPDX-only venv is refused first, then any folder without the
 * interpreter or an activation script under Scripts/ (Windows) or bin/.
 * `venvPath` must already be resolved (no ${workspaceFolder}-style variables).
 */
export function validateVenvDirectory(venvPath: string): string | undefined {
  if (isSpdxOnlyVenvPath(venvPath)) {
    return 'The SPDX-only venv is ignored for normal runtime operations. Choose a normal venv such as .venv.';
  }

  const normalizedPath = path.normalize(venvPath);
  const candidates = process.platform === 'win32'
    ? [
      path.join(normalizedPath, 'Scripts', 'python.exe'),
      path.join(normalizedPath, 'Scripts', 'Activate.ps1'),
      path.join(normalizedPath, 'Scripts', 'activate.bat'),
    ]
    : [
      path.join(normalizedPath, 'bin', 'python'),
      path.join(normalizedPath, 'bin', 'python3'),
      path.join(normalizedPath, 'bin', 'activate'),
    ];

  if (!candidates.some(candidate => fileExists(candidate))) {
    return 'Select the venv root folder containing Scripts/ or bin/.';
  }
  return undefined;
}

/** True when validateVenvDirectory finds nothing wrong with `venvPath`. */
export function isValidVenvDirectory(venvPath: string): boolean {
  return validateVenvDirectory(venvPath) === undefined;
}
