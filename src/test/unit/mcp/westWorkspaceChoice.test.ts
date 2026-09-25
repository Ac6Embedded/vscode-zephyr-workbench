import { strict as assert } from 'assert';
import { McpToolError } from '../../../mcp/core/errors';
import { chooseWestWorkspaceRoot, WestWorkspaceChoice } from '../../../mcp/core/westWorkspaceChoice';

const WS = '/home/u/zephyrproject';
const OTHER = '/home/u/ncs';

function choose(over: Partial<WestWorkspaceChoice>): string {
  return chooseWestWorkspaceRoot({ registered: [WS], knownRoots: [], platform: 'linux', ...over });
}

function fails(over: Partial<WestWorkspaceChoice>, code: string): McpToolError {
  let caught: unknown;
  try {
    choose(over);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof McpToolError, 'expected an McpToolError');
  assert.equal(caught.code, code, caught.message);
  return caught;
}

describe('mcp/core/westWorkspaceChoice', () => {
  describe('with no argument', () => {
    it('takes the only west workspace', () => {
      assert.equal(choose({}), WS);
    });

    it('reports a window without one as a setup gap', () => {
      fails({ registered: [] }, 'ENV_NOT_READY');
    });

    it('refuses to guess between several, and lists them', () => {
      const error = fails({ registered: [WS, OTHER] }, 'INVALID_ARGUMENT');
      assert.deepEqual(error.details?.candidates, [WS, OTHER]);
    });
  });

  describe('with west_workspace', () => {
    it('accepts a registered root, in its registered spelling', () => {
      assert.equal(choose({ registered: [WS, OTHER], requested: `${OTHER}/` }), OTHER);
      assert.equal(
        choose({ registered: ['/Users/U/ZP'], requested: '/users/u/zp', platform: 'darwin' }),
        '/Users/U/ZP',
        'macOS paths compare case-insensitively',
      );
    });

    it('refuses a relative path', () => {
      const error = fails({ requested: 'zephyrproject' }, 'INVALID_ARGUMENT');
      assert.deepEqual(error.details?.available, [WS]);
    });

    it('asks for the root itself when given a folder inside a workspace', () => {
      const error = fails({ requested: `${WS}/zephyr` }, 'INVALID_ARGUMENT');
      assert.match(error.message, /pass the workspace root itself/);
    });

    it('refuses a known folder that is not a west workspace', () => {
      fails({ requested: '/home/u/app', knownRoots: ['/home/u/app'] }, 'INVALID_ARGUMENT');
    });

    it('refuses anything outside the folders the window knows', () => {
      const error = fails({ requested: '/etc' }, 'PATH_OUTSIDE_WORKSPACE');
      assert.deepEqual(error.details?.available, [WS]);
    });

    it('compares Windows paths the Windows way', () => {
      assert.equal(
        choose({ registered: ['C:\\zp'], requested: 'c:/ZP', platform: 'win32' }),
        'C:\\zp',
      );
      fails({ registered: ['C:\\zp'], requested: 'zp\\sub', platform: 'win32' }, 'INVALID_ARGUMENT');
      fails({ registered: ['C:\\zp'], requested: 'D:\\other', platform: 'win32' }, 'PATH_OUTSIDE_WORKSPACE');
    });
  });

  describe('with app_path', () => {
    const application = { appPath: '/home/u/app', westWorkspaceRoot: OTHER };

    it('uses the west workspace the application is linked to, even when the window does not open it', () => {
      assert.equal(choose({ application }), OTHER);
    });

    it('accepts the same workspace named twice', () => {
      assert.equal(choose({ application, requested: `${OTHER}/` }), OTHER);
    });

    it('refuses two arguments that disagree', () => {
      fails({ application, requested: WS }, 'INVALID_ARGUMENT');
    });

    it('refuses an application that is not linked to any', () => {
      fails({ application: { appPath: '/home/u/app' } }, 'INVALID_ARGUMENT');
    });
  });
});
