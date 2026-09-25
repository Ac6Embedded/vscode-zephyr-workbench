// The West Manager's manifest editing, moved out of the panel so the MCP tool
// shares it. Run against real files in a temporary workspace.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import yaml from 'yaml';
import {
  applyWorkspaceState, diffLines, getWorkspaceDetails, isRustEnabledInWestConfig, ManifestWorkspace, renderWorkspaceState,
  setRustEnabledInWestConfig, UNSUPPORTED_MANIFEST_TOPOLOGY_MESSAGE, WestManagerApplyState,
} from '../../utils/zephyr/westManifestEdit';

const MINIMAL = `# Workspace manifest
manifest:
  remotes:
    - name: zephyrproject
      url-base: https://github.com/zephyrproject-rtos
  projects:
    - name: zephyr
      repo-path: zephyr
      remote: zephyrproject
      revision: v4.2.0
      import:
        path-prefix: deps
        name-allowlist:
          - cmsis_6 # keep this comment
          - hal_stm32
  self:
    path: manifest
`;

const ZEPHYR_WEST = `manifest:
  projects:
    - name: cmsis_6
    - name: hal_stm32
    - name: hal_nordic
    - name: mbedtls
`;

const OPTIONAL = `manifest:
  projects:
    - name: zephyr-lang-rust
      groups: [optional]
`;

function workspace(manifest: string, westConfig = '[manifest]\npath = manifest\nfile = west.yml\n\n[zephyr]\nbase = deps/zephyr\n'): ManifestWorkspace {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zw-manifest-edit-')));
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write(path.join(root, 'manifest', 'west.yml'), manifest);
  write(path.join(root, '.west', 'config'), westConfig);
  write(path.join(root, 'deps', 'zephyr', 'west.yml'), ZEPHYR_WEST);
  write(path.join(root, 'deps', 'zephyr', 'submanifests', 'optional.yaml'), OPTIONAL);
  return {
    name: 'ws', rootPath: root, version: '4.2.0',
    manifestPath: path.join(root, 'manifest', 'west.yml'),
    westConfPath: path.join(root, '.west', 'config'),
    kernelPath: path.join(root, 'deps', 'zephyr'),
    zephyrBase: 'deps/zephyr',
  };
}

function state(ws: ManifestWorkspace, over: Partial<WestManagerApplyState>): WestManagerApplyState {
  const details = getWorkspaceDetails(ws);
  return {
    rootPath: ws.rootPath, zephyrRevision: '', importAll: details.importAll,
    selectedProjects: details.selectedProjects, rustEnabled: details.rustEnabled, ...over,
  };
}

const allowlistOf = (ws: ManifestWorkspace) =>
  yaml.parse(fs.readFileSync(ws.manifestPath, 'utf8')).manifest.projects[0].import['name-allowlist'];

describe('utils/zephyr/westManifestEdit', () => {
  it('reads the details the West Manager shows', () => {
    const ws = workspace(MINIMAL);
    const details = getWorkspaceDetails(ws);
    assert.equal(details.zephyrRevision, 'v4.2.0');
    assert.equal(details.zephyrRepoUrl, 'https://github.com/zephyrproject-rtos/zephyr');
    assert.equal(details.supported, true);
    assert.equal(details.importAll, false);
    assert.deepEqual(details.selectedProjects, ['cmsis_6', 'hal_stm32']);
    assert.deepEqual(details.availableProjects, ['cmsis_6', 'hal_stm32', 'hal_nordic', 'mbedtls', 'zephyr-lang-rust']);
    assert.equal(details.rustEnabled, false);
  });

  it('edits the allowlist and revision in place, keeping comments', () => {
    const ws = workspace(MINIMAL);
    applyWorkspaceState(ws, state(ws, { zephyrRevision: 'v4.3.0', selectedProjects: ['cmsis_6', 'hal_nordic'] }));
    const text = fs.readFileSync(ws.manifestPath, 'utf8');
    assert.match(text, /# Workspace manifest/);
    assert.match(text, /cmsis_6 # keep this comment/);
    assert.match(text, /revision: v4\.3\.0/);
    assert.deepEqual(allowlistOf(ws), ['cmsis_6', 'hal_nordic']);
  });

  it('collapses the import back to true for a full workspace, and back to an allowlist', () => {
    const ws = workspace(MINIMAL.replace('        path-prefix: deps\n', ''));
    applyWorkspaceState(ws, state(ws, { importAll: true }));
    assert.equal(yaml.parse(fs.readFileSync(ws.manifestPath, 'utf8')).manifest.projects[0].import, true);
    applyWorkspaceState(ws, state(ws, { importAll: false, selectedProjects: ['mbedtls'] }));
    assert.deepEqual(allowlistOf(ws), ['mbedtls']);
  });

  it('keeps the Rust module in the allowlist and turns on its project filter', () => {
    const ws = workspace(MINIMAL);
    const details = applyWorkspaceState(ws, state(ws, { rustEnabled: true }));
    assert.ok(allowlistOf(ws).includes('zephyr-lang-rust'));
    assert.equal(details.rustEnabled, true);
    assert.match(fs.readFileSync(ws.westConfPath, 'utf8'), /project-filter = \+zephyr-lang-rust/);
    setRustEnabledInWestConfig(ws.westConfPath, false);
    assert.equal(isRustEnabledInWestConfig(ws.westConfPath), false);
    assert.doesNotMatch(fs.readFileSync(ws.westConfPath, 'utf8'), /project-filter/);
  });

  it('refuses a manifest topology it does not manage, and writes nothing', () => {
    const ws = workspace('manifest:\n  projects:\n    - name: zephyr\n      import: submanifests/\n');
    const before = fs.readFileSync(ws.manifestPath, 'utf8');
    assert.equal(getWorkspaceDetails(ws).supported, false);
    assert.throws(() => applyWorkspaceState(ws, state(ws, { importAll: true })), { message: UNSUPPORTED_MANIFEST_TOPOLOGY_MESSAGE });
    assert.equal(fs.readFileSync(ws.manifestPath, 'utf8'), before);
  });

  it('cannot turn Rust on in a .west/config without a [manifest] section', () => {
    const ws = workspace(MINIMAL, '[zephyr]\nbase = deps/zephyr\n');
    assert.throws(() => setRustEnabledInWestConfig(ws.westConfPath, true), /no \[manifest\] section/);
  });

  it('renders without writing, and diffs the result', () => {
    const ws = workspace(MINIMAL);
    const rendered = renderWorkspaceState(ws, state(ws, { selectedProjects: ['cmsis_6'] }));
    assert.equal(fs.readFileSync(ws.manifestPath, 'utf8'), MINIMAL, 'a render writes nothing');
    const diff = diffLines(MINIMAL, rendered);
    assert.match(diff, /^- {11}- hal_stm32$/m);
    assert.doesNotMatch(diff, /^\+/m);
    assert.equal(diffLines(MINIMAL, MINIMAL), '');
  });
});
