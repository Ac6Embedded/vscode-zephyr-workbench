import assert from 'assert';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
// Loads with the vscode stub (NODE_PATH=src/test/unit/stubs); the real bundled
// west_manifests/templates.yml is read through the repo-root extensionUri below.
import { generateWestManifest } from '../../utils/zephyr/manifestUtils';
import { resolveBaseModules, validateTemplateConfig } from '../../utils/zephyr/templateData';

describe('generateWestManifest', () => {
  const repoRoot = path.join(__dirname, '..', '..', '..');
  // The stub's Uri only carries fsPath; good enough for the loader.
  const extensionUri = { fsPath: repoRoot } as any;
  const shippedConfig = validateTemplateConfig(
    yaml.parse(fs.readFileSync(path.join(repoRoot, 'west_manifests', 'templates.yml'), 'utf8')),
  );
  // Expected allowlist prefix for a revision, straight from the shipped data:
  // the tests stay valid when modules are added to templates.yml.
  const baseFor = (revision: string) => resolveBaseModules(shippedConfig.baseModules, revision);
  const tmpRoot = path.join(__dirname, 'tmp-workspace-generate');
  const remotePath = 'https://github.com/zephyrproject-rtos';

  afterEach(() => {
    if (fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  interface GenerateOptions {
    branch?: string;
    modules?: string[];
    isFull?: boolean;
    manifestDir?: string;
    projects?: string[];
    enableRust?: boolean;
  }

  function generate(name: string, options: GenerateOptions = {}) {
    const {
      branch = 'v4.3.0',
      modules = ['hal_stm32'],
      isFull = false,
      manifestDir = undefined,
      projects = undefined,
      enableRust = false,
    } = options;
    const workspacePath = path.join(tmpRoot, name);
    fs.mkdirSync(workspacePath, { recursive: true });
    const manifestFile = generateWestManifest(
      extensionUri, remotePath, branch, workspacePath, modules, isFull,
      manifestDir, undefined, projects, enableRust,
    );
    return yaml.parse(fs.readFileSync(manifestFile, 'utf8'));
  }

  function allowlistOf(parsed: any): string[] | undefined {
    return parsed.manifest.projects[0].import['name-allowlist'];
  }

  it('generates the minimal manifest with cmsis for Zephyr < 4.1', () => {
    const parsed = generate('minimal-old', { branch: 'v3.7.0' });
    const zephyrProject = parsed.manifest.projects[0];
    assert.strictEqual(zephyrProject.revision, 'v3.7.0');
    assert.strictEqual(parsed.manifest.remotes[0]['url-base'], remotePath);
    assert.strictEqual(zephyrProject.import['path-prefix'], 'deps');
    assert.deepStrictEqual(parsed.manifest.self, { path: 'manifest' });
    const allowlist = allowlistOf(parsed) ?? [];
    assert.deepStrictEqual(allowlist, [...baseFor('v3.7.0'), 'hal_stm32']);
    assert.ok(allowlist.includes('cmsis') && !allowlist.includes('cmsis_6'));
  });

  it('declares self.path as the chosen west.yml subfolder', () => {
    const parsed = generate('minimal-subfolder', { manifestDir: 'mymanifest' });
    assert.deepStrictEqual(parsed.manifest.self, { path: 'mymanifest' });
  });

  it('generates the minimal manifest with cmsis_6 for Zephyr >= 4.1', () => {
    const parsed = generate('minimal-new', { branch: 'v4.3.0' });
    const allowlist = allowlistOf(parsed) ?? [];
    assert.deepStrictEqual(allowlist, [...baseFor('v4.3.0'), 'hal_stm32']);
    assert.ok(allowlist.includes('cmsis_6') && !allowlist.includes('cmsis'));
  });

  it('treats branches as the latest Zephyr', () => {
    const parsed = generate('minimal-main', { branch: 'main' });
    const allowlist = allowlistOf(parsed) ?? [];
    assert.ok(allowlist.includes('cmsis_6'));
    assert.ok(!allowlist.includes('cmsis'));
  });

  it('includes every module of a multi-module template', () => {
    const parsed = generate('minimal-espressif', { modules: ['hal_espressif', 'hal_xtensa'] });
    assert.deepStrictEqual(
      allowlistOf(parsed),
      [...baseFor('v4.3.0'), 'hal_espressif', 'hal_xtensa'],
    );
  });

  it('uses the caller-provided projects list verbatim', () => {
    const parsed = generate('minimal-custom', { projects: ['picolibc', 'hal_nordic'] });
    assert.deepStrictEqual(allowlistOf(parsed), ['picolibc', 'hal_nordic']);
  });

  it('appends zephyr-lang-rust when Rust is enabled', () => {
    const parsed = generate('minimal-rust', { enableRust: true });
    const allowlist = allowlistOf(parsed) ?? [];
    assert.strictEqual(allowlist[allowlist.length - 1], 'zephyr-lang-rust');
  });

  it('generates the full manifest without an allowlist', () => {
    const parsed = generate('full', { isFull: true });
    const zephyrProject = parsed.manifest.projects[0];
    assert.strictEqual(zephyrProject.revision, 'v4.3.0');
    assert.deepStrictEqual(zephyrProject.import, { 'path-prefix': 'deps' });
    assert.deepStrictEqual(parsed.manifest.self, { path: 'manifest' });
  });

  it('does not leak mutations between generations (cached config is cloned)', () => {
    const first = generate('leak-first', { branch: 'v3.7.0', modules: ['hal_silabs'] });
    const second = generate('leak-second', { branch: 'v4.3.0' });
    assert.deepStrictEqual(allowlistOf(first), [...baseFor('v3.7.0'), 'hal_silabs']);
    assert.deepStrictEqual(allowlistOf(second), [...baseFor('v4.3.0'), 'hal_stm32']);
  });

  it('strips a trailing /zephyr from the remote path for url-base', () => {
    const workspacePath = path.join(tmpRoot, 'url-base');
    fs.mkdirSync(workspacePath, { recursive: true });
    const manifestFile = generateWestManifest(
      extensionUri, 'https://github.com/zephyrproject-rtos/zephyr', 'v4.3.0', workspacePath, ['hal_stm32'], false,
    );
    const parsed = yaml.parse(fs.readFileSync(manifestFile, 'utf8'));
    assert.strictEqual(parsed.manifest.remotes[0]['url-base'], 'https://github.com/zephyrproject-rtos');
  });
});
