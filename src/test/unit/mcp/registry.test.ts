import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getMcpPaths } from '../../../mcp/core/paths';
import {
  endpointOf,
  isHeartbeatStale,
  isListening,
  isPidAlive,
  pruneDeadRecords,
  readWindowRecords,
  removeOwnWindowRecord,
  removeWindowRecord,
  WindowRecord,
  writeWindowRecord,
} from '../../../mcp/core/registry';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zw-mcp-test-'));
}

function record(over: Partial<WindowRecord> = {}): WindowRecord {
  return {
    schema: 1,
    windowId: 'w1',
    pid: process.pid,
    platform: process.platform,
    hostname: os.hostname(),
    port: 41000,
    url: 'http://127.0.0.1:41000/mcp',
    token: 'secret',
    workspaceFolders: ['/ws'],
    appRoots: ['/ws/app'],
    westWorkspaces: ['/ws'],
    ide: { name: 'Visual Studio Code', version: '1.138.0', uriScheme: 'vscode' },
    nodeExecPath: '/code',
    extensionVersion: '4.2.1',
    catalogVersion: '1',
    startedAt: new Date(0).toISOString(),
    focusedAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
    ...over,
  };
}

describe('mcp/core/registry', () => {
  it('round trips a record through an atomic write', () => {
    const home = tmpHome();
    const paths = getMcpPaths(home);
    const original = record();
    writeWindowRecord(paths, original);
    const [read] = readWindowRecords(paths);
    assert.deepEqual(read, original);
  });

  it('leaves no temporary file behind', () => {
    const home = tmpHome();
    const paths = getMcpPaths(home);
    writeWindowRecord(paths, record());
    const names = fs.readdirSync(paths.windowsDir);
    assert.deepEqual(names, ['w1.json']);
  });

  it('creates the directory tree with restrictive modes on POSIX', function () {
    if (process.platform === 'win32') {
      this.skip();
      return;
    }
    const home = tmpHome();
    const paths = getMcpPaths(home);
    writeWindowRecord(paths, record());
    assert.equal(fs.statSync(paths.windowsDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(paths.windowRecord('w1')).mode & 0o777, 0o600);
  });

  it('ignores malformed and future-schema records', () => {
    const home = tmpHome();
    const paths = getMcpPaths(home);
    writeWindowRecord(paths, record());
    fs.writeFileSync(path.join(paths.windowsDir, 'broken.json'), '{ not json');
    fs.writeFileSync(path.join(paths.windowsDir, 'future.json'), JSON.stringify(record({ windowId: 'f', schema: 99 })));
    fs.writeFileSync(path.join(paths.windowsDir, 'notes.txt'), 'ignored');
    const read = readWindowRecords(paths);
    assert.deepEqual(read.map(r => r.windowId), ['w1']);
  });

  it('returns an empty list when the directory does not exist', () => {
    assert.deepEqual(readWindowRecords(getMcpPaths(path.join(os.tmpdir(), 'zw-mcp-absent-dir'))), []);
  });

  it('removes a record and tolerates removing it twice', () => {
    const home = tmpHome();
    const paths = getMcpPaths(home);
    writeWindowRecord(paths, record());
    removeWindowRecord(paths, 'w1');
    removeWindowRecord(paths, 'w1');
    assert.deepEqual(readWindowRecords(paths), []);
  });

  it('treats a record without a port as published but not listening', () => {
    assert.equal(isListening(record()), true);
    assert.equal(isListening(record({ port: undefined, token: undefined })), false);
  });

  describe('liveness', () => {
    it('sees this process as alive', () => {
      assert.equal(isPidAlive(record()), true);
    });
    it('sees an impossible pid as dead', () => {
      assert.equal(isPidAlive(record({ pid: 0x7ffffff0 })), false);
    });
    it('declines to judge a record from another machine', () => {
      assert.equal(isPidAlive(record({ hostname: 'somewhere-else' })), undefined);
      assert.equal(isPidAlive(record({ platform: 'sunos' as NodeJS.Platform })), undefined);
    });
  });

  it('detects a stale heartbeat', () => {
    const now = Date.parse('2026-09-22T12:00:00.000Z');
    assert.equal(isHeartbeatStale(record({ heartbeatAt: '2026-09-22T11:59:00.000Z' }), 5 * 60_000, now), false);
    assert.equal(isHeartbeatStale(record({ heartbeatAt: '2026-09-22T11:00:00.000Z' }), 5 * 60_000, now), true);
    assert.equal(isHeartbeatStale(record({ heartbeatAt: 'nonsense' }), 5 * 60_000, now), true);
  });

  describe('pruneDeadRecords', () => {
    it('removes a dead record with a stale heartbeat', () => {
      const home = tmpHome();
      const paths = getMcpPaths(home);
      writeWindowRecord(paths, record({ windowId: 'dead', pid: 0x7ffffff0 }));
      const removed = pruneDeadRecords(paths, Date.parse('2026-09-22T12:00:00.000Z'));
      assert.deepEqual(removed, ['dead']);
      assert.deepEqual(readWindowRecords(paths), []);
    });

    it('keeps a live record', () => {
      const home = tmpHome();
      const paths = getMcpPaths(home);
      writeWindowRecord(paths, record({ windowId: 'live' }));
      pruneDeadRecords(paths, Date.parse('2026-09-22T12:00:00.000Z'));
      assert.deepEqual(readWindowRecords(paths).map(r => r.windowId), ['live']);
    });

    it('keeps a record from another machine even when its heartbeat is old', () => {
      const home = tmpHome();
      const paths = getMcpPaths(home);
      writeWindowRecord(paths, record({ windowId: 'remote', hostname: 'other-host', pid: 0x7ffffff0 }));
      pruneDeadRecords(paths, Date.parse('2026-09-22T12:00:00.000Z'));
      assert.deepEqual(readWindowRecords(paths).map(r => r.windowId), ['remote']);
    });
  });

  describe('hostile records', () => {
    function plant(home: string, name: string, body: unknown) {
      const paths = getMcpPaths(home);
      fs.mkdirSync(paths.windowsDir, { recursive: true });
      fs.writeFileSync(path.join(paths.windowsDir, name), JSON.stringify(body));
      return paths;
    }

    it('rejects a window id that could traverse out of the directory', () => {
      const home = tmpHome();
      const paths = plant(home, 'evil.json', record({ windowId: '../../../.profile' }));
      assert.deepEqual(readWindowRecords(paths), [], 'a traversal id must never be read');
    });

    it('rejects an impossible port', () => {
      for (const port of [0, -1, 70000, 1.5]) {
        const home = tmpHome();
        const paths = plant(home, 'bad.json', record({ windowId: 'bad', port }));
        assert.deepEqual(readWindowRecords(paths), [], `port ${port} must be rejected`);
      }
    });

    it('derives the endpoint from the port only, never from the url field', () => {
      const forged = record({ port: 41000, url: 'http://attacker.example/mcp' });
      assert.equal(endpointOf(forged).mcp, 'http://127.0.0.1:41000/mcp');
    });

    it('keeps a valid tools list and rejects a malformed one', () => {
      const home = tmpHome();
      const paths = getMcpPaths(home);
      writeWindowRecord(paths, record({ windowId: 'ok', tools: ['list_apps'] }));
      plant(home, 'badtools.json', record({ windowId: 'badtools', tools: [1, 2] as unknown as string[] }));
      assert.deepEqual(readWindowRecords(paths).map(r => r.windowId), ['ok']);
    });
  });

  describe('removeOwnWindowRecord', () => {
    it('removes the record this process wrote', () => {
      const home = tmpHome();
      const paths = getMcpPaths(home);
      writeWindowRecord(paths, record({ windowId: 'mine' }));
      removeOwnWindowRecord(paths, 'mine', process.pid);
      assert.deepEqual(readWindowRecords(paths), []);
    });

    it('leaves a record another process now owns', () => {
      // Two windows that shared an id must not delete each other's record on close.
      const home = tmpHome();
      const paths = getMcpPaths(home);
      writeWindowRecord(paths, record({ windowId: 'shared', pid: process.pid + 1 }));
      removeOwnWindowRecord(paths, 'shared', process.pid);
      assert.deepEqual(readWindowRecords(paths).map(r => r.windowId), ['shared']);
    });
  });
});
