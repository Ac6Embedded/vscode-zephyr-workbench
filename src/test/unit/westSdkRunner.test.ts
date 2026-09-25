import { strict as assert } from 'assert';
import * as os from 'os';

// Only the pure exports are exercised here; the module's vscode import resolves to
// the stub under src/test/unit/stubs (NODE_PATH), like the other unit tests.
import {
  buildWestSdkInstallArgs,
  classifyWestSdkFailure,
  runSdkSetup,
  WestSdkInstallError,
} from '../../utils/zephyr/westSdkRunner';

describe('buildWestSdkInstallArgs', () => {
  it('full install (no -t): version + default install base only', () => {
    assert.deepEqual(
      buildWestSdkInstallArgs({ version: '0.17.4' }),
      ['sdk', 'install', '--version', '0.17.4', '-b', os.homedir()]
    );
  });

  it('an empty gnuToolchains array also omits -t (install all)', () => {
    assert.deepEqual(
      buildWestSdkInstallArgs({ version: '0.17.4', gnuToolchains: [] }),
      ['sdk', 'install', '--version', '0.17.4', '-b', os.homedir()]
    );
  });

  it('minimal install with two toolchains: one -t flag followed by all names', () => {
    assert.deepEqual(
      buildWestSdkInstallArgs({
        version: '0.17.4',
        installBase: '/opt/sdks',
        gnuToolchains: ['arm-zephyr-eabi', 'riscv64-zephyr-elf'],
      }),
      [
        'sdk', 'install',
        '--version', '0.17.4',
        '-b', '/opt/sdks',
        '-t', 'arm-zephyr-eabi', 'riscv64-zephyr-elf',
      ]
    );
  });

  it('llvm + noHostTools (+ noGnuToolchains) map to -l, -H and -T', () => {
    assert.deepEqual(
      buildWestSdkInstallArgs({
        version: '1.0.0',
        installBase: '/opt/sdks',
        noGnuToolchains: true,
        llvm: true,
        noHostTools: true,
      }),
      ['sdk', 'install', '--version', '1.0.0', '-b', '/opt/sdks', '-T', '-l', '-H']
    );
  });

  it('includes the personal access token and api-url when provided', () => {
    assert.deepEqual(
      buildWestSdkInstallArgs({
        version: '0.17.4',
        installBase: '/opt/sdks',
        personalAccessToken: 'ghp_secret123',
        apiUrl: 'https://api.example.com/repos/acme/sdk-ng/releases',
      }),
      [
        'sdk', 'install',
        '--version', '0.17.4',
        '-b', '/opt/sdks',
        '--personal-access-token', 'ghp_secret123',
        '--api-url', 'https://api.example.com/repos/acme/sdk-ng/releases',
      ]
    );
  });
});

describe('classifyWestSdkFailure', () => {
  // Representative tails grounded in sdk.py's output strings
  // (res/west-sdk/manifest/scripts/west_commands/sdk.py).

  it('detects a GitHub API rate limit (before the generic network match)', () => {
    const tail = [
      'Fetching Zephyr SDK list...',
      'fetch_releases API rate limit exceeded. Try executing install script with --personal-access-token argument or use a .netrc file',
      "FATAL ERROR: Failed to fetch: 403, {\"message\": \"API rate limit exceeded for 1.2.3.4.\"}",
    ].join('\n');
    assert.equal(classifyWestSdkFailure(tail), 'rate-limit');
  });

  it('detects a sha256 mismatch', () => {
    const tail = 'Exception: sha256 mismatched: abc123:def456';
    assert.equal(classifyWestSdkFailure(tail), 'checksum');
  });

  it('detects an unavailable SDK version as bad-request', () => {
    const tail = 'FATAL ERROR: Unavailable SDK version: 9.9.9.Please select from the list below:\n0.17.4\n0.17.3';
    assert.equal(classifyWestSdkFailure(tail), 'bad-request');
  });

  it('detects an unavailable toolchain as bad-request', () => {
    const tail = 'FATAL ERROR: GNU toolchain foo-zephyr-elf is not available.\nPlease select from the list below:\narm-zephyr-eabi';
    assert.equal(classifyWestSdkFailure(tail), 'bad-request');
  });

  it('detects a missing host bundle as bad-request', () => {
    const tail = 'FATAL ERROR: No Zephyr SDK 0.17.4 bundle found for host macos-aarch64.';
    assert.equal(classifyWestSdkFailure(tail), 'bad-request');
  });

  it('detects a failed setup script (POSIX and Windows)', () => {
    assert.equal(
      classifyWestSdkFailure('FATAL ERROR: command "/home/user/zephyr-sdk-0.17.4/setup.sh -t all -h" failed'),
      'setup-failed'
    );
    assert.equal(
      classifyWestSdkFailure('FATAL ERROR: command "C:\\Users\\user\\zephyr-sdk-0.17.4\\setup.cmd /c" failed'),
      'setup-failed'
    );
  });

  it('detects network failures', () => {
    assert.equal(
      classifyWestSdkFailure("requests.exceptions.ConnectionError: HTTPSConnectionPool(host='api.github.com', port=443): Max retries exceeded"),
      'network'
    );
    assert.equal(classifyWestSdkFailure('Exception: Failed to fetch: 502, upstream error'), 'network');
    assert.equal(classifyWestSdkFailure('Exception: Failed to download https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.17.4/sha256.sum: 500'), 'network');
    assert.equal(classifyWestSdkFailure('Error: getaddrinfo ENOTFOUND api.github.com'), 'network');
  });

  it('detects missing Python packages', () => {
    const tail = "ModuleNotFoundError: No module named 'tqdm'";
    assert.equal(classifyWestSdkFailure(tail), 'python-deps');
  });

  it('detects a missing archive extractor', () => {
    const tail = 'patool error: could not find an executable program to extract format 7z; candidates are (7z,7za,7zr),';
    assert.equal(classifyWestSdkFailure(tail), 'extractor');
  });

  it('detects permission errors', () => {
    assert.equal(
      classifyWestSdkFailure("FATAL ERROR: PermissionError(13, 'Permission denied')"),
      'permission'
    );
    assert.equal(classifyWestSdkFailure('EACCES: permission denied, mkdir /opt/sdks'), 'permission');
  });

  it('falls back to unknown for unrecognized output', () => {
    assert.equal(classifyWestSdkFailure('something completely unexpected happened'), 'unknown');
  });
});

describe('WestSdkInstallError', () => {
  it('carries the kind and output tail', () => {
    const error = new WestSdkInstallError('checksum', 'Downloaded SDK archive failed sha256 verification. Please retry.', 'sha256 mismatched: a:b');
    assert.equal(error.kind, 'checksum');
    assert.equal(error.outputTail, 'sha256 mismatched: a:b');
    assert.equal(error.name, 'WestSdkInstallError');
    assert.ok(error instanceof Error);
  });
});

describe('runSdkSetup', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const vscodeStub = require('vscode') as Record<string, unknown>;

  // Reading the env script setting checks `scope instanceof vscode.Uri`, which needs a class.
  let savedUri: unknown;
  before(() => {
    savedUri = vscodeStub.Uri;
    vscodeStub.Uri = class FakeUri {
      constructor(readonly fsPath: string) {}
      static file(fsPath: string) { return new FakeUri(fsPath); }
    };
  });
  after(() => {
    vscodeStub.Uri = savedUri;
  });

  /** A stand-in setup script that prints its flags, as the SDK's own prints its steps. */
  function fakeSdk(script: string): string {
    const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-setup-'));
    fs.writeFileSync(path.join(sdk, 'setup.sh'), script, { mode: 0o755 });
    return sdk;
  }

  it('streams the setup script output to onOutput, one invocation per flag set', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    const sdk = fakeSdk('#!/bin/sh\necho "Installing $*"\n');
    const chunks: string[] = [];
    await runSdkSetup(sdk, { gnuToolchains: ['arm-zephyr-eabi'], hostTools: false }, chunk => chunks.push(chunk));
    assert.deepEqual(chunks.join('').trim().split('\n'), ['Installing -c', 'Installing -t arm-zephyr-eabi']);
  });

  it('fails with setup-failed when the script does, after streaming its output', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    const sdk = fakeSdk('#!/bin/sh\necho broken\nexit 3\n');
    const chunks: string[] = [];
    await assert.rejects(runSdkSetup(sdk, {}, chunk => chunks.push(chunk)), (error: WestSdkInstallError) => error.kind === 'setup-failed');
    assert.match(chunks.join(''), /broken/);
  });

  it('stops the setup script and what it started when the token is cancelled, and runs nothing more', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    this.timeout(25000);
    // The sleep stands in for a download: it holds the output open, so the run
    // ends long before the sleep would only when the whole tree was stopped. A
    // SIGTERM that lands while the shell starts the sleep can reach it with the
    // signal still blocked; the SIGKILL escalation 5 s later then stops it.
    const sdk = fakeSdk('#!/bin/sh\necho "started $*"\nsleep 30\necho finished\n');
    let cancelled = false;
    const listeners: Array<() => void> = [];
    const token = {
      get isCancellationRequested() { return cancelled; },
      onCancellationRequested: (listener: () => void) => {
        listeners.push(listener);
        return { dispose: () => undefined };
      },
    } as never;
    const chunks: string[] = [];
    const startedAt = Date.now();
    await assert.rejects(runSdkSetup(sdk, { gnuToolchains: ['arm-zephyr-eabi'], hostTools: false }, chunk => {
      chunks.push(chunk);
      if (chunk.includes('started') && !cancelled) {
        cancelled = true;
        listeners.forEach(listener => listener());
      }
    }, token), (error: WestSdkInstallError) => error.kind === 'cancelled');
    assert.ok(Date.now() - startedAt < 15000, `the script and its sleep were stopped (${Date.now() - startedAt} ms)`);
    assert.deepEqual(chunks.join('').trim().split('\n'), ['started -c']);
  });
});
