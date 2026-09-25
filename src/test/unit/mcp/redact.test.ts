import { strict as assert } from 'assert';
import { isSecretKey, logSafe, redactCommandLine, redactValue, REDACTED, truncateForAudit } from '../../../mcp/core/redact';

describe('mcp/core/redact', () => {
  it('recognizes credential-shaped key names', () => {
    for (const key of ['token', 'IAR_LMS_BEARER_TOKEN', 'apiKey', 'password', 'AUTH_HEADER', 'credentials',
      'access-token', 'privateKey', 'authToken', 'SECRET']) {
      assert.equal(isSecretKey(key), true, `${key} should be treated as a secret`);
    }
    // Matched per segment: a substring test would blank these, which makes a
    // result confusing to read for no security gain.
    for (const key of ['board', 'app_path', 'config_name', 'monkey_patch', 'keywords', 'authentic', 'donkey', 'passwordless_note']) {
      assert.equal(isSecretKey(key), false, `${key} should not be treated as a secret`);
    }
  });

  it('redacts the IAR bearer token the workbench really stores', () => {
    const toolchains = { iar: [{ zephyrSdkPath: '/opt/iar', iarPath: '/opt/iar/bin', token: 'live-secret' }] };
    const out = redactValue(toolchains) as typeof toolchains;
    assert.equal(out.iar[0].token, REDACTED);
    assert.equal(out.iar[0].iarPath, '/opt/iar/bin', 'non-secret fields must survive');
  });

  it('walks arrays and nested objects', () => {
    const out = redactValue({ a: [{ secret: 'x' }, { keep: 'y' }] }) as { a: { secret?: string; keep?: string }[] };
    assert.equal(out.a[0].secret, REDACTED);
    assert.equal(out.a[1].keep, 'y');
  });

  it('leaves empty and absent values alone so the shape stays readable', () => {
    const out = redactValue({ token: '', other: null }) as Record<string, unknown>;
    assert.equal(out.token, '');
    assert.equal(out.other, null);
  });

  it('redacts credentials that appear inline in a command line', () => {
    assert.equal(redactCommandLine('curl -H "Bearer abc123.def"'), `curl -H "Bearer ${REDACTED}"`);
    assert.equal(redactCommandLine('west flash --token sec  ret'), `west flash --token ${REDACTED}  ret`);
    assert.equal(redactCommandLine('tool --api-key=abc'), `tool --api-key=${REDACTED}`);
  });

  it('leaves an ordinary build command untouched', () => {
    const command = 'west build --board nucleo_f401re --build-dir "/ws/app/build/primary"';
    assert.equal(redactCommandLine(command), command);
  });

  it('truncates long audit values and says how long they were', () => {
    const text = truncateForAudit('a'.repeat(400));
    assert.ok(text.length < 400);
    assert.match(text, /\.\.\. \(400 chars\)$/);
  });

  it('redacts while serializing a structure for the audit log', () => {
    assert.match(truncateForAudit({ token: 'x', board: 'nucleo' }), /redacted/);
  });
});

describe('mcp/core/redact logSafe', () => {
  it('flattens anything that could start a forged log line', () => {
    assert.equal(logSafe('bad "x"\n[info] ok list_apps\r\u2028more'), 'bad "x" [info] ok list_apps more');
    assert.equal(logSafe('a'.repeat(20), 5), 'aaaaa...');
    assert.equal(logSafe(42), '42');
  });
});
