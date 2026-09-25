import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { McpToolError } from '../../../mcp/core/errors';
import { checkWestWorkspaceDeletion, folderSize, WestWorkspaceFenceInput } from '../../../mcp/core/westWorkspaceFence';

function tempDir(): string {
  // realpath: on macOS the temp folder is itself reached through a symbolic link.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-west-fence-')));
}

function workspace(parent: string, name = 'zephyrproject'): string {
  const root = path.join(parent, name);
  fs.mkdirSync(path.join(root, '.west'), { recursive: true });
  fs.writeFileSync(path.join(root, '.west', 'config'), '[manifest]\npath = manifest\n');
  return root;
}

function input(root: string, over: Partial<WestWorkspaceFenceInput> = {}): WestWorkspaceFenceInput {
  return { root, home: '/nonexistent-home-for-tests', otherWorkspaces: [], toolchains: [], foreignFolders: [], ...over };
}

function refusal(run: () => unknown): McpToolError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof McpToolError, String(error));
    return error;
  }
  throw new Error('expected a refusal');
}

describe('mcp/core/westWorkspaceFence', () => {
  it('accepts a west workspace that holds nothing else', () => {
    const root = workspace(tempDir());
    assert.equal(checkWestWorkspaceDeletion(input(root)).exists, true);
  });

  it('reports a workspace already gone without refusing', () => {
    const parent = tempDir();
    assert.equal(checkWestWorkspaceDeletion(input(path.join(parent, 'gone'))).exists, false);
  });

  it('refuses the home folder, a folder above it and a filesystem root', () => {
    const parent = tempDir();
    const root = workspace(parent);
    assert.equal(refusal(() => checkWestWorkspaceDeletion(input(root, { home: root }))).code, 'PATH_OUTSIDE_WORKSPACE');
    assert.equal(refusal(() => checkWestWorkspaceDeletion(input(root, { home: path.join(root, 'me') }))).code, 'PATH_OUTSIDE_WORKSPACE');
    assert.equal(refusal(() => checkWestWorkspaceDeletion(input('/', { platform: 'linux' }))).code, 'PATH_OUTSIDE_WORKSPACE');
    assert.equal(refusal(() => checkWestWorkspaceDeletion(input('C:\\', { platform: 'win32' }))).code, 'PATH_OUTSIDE_WORKSPACE');
  });

  it('refuses a folder without .west, a file and a symbolic link', () => {
    const parent = tempDir();
    const plain = path.join(parent, 'plain');
    fs.mkdirSync(plain);
    assert.equal(refusal(() => checkWestWorkspaceDeletion(input(plain))).code, 'INVALID_ARGUMENT');
    const file = path.join(parent, 'file');
    fs.writeFileSync(file, '');
    assert.equal(refusal(() => checkWestWorkspaceDeletion(input(file))).code, 'INVALID_ARGUMENT');
    const root = workspace(parent);
    const link = path.join(parent, 'link');
    fs.symlinkSync(root, link, 'dir');
    assert.equal(refusal(() => checkWestWorkspaceDeletion(input(link))).code, 'PATH_OUTSIDE_WORKSPACE');
  });

  it('refuses a workspace holding another workspace, a toolchain or a foreign folder', () => {
    const root = workspace(tempDir());
    const nested = workspace(root, 'nested');
    const sdk = path.join(root, 'zephyr-sdk-0.17.0');
    const app = path.join(root, 'my-app');
    fs.mkdirSync(sdk);
    fs.mkdirSync(app);
    const nestedError = refusal(() => checkWestWorkspaceDeletion(input(root, { otherWorkspaces: [nested, root] })));
    assert.equal(nestedError.details?.contains, nested);
    assert.equal(refusal(() => checkWestWorkspaceDeletion(input(root, { toolchains: [sdk] }))).details?.contains, sdk);
    assert.equal(refusal(() => checkWestWorkspaceDeletion(input(root, { foreignFolders: [app] }))).details?.contains, app);
    // Itself, and things elsewhere, never count.
    assert.equal(checkWestWorkspaceDeletion(input(root, { otherWorkspaces: [root, '/elsewhere'], foreignFolders: [root] })).exists, true);
  });

  it('measures a folder, and says when it stopped early', async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'one'), '12345');
    fs.writeFileSync(path.join(root, 'a', 'b', 'two'), '123');
    assert.deepEqual(await folderSize(root, { deadline: Date.now() + 10_000 }), { bytes: 8, files: 2, complete: true });
    assert.equal((await folderSize(root, { deadline: Date.now() - 1 })).complete, false);
    assert.equal((await folderSize(root, { deadline: Date.now() + 10_000, maxEntries: 1 })).complete, false);
  });
});
