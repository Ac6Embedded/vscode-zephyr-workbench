// A debug_app call carrying a session_id goes to the window that runs the
// session, the way a job_id goes to the window that ran the job, whatever
// app_path says; a session of a window that is gone has ended. The job_id
// rule is checked unchanged next to it.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BridgeLog } from '../../../mcp/bridge/log';
import { jobWindowOf, SESSION_ID_PATTERN, sessionWindowGone, sessionWindowOf } from '../../../mcp/bridge/ownerWindow';
import { BridgeOptions, liveRecords, resolveWindow } from '../../../mcp/bridge/upstream';
import { findTool } from '../../../mcp/core/catalog';
import { getMcpPaths } from '../../../mcp/core/paths';
import { WindowRecord, writeWindowRecord } from '../../../mcp/core/registry';
import { routeOfCall } from '../../../mcp/core/routing';

function record(windowId: string, folder: string, focusedAt: string): WindowRecord {
  return {
    schema: 1, windowId, pid: process.pid, platform: process.platform, hostname: os.hostname(), port: 40000, token: 't',
    workspaceFolders: [folder], appRoots: [folder], westWorkspaces: [],
    ide: { name: 't', version: '0', uriScheme: 'vscode' }, nodeExecPath: '', extensionVersion: '0',
    catalogVersion: '0', startedAt: '', focusedAt, heartbeatAt: new Date().toISOString(),
  };
}

describe('mcp/bridge/ownerWindow', () => {
  it('reads the window of a session_id, and nothing else', () => {
    assert.equal(sessionWindowOf({ session_id: 'w1.dbg-4f1c2a9e' }), 'w1');
    assert.equal(sessionWindowOf({ session_id: 'abc_DEF-9.dbg-x2' }), 'abc_DEF-9');
    assert.equal(sessionWindowOf({ session_id: 'w1.build-1-abc' }), undefined, 'a job id is not a session id');
    assert.equal(sessionWindowOf({ session_id: 'dbg-4f1c2a9e' }), undefined, 'the window part is required');
    assert.equal(sessionWindowOf({ session_id: 'w/1.dbg-4f1c' }), undefined);
    assert.equal(sessionWindowOf({ session_id: 42 }), undefined);
    assert.equal(sessionWindowOf({}), undefined);
    assert.equal(sessionWindowOf(undefined), undefined);
    assert.ok(SESSION_ID_PATTERN.test('w1.dbg-abcdef122'));
  });

  it('reads the window of a job_id exactly as before', () => {
    assert.equal(jobWindowOf({ job_id: 'w1.build-1-abc' }), 'w1');
    assert.equal(jobWindowOf({ job_id: 'build-1-abc' }), undefined);
    assert.equal(jobWindowOf({ job_id: 'w 1.build-1' }), undefined);
    assert.equal(jobWindowOf({ job_id: 7 }), undefined);
    assert.equal(jobWindowOf({ session_id: 'w1.dbg-1' }), undefined);
  });

  it('says a session has ended when its window is gone, and nothing when it is there', () => {
    const records = [record('w1', '/ws/one', '')];
    assert.equal(sessionWindowGone(records, { session_id: 'w1.dbg-1' }), undefined);
    assert.equal(sessionWindowGone(records, { action: 'status' }), undefined);
    const gone = sessionWindowGone(records, { session_id: 'w9.dbg-1' });
    assert.equal(gone?.code, 'SESSION_NOT_FOUND');
    assert.match(gone?.hint ?? '', /debug_app with action "status"/);
  });

  describe('routing', () => {
    let home: string;
    const log = new BridgeLog();
    const options = (): BridgeOptions => ({ home, workspace: path.join(os.tmpdir(), 'zw-unrelated-agent-folder'), routing: 'nearest' });

    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-mcp-session-routing-'));
    });
    afterEach(() => {
      fs.rmSync(home, { recursive: true, force: true });
    });

    /** Route a debug_app call as the bridge does: the session's window is the lock. */
    const route = (args: Record<string, unknown>) => {
      const meta = findTool('debug_app')!;
      return resolveWindow(options(), log, {
        readOnly: false, ...routeOfCall(meta, args), lockTo: sessionWindowOf(args), isKnownGood: () => true,
      });
    };

    it('sends a call with a session_id to the window of the session, even when app_path names another one', async () => {
      const one = path.join(home, 'one');
      const two = path.join(home, 'two');
      fs.mkdirSync(path.join(two, 'app'), { recursive: true });
      fs.mkdirSync(one);
      writeWindowRecord(getMcpPaths(home), record('w1', one, '2026-09-22T10:00:00.000Z'));
      writeWindowRecord(getMcpPaths(home), record('w2', two, '2026-09-22T11:00:00.000Z'));
      const bySession = await route({ action: 'inspect', session_id: 'w1.dbg-4f1c2a9e', app_path: two });
      assert.equal(bySession.record?.windowId, 'w1');
      // Without it, app_path picks the window as for any other call.
      const byPath = await route({ action: 'inspect', app_path: path.join(two, 'app') });
      assert.equal(byPath.record?.windowId, 'w2');
    });

    it('answers SESSION_NOT_FOUND at once for a session of a window that closed', async () => {
      writeWindowRecord(getMcpPaths(home), record('w1', '/ws/one', '2026-09-22T10:00:00.000Z'));
      const gone = sessionWindowGone(liveRecords(options()), { session_id: 'w7.dbg-1' });
      assert.equal(gone?.code, 'SESSION_NOT_FOUND');
      assert.equal(sessionWindowGone(liveRecords(options()), { session_id: 'w1.dbg-1' }), undefined);
    });
  });
});
