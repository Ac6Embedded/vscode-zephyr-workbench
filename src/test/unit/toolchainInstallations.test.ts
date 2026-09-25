import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as vscode from 'vscode';

import { ZephyrSdkInstallation } from '../../models/ToolchainInstallations';

describe('ZephyrSdkInstallation', () => {
  let sdkRoot: string;

  before(() => {
    sdkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-sdk-'));
    fs.writeFileSync(path.join(sdkRoot, 'sdk_version'), '1.0.1');
    fs.writeFileSync(path.join(sdkRoot, 'sdk_gnu_toolchains'), 'arm-zephyr-eabi\n');
    fs.mkdirSync(path.join(sdkRoot, 'gnu'));
  });

  after(() => {
    fs.rmSync(sdkRoot, { recursive: true, force: true });
  });

  describe('getDebuggerPath', () => {
    it('returns the gdb path for a known arch', () => {
      const sdk = new ZephyrSdkInstallation(vscode.Uri.file(sdkRoot));
      const ext = process.platform === 'win32' ? '.exe' : '';
      assert.equal(
        sdk.getDebuggerPath('arm'),
        path.join('${config:zephyr-workbench.sdk}', 'gnu', 'arm-zephyr-eabi', 'bin', `arm-zephyr-eabi-gdb${ext}`),
      );
    });

    it('returns an empty path instead of throwing when the arch is missing', () => {
      // Out-of-tree boards defined only by board.yml have no twister yaml, so
      // ZephyrBoard.arch stays undefined.
      const sdk = new ZephyrSdkInstallation(vscode.Uri.file(sdkRoot));
      assert.equal(sdk.getDebuggerPath(undefined as unknown as string), '');
      assert.equal(sdk.getDebuggerPath(''), '');
    });
  });
});
