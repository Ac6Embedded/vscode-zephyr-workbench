import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { driftExportEdits, offeredRemovals } from '../../../utils/kconfig/driftExport';
import type { KcDriftEntry } from '../../../utils/kconfig/kconfigRpcTypes';
import { BEGIN, END, readPrjConfManagedRegion, upsertPrjConfManagedRegion } from '../../../utils/kconfig/prjConfWriter';

const entry = (name: string, configString: string, managedLine?: KcDriftEntry['managedLine']): KcDriftEntry =>
  ({ name, baseline: 'y', current: 'n', configString, ...(managedLine ? { managedLine } : {}) });

describe('driftExport', () => {
  it('writes new and updated lines, and removes the managed lines that no longer apply', () => {
    const edits = driftExportEdits([
      entry('GPIO', 'CONFIG_GPIO=y'),
      entry('LOG', '# CONFIG_LOG is not set', 'update'),
      entry('LOG_EXTRA', '', 'remove'),
    ]);
    assert.deepEqual(edits, { lines: ['CONFIG_GPIO=y', '# CONFIG_LOG is not set'], remove: ['LOG_EXTRA'] });
  });

  it('only removes what the export offered', () => {
    assert.deepEqual(offeredRemovals(['LOG_EXTRA', 'GPIO'], ['LOG_EXTRA']), ['CONFIG_LOG_EXTRA']);
    assert.deepEqual(offeredRemovals(undefined, ['LOG_EXTRA']), []);
  });

  it('leaves no stale pinned value in the region once written', () => {
    // An earlier export pinned LOG and LOG_EXTRA; the user set LOG back to its default,
    // which hides LOG_EXTRA, and enabled GPIO.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zwb-drift-'));
    try {
      const prj = path.join(tmp, 'prj.conf');
      fs.writeFileSync(prj, `${BEGIN}\nCONFIG_LOG=y\nCONFIG_LOG_EXTRA=y\n${END}\n`);
      const edits = driftExportEdits([
        entry('GPIO', 'CONFIG_GPIO=y'),
        entry('LOG', '# CONFIG_LOG is not set', 'update'),
        entry('LOG_EXTRA', '', 'remove'),
      ]);
      upsertPrjConfManagedRegion(prj, edits.lines, offeredRemovals(edits.remove, ['LOG_EXTRA']));
      assert.deepEqual(readPrjConfManagedRegion(prj), ['# CONFIG_LOG is not set', 'CONFIG_GPIO=y']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
