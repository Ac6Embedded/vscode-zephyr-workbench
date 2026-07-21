import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { parseDomainsYamlText, readDomainsForBuildDir } from '../../utils/zephyr/domainsYamlUtils';

const SAMPLE = (topBuildDir: string) => `default: hello_world_sysbuild
build_dir: ${topBuildDir}
domains:
  - name: hello_world_sysbuild
    build_dir: ${path.join(topBuildDir, 'hello_world_sysbuild')}
  - name: mcuboot
    build_dir: ${path.join(topBuildDir, 'mcuboot')}
flash_order:
  - mcuboot
  - hello_world_sysbuild
`;

describe('domainsYamlUtils', () => {
  describe('parseDomainsYamlText', () => {
    it('parses the sample shape and preserves order', () => {
      const top = '/abs/build/primary';
      const parsed = parseDomainsYamlText(SAMPLE(top), 'domains.yaml', top);
      assert.ok(parsed);
      assert.equal(parsed!.defaultDomain, 'hello_world_sysbuild');
      assert.equal(parsed!.topBuildDir, top);
      assert.deepEqual(parsed!.domains.map(d => d.name), ['hello_world_sysbuild', 'mcuboot']);
      assert.equal(parsed!.domains[1].buildDir, path.join(top, 'mcuboot'));
      assert.deepEqual(parsed!.flashOrder, ['mcuboot', 'hello_world_sysbuild']);
    });

    it('does not rebase when the recorded top dir matches the actual dir', () => {
      const top = '/abs/build/primary';
      const parsed = parseDomainsYamlText(SAMPLE(top), 'domains.yaml', top);
      assert.equal(parsed!.domains[0].buildDir, path.join(top, 'hello_world_sysbuild'));
    });

    it('rebases domain dirs when artifacts were moved', () => {
      const recordedTop = '/old/build/primary';
      const actualTop = '/new/place/primary';
      const parsed = parseDomainsYamlText(SAMPLE(recordedTop), 'domains.yaml', actualTop);
      assert.ok(parsed);
      assert.equal(parsed!.topBuildDir, actualTop);
      assert.equal(parsed!.domains[0].buildDir, path.join(actualTop, 'hello_world_sysbuild'));
      assert.equal(parsed!.domains[1].buildDir, path.join(actualTop, 'mcuboot'));
    });

    it('returns undefined for a missing default', () => {
      const text = 'build_dir: /x\ndomains:\n  - name: a\n    build_dir: /x/a\n';
      assert.equal(parseDomainsYamlText(text), undefined);
    });

    it('returns undefined when domains is empty', () => {
      const text = 'default: a\nbuild_dir: /x\ndomains: []\n';
      assert.equal(parseDomainsYamlText(text), undefined);
    });

    it('returns undefined when the default is not among the domains', () => {
      const text = 'default: ghost\nbuild_dir: /x\ndomains:\n  - name: a\n    build_dir: /x/a\n';
      assert.equal(parseDomainsYamlText(text), undefined);
    });

    it('returns undefined for malformed YAML', () => {
      assert.equal(parseDomainsYamlText('default: [unclosed'), undefined);
    });

    it('defaults flash_order to an empty array when absent', () => {
      const top = '/x';
      const text = `default: a\nbuild_dir: ${top}\ndomains:\n  - name: a\n    build_dir: ${top}/a\n`;
      const parsed = parseDomainsYamlText(text, 'domains.yaml', top);
      assert.deepEqual(parsed!.flashOrder, []);
    });
  });

  describe('readDomainsForBuildDir', () => {
    let tmpDir: string;
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zwb-domains-'));
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns undefined when no domains.yaml exists', () => {
      assert.equal(readDomainsForBuildDir(tmpDir), undefined);
    });

    it('reads and rebases from the file location', () => {
      fs.writeFileSync(path.join(tmpDir, 'domains.yaml'), SAMPLE('/recorded/elsewhere'), 'utf8');
      const parsed = readDomainsForBuildDir(tmpDir);
      assert.ok(parsed);
      assert.equal(parsed!.topBuildDir, tmpDir);
      assert.equal(parsed!.domains[0].buildDir, path.join(tmpDir, 'hello_world_sysbuild'));
    });
  });
});
