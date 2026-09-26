import { strict as assert } from 'assert';
import { McpToolError } from '../../../mcp/core/errors';
import {
  assertFolderName, assertGitRevision, assertGitUrl, assertManifestFileName, assertNoWhitespacePath, assertWestProjectName,
} from '../../../mcp/core/gitArgs';

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    assert.ok(error instanceof McpToolError, String(error));
    return error.code;
  }
}

describe('mcp/core/gitArgs', () => {
  describe('assertGitUrl', () => {
    it('accepts https and git@ repository URLs', () => {
      for (const url of [
        'https://github.com/zephyrproject-rtos/zephyr',
        'https://github.com/zephyrproject-rtos/zephyr.git',
        'https://git.example.com:8443/group/sub_group/repo~1',
        'git@github.com:zephyrproject-rtos/zephyr.git',
        'git@gitlab.example.org:team/manifest',
      ]) {
        assert.equal(assertGitUrl(url), url);
      }
    });

    it('refuses shell characters, spaces, credentials and other schemes', () => {
      for (const url of [
        'https://github.com/x/y;rm -rf ~',
        'https://github.com/x/$(id)',
        'https://github.com/x/`id`',
        'https://github.com/x/y z',
        'https://user:secret@github.com/x/y',
        'https://github.com/x/y?ref=main',
        'http://github.com/x/y',
        'file:///etc/passwd',
        'ssh://git@github.com/x/y',
        '--upload-pack=touch /tmp/x',
        '-https://github.com/x',
        'git@github.com:-oProxyCommand=x',
        'https://github.com/../etc',
        'https://github.com',
        '',
      ]) {
        assert.equal(codeOf(() => assertGitUrl(url)), 'INVALID_ARGUMENT', url);
      }
    });

    it('refuses an overlong URL', () => {
      assert.equal(codeOf(() => assertGitUrl(`https://github.com/${'a'.repeat(600)}`)), 'INVALID_ARGUMENT');
    });
  });

  describe('assertGitRevision', () => {
    it('accepts tags, branches and commits', () => {
      for (const rev of ['v4.2.0', 'main', 'collab-sdk-dev', 'release/v3.7', 'v4.1.0-rc1', 'a1b2c3d4e5f6', 'v1.0+abc']) {
        assert.equal(assertGitRevision(rev), rev);
      }
    });

    it('refuses a leading dash, shell characters, spaces and ref forms git rejects', () => {
      for (const rev of ['-main', '--upload-pack=x', 'main;id', 'v$(id)', 'a b', 'a..b', 'main/', 'x.lock', '', 'x'.repeat(129), '`id`']) {
        assert.equal(codeOf(() => assertGitRevision(rev)), 'INVALID_ARGUMENT', rev);
      }
    });
  });

  describe('assertManifestFileName', () => {
    it('accepts a .yml or .yaml basename', () => {
      assert.equal(assertManifestFileName('west.yml'), 'west.yml');
      assert.equal(assertManifestFileName('ncs-west.yaml'), 'ncs-west.yaml');
    });

    it('refuses folders, other extensions and a leading dash', () => {
      for (const name of ['sub/west.yml', '../west.yml', 'west.json', '-west.yml', 'west.yml;id', 'west yml.yml']) {
        assert.equal(codeOf(() => assertManifestFileName(name)), 'INVALID_ARGUMENT', name);
      }
    });
  });

  it('checks west project names and folder names', () => {
    assert.equal(assertWestProjectName('hal_stm32', 'projects'), 'hal_stm32');
    assert.equal(assertWestProjectName('zephyr-lang-rust', 'projects'), 'zephyr-lang-rust');
    assert.equal(codeOf(() => assertWestProjectName('-x', 'projects')), 'INVALID_ARGUMENT');
    assert.equal(codeOf(() => assertWestProjectName('a b', 'projects')), 'INVALID_ARGUMENT');
    assert.equal(assertFolderName('zephyrproject', 'folder_name'), 'zephyrproject');
    for (const name of ['a/b', '..', '.', 'a b', '-x', '']) {
      assert.equal(codeOf(() => assertFolderName(name, 'folder_name')), 'INVALID_ARGUMENT', name);
    }
  });

  it('refuses relative paths and paths with spaces', () => {
    assert.equal(assertNoWhitespacePath('/home/me/work', 'destination', 'linux'), '/home/me/work');
    assert.equal(assertNoWhitespacePath('C:\\work', 'destination', 'win32'), 'C:\\work');
    assert.equal(codeOf(() => assertNoWhitespacePath('work', 'destination', 'linux')), 'INVALID_ARGUMENT');
    assert.equal(codeOf(() => assertNoWhitespacePath('/home/me/my work', 'destination', 'linux')), 'INVALID_ARGUMENT');
  });
});
