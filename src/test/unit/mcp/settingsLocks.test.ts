import { strict as assert } from 'assert';
import * as vscode from 'vscode';
import { ZephyrApplication } from '../../../models/ZephyrApplication';
import { HostServices } from '../../../mcp/host/services';

describe('mcp/host/services settings locks', () => {
  it('shares one lock between an application and its folder, and keeps the toolchain lists apart', async () => {
    const services = new HostServices(vscode.Uri.file('/ext'));
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });

    const folder = services.withFolderSettingsLock('/ws/app/', async () => {
      order.push('folder');
      await held;
      order.push('folder done');
    });
    const app = { appWorkspaceFolder: { uri: vscode.Uri.file('/ws/app') } } as unknown as ZephyrApplication;
    const application = services.withSettingsLock(app, async () => { order.push('application'); });
    await services.withToolchainSettingsLock(async () => { order.push('toolchains'); });
    assert.deepEqual(order, ['folder', 'toolchains'], 'the toolchain lists do not wait for a folder');

    release();
    await Promise.all([folder, application]);
    assert.deepEqual(order, ['folder', 'toolchains', 'folder done', 'application']);
  });
});
