import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  GlobalSdkSource,
  mergeAndSortCandidates,
  parseRegQueryOutput,
  registryEntryTargetKeys,
  resolveSdkRootFromRegistryEntry,
} from '../../utils/zephyr/globalSdkUtils';

describe('globalSdkUtils', () => {
  describe('parseRegQueryOutput', () => {
    it('parses typical reg.exe output, including a data path with spaces', () => {
      const stdout = [
        '',
        'HKEY_CURRENT_USER\\Software\\Kitware\\CMake\\Packages\\Zephyr-sdk',
        '    e0d862112c4b81b0    REG_SZ    C:\\zephyr-sdk-0.17.4\\cmake',
        '    9f31a2ce77d40aa1    REG_SZ    C:\\Program Files\\Zephyr SDK\\zephyr-sdk-1.0.1\\cmake',
        '',
      ].join('\r\n');

      assert.deepEqual(parseRegQueryOutput(stdout), [
        { key: 'e0d862112c4b81b0', configDir: 'C:\\zephyr-sdk-0.17.4\\cmake' },
        {
          key: '9f31a2ce77d40aa1',
          configDir: 'C:\\Program Files\\Zephyr SDK\\zephyr-sdk-1.0.1\\cmake',
        },
      ]);
    });

    it('returns nothing for empty input', () => {
      assert.deepEqual(parseRegQueryOutput(''), []);
    });

    it('returns nothing for garbage input', () => {
      const stdout = [
        'ERROR: The system was unable to find the specified registry key or value.',
        'not a value line at all',
        'REG_SZ',
      ].join('\r\n');
      assert.deepEqual(parseRegQueryOutput(stdout), []);
    });
  });

  describe('resolveSdkRootFromRegistryEntry', () => {
    let fixtureDir: string;
    let sdkRoot: string;
    let sdkCmakeDir: string;
    let notSdkCmakeDir: string;

    before(() => {
      fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'globalSdkUtils-'));
      sdkRoot = path.join(fixtureDir, 'zephyr-sdk-0.17.4');
      sdkCmakeDir = path.join(sdkRoot, 'cmake');
      fs.mkdirSync(sdkCmakeDir, { recursive: true });
      fs.writeFileSync(path.join(sdkRoot, 'sdk_version'), '0.17.4\n');

      notSdkCmakeDir = path.join(fixtureDir, 'plain-dir', 'cmake');
      fs.mkdirSync(notSdkCmakeDir, { recursive: true });
    });

    after(() => {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    it('resolves a <sdk>/cmake entry to the SDK root', () => {
      assert.equal(resolveSdkRootFromRegistryEntry(sdkCmakeDir), sdkRoot);
    });

    it('tolerates trailing whitespace and newline in the entry content', () => {
      assert.equal(resolveSdkRootFromRegistryEntry(`${sdkCmakeDir}  \n`), sdkRoot);
    });

    it('accepts an entry pointing directly at the SDK root', () => {
      assert.equal(resolveSdkRootFromRegistryEntry(sdkRoot), sdkRoot);
    });

    it('skips an entry whose parent has no sdk_version', () => {
      assert.equal(resolveSdkRootFromRegistryEntry(notSdkCmakeDir), undefined);
    });

    it('skips empty content', () => {
      assert.equal(resolveSdkRootFromRegistryEntry('  \n'), undefined);
    });
  });

  describe('registryEntryTargetKeys', () => {
    const fold = (p: string) =>
      process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;

    it('yields the registered dir and its parent (the SDK root)', () => {
      const configDir = path.join(os.tmpdir(), 'no-such-sdk-root', 'cmake');
      const keys = registryEntryTargetKeys(`${configDir}\n`);
      assert.ok(keys.includes(fold(path.normalize(configDir))));
      assert.ok(keys.includes(fold(path.normalize(path.dirname(configDir)))));
    });

    it('matches even when the registered dir no longer exists', () => {
      const deletedSdkRoot = path.join(os.tmpdir(), 'deleted-zephyr-sdk-0.17.4');
      const keys = registryEntryTargetKeys(path.join(deletedSdkRoot, 'cmake'));
      assert.ok(keys.includes(fold(path.normalize(deletedSdkRoot))));
    });

    it('returns nothing for empty content', () => {
      assert.deepEqual(registryEntryTargetKeys('  \n'), []);
    });
  });

  describe('mergeAndSortCandidates', () => {
    it('sorts by version descending', () => {
      const result = mergeAndSortCandidates([
        { path: '/opt/zephyr-sdk-0.16.8', version: '0.16.8', source: 'default-location' },
        { path: '/opt/zephyr-sdk-1.0.1', version: '1.0.1', source: 'default-location' },
        { path: '/opt/zephyr-sdk-0.17.4', version: '0.17.4', source: 'default-location' },
      ]);
      assert.deepEqual(
        result.map(sdk => sdk.version),
        ['1.0.1', '0.17.4', '0.16.8'],
      );
    });

    it('tie-breaks equal versions by path ascending', () => {
      const result = mergeAndSortCandidates([
        { path: '/opt/zephyr-sdk-b', version: '0.17.4', source: 'default-location' },
        { path: '/opt/zephyr-sdk-a', version: '0.17.4', source: 'env' },
      ]);
      assert.deepEqual(
        result.map(sdk => sdk.path),
        ['/opt/zephyr-sdk-a', '/opt/zephyr-sdk-b'],
      );
    });

    it('dedups the same path across channels and merges sources in canonical order', () => {
      const result = mergeAndSortCandidates([
        { path: '/opt/zephyr-sdk-0.17.4', version: '0.17.4', source: 'env' },
        { path: '/opt/zephyr-sdk-0.17.4', version: '0.17.4', source: 'cmake-registry' },
      ]);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0].sources, ['cmake-registry', 'env'] as GlobalSdkSource[]);
    });

    it('keeps a repeated source only once', () => {
      const result = mergeAndSortCandidates([
        { path: '/opt/zephyr-sdk-0.17.4', version: '0.17.4', source: 'default-location' },
        { path: '/opt/zephyr-sdk-0.17.4', version: '0.17.4', source: 'default-location' },
      ]);
      assert.equal(result.length, 1);
      assert.deepEqual(result[0].sources, ['default-location']);
    });

    it('orders all three sources canonically regardless of arrival order', () => {
      const result = mergeAndSortCandidates([
        { path: '/opt/zephyr-sdk-0.17.4', version: '0.17.4', source: 'env' },
        { path: '/opt/zephyr-sdk-0.17.4', version: '0.17.4', source: 'default-location' },
        { path: '/opt/zephyr-sdk-0.17.4', version: '0.17.4', source: 'cmake-registry' },
      ]);
      assert.deepEqual(result[0].sources, ['cmake-registry', 'default-location', 'env']);
    });

    it('returns nothing for no candidates', () => {
      assert.deepEqual(mergeAndSortCandidates([]), []);
    });
  });
});
