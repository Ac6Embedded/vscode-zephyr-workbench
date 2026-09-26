import { strict as assert } from 'assert';
import { assertCmakeVariableName, assertEnvListElement, assertShieldOrSnippetName } from '../../../mcp/core/argSafety';

// The checks for values a build configuration persists: each one reaches a
// shell or a terminal on the next build.
describe('mcp/core/argSafety build configuration values', () => {
  it('accepts shield and snippet names and refuses anything a shell would read', () => {
    for (const good of ['x_nucleo_iks01a3', 'cdc-acm-console', 'espressif-flash-2M', 'a.b']) {
      assert.equal(assertShieldOrSnippetName(good, 'env.SNIPPETS'), good);
    }
    for (const bad of ['', '-S', '.hidden', 'a b', 'a;b', 'a/b', 'x'.repeat(65)]) {
      assert.throws(() => assertShieldOrSnippetName(bad, 'env.SNIPPETS'), /is not valid/, bad);
    }
  });

  it('accepts CMake variable names, with an optional type', () => {
    for (const good of ['CONFIG_DEBUG', '_private', 'MY_OPT:STRING', 'X:BOOL']) {
      assert.equal(assertCmakeVariableName(good, 'west_flags'), good);
    }
    for (const bad of ['', '1ABC', 'A-B', 'A B', 'A:string', 'A:', 'A$B']) {
      assert.throws(() => assertCmakeVariableName(bad, 'west_flags'), /is not valid/, bad);
    }
  });

  it('accepts plain list entries and refuses quotes, separators and shell syntax', () => {
    assert.equal(assertEnvListElement('${workspaceFolder}/boards/debug.conf', 'env.EXTRA_CONF_FILE'), '${workspaceFolder}/boards/debug.conf');
    assert.equal(assertEnvListElement('/ws/My Files/app.overlay', 'env.EXTRA_DTC_OVERLAY_FILE'), '/ws/My Files/app.overlay');
    for (const bad of ['', '  ', 'a;b', '"a"', "it's", '${env:HOME}/x', 'a`id`', 'x'.repeat(1025)]) {
      assert.throws(() => assertEnvListElement(bad, 'env.EXTRA_CONF_FILE'), { code: 'INVALID_ARGUMENT' }, bad);
    }
  });
});
