// get_diagnostics with the Problems panel and the language servers stood in
// for: ECLAIR findings read from the SARIF report of a build, filtered and
// paged, and open_files, which opens files inside the application without an
// editor and waits a moment for their problems.

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { findTool } from '../../../mcp/core/catalog';
import { McpToolError } from '../../../mcp/core/errors';
import { ToolContext } from '../../../mcp/core/toolSpec';
import type { HostDeps } from '../../../mcp/host/handlers/deps';
import { JobManager } from '../../../mcp/jobs/jobManager';
import { useUiGuard } from './uiGuard';

const stub = require('vscode') as Record<string, any>;

interface FakeUri { fsPath: string; scheme: string; toString(): string }
const uriOf = (fsPath: string): FakeUri => ({ fsPath, scheme: 'file', toString: () => `file://${fsPath}` });

/**
 * An open document: the text VS Code holds for the file, which can differ from
 * the disk, its version, which goes up on every change, and the encoding VS
 * Code 1.100 and later tell it was read with.
 */
interface FakeDoc { uri: FakeUri; text: string; isDirty: boolean; version: number; encoding?: string; getText(): string }
const docOf = (fsPath: string, text: string, isDirty = false, encoding?: string): FakeDoc =>
  ({ uri: uriOf(fsPath), text, isDirty, version: 1, ...(encoding ? { encoding } : {}), getText() { return this.text; } });

describe('get_diagnostics', () => {
  useUiGuard();

  const MODULE = require.resolve('../../../mcp/host/handlers/diagnostics');
  const CHECKS_MODULE = require.resolve('../../../mcp/host/documentChecks');
  const added: string[] = [];
  const savedParts: Record<string, unknown> = {};
  let getDiagnostics: typeof import('../../../mcp/host/handlers/diagnostics').getDiagnostics;
  let watchDocumentChecks: typeof import('../../../mcp/host/documentChecks').watchDocumentChecks;
  /** What the extension records from activation on: the reports on open documents. */
  let documentChecks: { dispose(): void };

  let root: string;
  let appRoot: string;
  let buildDir: string;
  /** Diagnostics per file, as vscode.languages.getDiagnostics reports them. */
  let problems: Map<string, { severity: number; message: string; range: { start: { line: number; character: number } }; source?: string }[]>;
  let listeners: Array<(event: { uris: FakeUri[] }) => void>;
  /** Listeners of workspace.onDidChangeTextDocument, which fires as VS Code reloads a file. */
  let textListeners: Array<(event: { document: FakeDoc; contentChanges: unknown[] }) => void>;
  /** VS Code reloading an open document from its file. */
  const reload = (doc: FakeDoc, text: string) => {
    doc.text = text;
    doc.version++;
    textListeners.forEach(listener => listener({ document: doc, contentChanges: [{ text }] }));
  };
  let opened: string[];
  let openDocs: FakeDoc[];
  /** What opening a file does: by default, its language server reports one warning. */
  let onOpen: (file: string) => void;
  /** How VS Code reads a file it opens: as UTF-8 unless a test says otherwise. */
  let readAs: (file: string) => FakeDoc;
  let extensions: Record<string, unknown>;

  before(() => {
    const parts: Record<string, unknown> = {
      languages: {
        getDiagnostics: (uri?: FakeUri) => (uri
          ? problems.get(uri.fsPath) ?? []
          : [...problems.entries()].map(([file, list]) => [uriOf(file), list])),
        onDidChangeDiagnostics: (listener: (event: { uris: FakeUri[] }) => void) => {
          listeners.push(listener);
          return { dispose: () => { listeners = listeners.filter(l => l !== listener); } };
        },
      },
      DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    };
    for (const [key, value] of Object.entries(parts)) {
      if (!(key in stub)) {
        added.push(key);
        stub[key] = value;
      }
    }
    // `import * as vscode` binds the keys that exist when a module loads, so
    // the handler is loaded afresh now that the stub has them.
    delete require.cache[MODULE];
    delete require.cache[CHECKS_MODULE];
    getDiagnostics = require(MODULE).getDiagnostics;
    watchDocumentChecks = require(CHECKS_MODULE).watchDocumentChecks;
  });

  after(() => {
    for (const key of added) {
      delete stub[key];
    }
    delete require.cache[MODULE];
    delete require.cache[CHECKS_MODULE];
  });

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zwb-diag-')));
    appRoot = path.join(root, 'app');
    buildDir = path.join(appRoot, 'build', 'primary');
    fs.mkdirSync(path.join(appRoot, 'src'), { recursive: true });
    fs.mkdirSync(buildDir, { recursive: true });
    problems = new Map();
    listeners = [];
    textListeners = [];
    opened = [];
    openDocs = [];
    extensions = {};
    onOpen = file => {
      problems.set(file, [{ severity: 1, message: 'unused variable', range: { start: { line: 4, character: 2 } }, source: 'clangd' }]);
      setTimeout(() => listeners.forEach(listener => listener({ uris: [uriOf(file)] })), 20);
    };
    for (const key of ['Uri']) {
      savedParts[key] = stub[key];
    }
    savedParts.openTextDocument = stub.workspace.openTextDocument;
    savedParts.textDocuments = stub.workspace.textDocuments;
    savedParts.onDidChangeTextDocument = stub.workspace.onDidChangeTextDocument;
    savedParts.onDidCloseTextDocument = stub.workspace.onDidCloseTextDocument;
    savedParts.decode = stub.workspace.decode;
    savedParts.getExtension = stub.extensions.getExtension;
    stub.Uri = { ...stub.Uri, file: uriOf };
    readAs = file => docOf(file, fs.readFileSync(file, 'utf8'));
    // Like VS Code, it hands back the document already open, and reads the file otherwise.
    stub.workspace.openTextDocument = async (uri: FakeUri) => {
      opened.push(uri.fsPath);
      const open = openDocs.find(doc => doc.uri.fsPath === uri.fsPath);
      if (open) {
        return open;
      }
      onOpen(uri.fsPath);
      return readAs(uri.fsPath);
    };
    Object.defineProperty(stub.workspace, 'textDocuments', { get: () => openDocs, configurable: true });
    stub.workspace.onDidChangeTextDocument = (listener: (event: { document: FakeDoc; contentChanges: unknown[] }) => void) => {
      textListeners.push(listener);
      return { dispose: () => { textListeners = textListeners.filter(l => l !== listener); } };
    };
    stub.workspace.onDidCloseTextDocument = () => ({ dispose: () => undefined });
    delete stub.workspace.decode;
    stub.extensions.getExtension = (id: string) => extensions[id];
    documentChecks = watchDocumentChecks();
  });

  afterEach(() => {
    documentChecks.dispose();
    stub.Uri = savedParts.Uri;
    stub.workspace.openTextDocument = savedParts.openTextDocument;
    delete stub.workspace.textDocuments;
    if (savedParts.textDocuments !== undefined) {
      stub.workspace.textDocuments = savedParts.textDocuments;
    }
    stub.workspace.onDidChangeTextDocument = savedParts.onDidChangeTextDocument;
    stub.workspace.onDidCloseTextDocument = savedParts.onDidCloseTextDocument;
    if (savedParts.decode !== undefined) {
      stub.workspace.decode = savedParts.decode;
    }
    stub.extensions.getExtension = savedParts.getExtension;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function ctx(signal = new AbortController().signal): ToolContext<HostDeps> {
    const deps = {
      services: {
        resolveTarget: async () => ({ app: { appRootPath: appRoot }, config: { name: 'primary' }, buildDir }),
      },
      jobs: { list: () => [] },
    };
    return {
      signal, progress: () => undefined, client: { name: 'test' },
      deps: deps as unknown as HostDeps, tool: findTool('get_diagnostics')!, startedAt: Date.now(), audit: {},
    };
  }
  const call = (args: Record<string, unknown>) => getDiagnostics(args, ctx()) as Promise<any>;

  async function errorOf(promise: Promise<unknown>): Promise<McpToolError> {
    try {
      await promise;
    } catch (error) {
      assert.ok(error instanceof McpToolError, `expected a tool error, got ${String(error)}`);
      return error;
    }
    assert.fail('expected the call to fail');
  }

  describe('source last_build', () => {
    it('reports the last build_app build, not an analysis that ran in the folder after it', async () => {
      const jobs = new JobManager({ logPathFor: id => path.join(root, `${id}.log`) });
      const job = (requestKey: string, output: string) => jobs.start({
        kind: 'build', lockKey: buildDir, requestKey, appPath: appRoot, configName: 'primary', buildDir, command: requestKey,
        run: async sink => { sink.onData(output); return { exitCode: 1 }; },
      }).job;
      const build = job(`build:${buildDir}:West Build`, `${appRoot}/src/main.c:3:5: error: 'x' undeclared (first use in this function)\n`);
      await build.done;
      await job(`analyze:${buildDir}:hardenconfig`, 'Harden config report\n').done;
      const result = await getDiagnostics({ source: 'last_build' }, { ...ctx(), deps: { ...ctx().deps, jobs } as unknown as HostDeps }) as any;
      assert.equal(result.last_build.job_id, build.id);
      assert.equal(result.last_build.counts.errors, 1);
    });
  });

  describe('source sca', () => {
    const writeSarif = () => {
      const dir = path.join(buildDir, 'sca', 'eclair');
      fs.mkdirSync(dir, { recursive: true });
      const at = (file: string, line: number) => [{ physicalLocation: { artifactLocation: { uri: pathToFileURL(file).href }, region: { startLine: line } } }];
      fs.writeFileSync(path.join(dir, 'reports.sarif'), JSON.stringify({
        version: '2.1.0',
        runs: [{
          tool: { driver: { name: 'ECLAIR', rules: [{ id: 'MC3R1.R10.1', shortDescription: { text: 'Essential type' } }] } },
          results: [
            { ruleId: 'MC3R1.R10.1', level: 'error', message: { text: 'one' }, locations: at(path.join(appRoot, 'src', 'main.c'), 3) },
            { ruleId: 'MC3R1.R10.1', level: 'warning', message: { text: 'two' }, locations: at(path.join(appRoot, 'src', 'util.c'), 9) },
            { ruleId: 'MC3R1.R8.4', level: 'warning', message: { text: 'three' }, locations: at(path.join(root, 'zephyr', 'kernel', 'sched.c'), 1) },
            { ruleId: 'MC3R1.R2.1', level: 'note', message: { text: 'four' }, locations: at(path.join(appRoot, 'src', 'main.c'), 20) },
          ],
        }],
      }));
      fs.writeFileSync(path.join(dir, 'summary_overall.txt'), 'Violations: 3\n');
    };

    it('reads the findings of the last ECLAIR analysis with counts per rule', async () => {
      writeSarif();
      const { sca } = await call({ source: 'sca' });
      assert.equal(sca.sarif_path, path.join(buildDir, 'sca', 'eclair', 'reports.sarif'));
      assert.deepEqual(sca.tools, ['ECLAIR']);
      assert.deepEqual(sca.counts, { total: 4, errors: 1, warnings: 2, notes: 1 });
      assert.equal(sca.matching, 4);
      assert.deepEqual(sca.by_rule[0], { rule: 'MC3R1.R10.1', count: 2, errors: 1, warnings: 1 });
      assert.deepEqual(sca.items[0], { rule: 'MC3R1.R10.1', severity: 'error', level: 'error', message: 'one', file: path.join(appRoot, 'src', 'main.c'), line: 3 });
      assert.deepEqual(sca.rules, { 'MC3R1.R10.1': 'Essential type' });
      assert.equal(sca.summary, 'Violations: 3');
      assert.equal(sca.next_offset, undefined);
    });

    it('filters by rule, path and severity, and pages', async () => {
      writeSarif();
      assert.equal((await call({ source: 'sca', rule: 'r10*' })).sca.matching, 2);
      assert.equal((await call({ source: 'sca', path_prefix: path.join(appRoot, 'src') })).sca.matching, 3);
      assert.equal((await call({ source: 'sca', path_prefix: 'kernel/sched' })).sca.matching, 1);
      assert.equal((await call({ source: 'sca', severity: 'warning' })).sca.matching, 2);
      const first = (await call({ source: 'sca', limit: 3 })).sca;
      assert.equal(first.items.length, 3);
      assert.equal(first.next_offset, 3);
      const second = (await call({ source: 'sca', limit: 3, offset: 3 })).sca;
      assert.deepEqual(second.items.map((item: any) => item.message), ['four']);
      assert.equal(second.next_offset, undefined);
    });

    it('sends the agent to analyze when there is no report', async () => {
      const error = await errorOf(call({ source: 'sca' }));
      assert.equal(error.code, 'NOT_BUILT');
      assert.match(error.hint ?? '', /analyze with analysis "eclair"/);
    });

    it('refuses the ECLAIR filters with another source', async () => {
      for (const extra of [{ rule: 'x' }, { path_prefix: '/x' }, { offset: 1 }]) {
        assert.equal((await errorOf(call({ source: 'both', ...extra }))).code, 'INVALID_ARGUMENT');
      }
      assert.equal((await errorOf(call({ ...{ rule: 'x' } }))).code, 'INVALID_ARGUMENT');
    });
  });

  describe('open_files', () => {
    it('opens the files and returns their problems once the language server reported', async () => {
      const file = path.join(appRoot, 'src', 'main.c');
      fs.writeFileSync(file, 'int main(void) { int x; return 0; }\n');
      const started = Date.now();
      const result = await call({ source: 'problems_panel', open_files: [file] });
      assert.ok(Date.now() - started < 2000, 'it does not wait the whole budget once the problems arrived');
      assert.deepEqual(opened, [file]);
      assert.deepEqual(result.opened, [{
        file, opened: true, counts: { errors: 0, warnings: 1 },
        items: [{ severity: 'warning', file, line: 5, column: 3, message: 'unused variable', source: 'clangd' }], truncated: false,
      }]);
      // The Problems panel read afterwards includes them.
      assert.equal(result.problems_panel.counts.warnings, 1);
      assert.equal(result.opened_note, undefined);
    });

    it('does not wait for a file already open with the text on disk', async () => {
      const file = path.join(appRoot, 'src', 'main.c');
      // Line breaks and a byte order mark as VS Code holds them do not count as a change.
      fs.writeFileSync(file, '\uFEFFint x;\r\nint y;\r\n');
      openDocs = [docOf(file, 'int x;\nint y;\n')];
      problems.set(file, [{ severity: 1, message: 'unused variable', range: { start: { line: 0, character: 4 } } }]);
      const started = Date.now();
      const result = await call({ source: 'last_build', open_files: [file] });
      assert.ok(Date.now() - started < 1000);
      assert.equal(result.opened[0].counts.warnings, 1);
      assert.equal(result.opened[0].note, undefined);
    });

    it('waits for a file rewritten on disk since it was opened until VS Code reloads it and its problems settle', async () => {
      const file = path.join(appRoot, 'app.overlay');
      fs.writeFileSync(file, '/ { fixed; };\n');
      const doc = docOf(file, '/ { broken };\n');
      openDocs = [doc];
      const report = () => listeners.forEach(listener => listener({ uris: [uriOf(file)] }));
      problems.set(file, [{ severity: 0, message: 'syntax error', range: { start: { line: 0, character: 4 } }, source: 'dts-lsp' }]);
      // A late report on the old text does not count: it says nothing of the file on disk.
      setTimeout(report, 20);
      // VS Code reloads the file well after that report would have settled, then the server reports on it.
      setTimeout(() => reload(doc, '/ { fixed; };\n'), 600);
      setTimeout(() => {
        problems.set(file, []);
        report();
      }, 650);
      const started = Date.now();
      const result = await call({ source: 'last_build', open_files: [file] });
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 650 && elapsed < 2500, `took ${elapsed} ms`);
      assert.deepEqual(result.opened[0].counts, { errors: 0, warnings: 0 });
      assert.equal(result.opened[0].note, undefined);
    });

    it('notes a rewritten file that VS Code has not reloaded yet', async () => {
      const file = path.join(appRoot, 'app.overlay');
      fs.writeFileSync(file, '/ { fixed; };\n');
      openDocs = [docOf(file, '/ { broken };\n')];
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const result = await getDiagnostics({ source: 'last_build', open_files: [file] }, ctx(controller.signal)) as any;
      assert.match(result.opened[0].note, /not reloaded this file from disk yet/);
      assert.match(result.opened[0].note, /get_diagnostics/);
    });

    /** An open file its language server reported on, which VS Code then reloaded from disk before the call. */
    const reloadedBeforeTheCall = () => {
      const file = path.join(appRoot, 'app.overlay');
      fs.writeFileSync(file, '/ { fixed; };\n');
      const doc = docOf(file, '/ { broken };\n');
      openDocs = [doc];
      const report = () => listeners.forEach(listener => listener({ uris: [uriOf(file)] }));
      problems.set(file, [{ severity: 0, message: 'syntax error', range: { start: { line: 0, character: 4 } }, source: 'dts-lsp' }]);
      report();
      reload(doc, '/ { fixed; };\n');
      return { file, report };
    };

    it('waits for a file VS Code reloaded just before the call until its language server reports on the new text', async () => {
      const { file, report } = reloadedBeforeTheCall();
      setTimeout(() => {
        problems.set(file, []);
        report();
      }, 300);
      const started = Date.now();
      const result = await call({ source: 'last_build', open_files: [file] });
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 300 && elapsed < 2500, `took ${elapsed} ms`);
      assert.deepEqual(result.opened[0].counts, { errors: 0, warnings: 0 });
      assert.equal(result.opened[0].note, undefined);
      // Reported on, it is not waited for again.
      const again = Date.now();
      await call({ source: 'last_build', open_files: [file] });
      assert.ok(Date.now() - again < 1000);
    });

    it('notes a reloaded file its language server has not reported on yet', async () => {
      const { file } = reloadedBeforeTheCall();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const result = await getDiagnostics({ source: 'last_build', open_files: [file] }, ctx(controller.signal)) as any;
      assert.equal(result.opened[0].counts.errors, 1);
      assert.match(result.opened[0].note, /since its content last changed/);
      assert.match(result.opened[0].note, /build_app/);
    });

    it('waits for each file on its own, so a quick report on one does not end the wait for a slower one', async () => {
      const quick = path.join(appRoot, 'src', 'main.c');
      const slow = path.join(appRoot, 'app.overlay');
      fs.writeFileSync(quick, 'int x;\n');
      fs.writeFileSync(slow, '/ { broken };\n');
      const reportQuickly = onOpen;
      onOpen = file => {
        if (file !== slow) {
          reportQuickly(file);
          return;
        }
        setTimeout(() => {
          problems.set(file, [{ severity: 0, message: 'syntax error', range: { start: { line: 0, character: 4 } }, source: 'dts-lsp' }]);
          listeners.forEach(listener => listener({ uris: [uriOf(file)] }));
        }, 600);
      };
      const started = Date.now();
      const result = await call({ source: 'last_build', open_files: [quick, slow] });
      const elapsed = Date.now() - started;
      assert.deepEqual(result.opened.map((entry: any) => entry.counts), [{ errors: 0, warnings: 1 }, { errors: 1, warnings: 0 }]);
      assert.ok(elapsed >= 600 && elapsed < 2500, `took ${elapsed} ms`);
    });

    it('does not let another file end the wait for a rewritten file VS Code reloads late', async () => {
      const other = path.join(appRoot, 'src', 'main.c');
      fs.writeFileSync(other, 'int x;\n');
      const overlay = path.join(appRoot, 'app.overlay');
      fs.writeFileSync(overlay, '/ { fixed; };\n');
      const doc = docOf(overlay, '/ { broken };\n');
      openDocs = [doc];
      const report = () => listeners.forEach(listener => listener({ uris: [uriOf(overlay)] }));
      problems.set(overlay, [{ severity: 0, message: 'syntax error', range: { start: { line: 0, character: 4 } }, source: 'dts-lsp' }]);
      report();
      // main.c reports at once; the overlay reloads just before that report
      // would have settled, and its server reports on the new text later.
      setTimeout(() => reload(doc, '/ { fixed; };\n'), 300);
      setTimeout(() => {
        problems.set(overlay, []);
        report();
      }, 700);
      const started = Date.now();
      const result = await call({ source: 'last_build', open_files: [other, overlay] });
      const elapsed = Date.now() - started;
      assert.deepEqual(result.opened[1].counts, { errors: 0, warnings: 0 });
      assert.equal(result.opened[1].note, undefined);
      assert.ok(elapsed >= 700 && elapsed < 2500, `took ${elapsed} ms`);
    });

    it('does not wait for a changed file nothing ever reported on, which may have no language server', async () => {
      const file = path.join(appRoot, 'prj.conf');
      fs.writeFileSync(file, 'CONFIG_LOG=y\n');
      const doc = docOf(file, 'CONFIG_LOG=y\n');
      doc.version = 3;
      openDocs = [doc];
      const started = Date.now();
      const result = await call({ source: 'last_build', open_files: [file] });
      assert.ok(Date.now() - started < 1000);
      assert.equal(result.opened[0].note, undefined);
    });

    it('reads a file in another encoding than UTF-8 the way VS Code read it, open or not', async () => {
      const open = path.join(appRoot, 'src', 'main.c');
      const fresh = path.join(appRoot, 'src', 'util.c');
      fs.writeFileSync(open, Buffer.from('/* caf\xE9 */\n', 'latin1'));
      fs.writeFileSync(fresh, Buffer.from('/* d\xE9j\xE0 */\n', 'latin1'));
      const windows1252 = (bytes: Uint8Array) => new TextDecoder('windows-1252').decode(bytes);
      const decodedWith: string[] = [];
      stub.workspace.decode = async (content: Uint8Array, options: { encoding: string }) => {
        decodedWith.push(options.encoding);
        assert.equal(options.encoding, 'windows1252');
        return windows1252(content);
      };
      openDocs = [docOf(open, '/* café */\n', false, 'windows1252')];
      readAs = file => docOf(file, windows1252(fs.readFileSync(file)), false, 'windows1252');
      const started = Date.now();
      const result = await call({ source: 'last_build', open_files: [open, fresh] });
      assert.deepEqual(result.opened.map((entry: any) => entry.note), [undefined, undefined]);
      assert.ok(Date.now() - started < 2500, 'the open file is not taken for one VS Code has yet to reload');
      assert.ok(decodedWith.length > 0);
      // A real change of such a file is still seen.
      fs.writeFileSync(open, Buffer.from('/* caf\xE9 au lait */\n', 'latin1'));
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const changed = await getDiagnostics({ source: 'last_build', open_files: [open] }, ctx(controller.signal)) as any;
      assert.match(changed.opened[0].note, /not reloaded this file from disk yet/);
    });

    it('does not take a file in another encoding for a changed one when VS Code does not tell its encoding', async () => {
      const latin1 = path.join(appRoot, 'src', 'main.c');
      fs.writeFileSync(latin1, Buffer.from('/* caf\xE9 */\n', 'latin1'));
      // UTF-8 bytes read as windows-1252, as the files.encoding setting says.
      const utf8 = path.join(appRoot, 'src', 'util.c');
      fs.writeFileSync(utf8, '/* café */\n');
      openDocs = [docOf(latin1, '/* café */\n'), docOf(utf8, '/* cafÃ© */\n')];
      const savedConfiguration = stub.workspace.getConfiguration;
      stub.workspace.getConfiguration = (section?: string) => ({
        get: (key: string) => (section === 'files' && key === 'encoding' ? 'windows1252' : undefined),
      });
      try {
        const started = Date.now();
        const result = await call({ source: 'last_build', open_files: [latin1, utf8] });
        assert.ok(Date.now() - started < 1000);
        assert.deepEqual(result.opened.map((entry: any) => entry.note), [undefined, undefined]);
      } finally {
        stub.workspace.getConfiguration = savedConfiguration;
      }
    });

    it('still sees a changed UTF-8 file with other than ASCII text when VS Code does not tell its encoding', async () => {
      const file = path.join(appRoot, 'src', 'main.c');
      fs.writeFileSync(file, '/* déjà vu */\n');
      openDocs = [docOf(file, '/* café */\n')];
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const result = await getDiagnostics({ source: 'last_build', open_files: [file] }, ctx(controller.signal)) as any;
      assert.match(result.opened[0].note, /not reloaded this file from disk yet/);
    });

    it('notes a file with unsaved changes in an editor, without waiting for a reload that never comes', async () => {
      const file = path.join(appRoot, 'app.overlay');
      fs.writeFileSync(file, '/ { fixed; };\n');
      openDocs = [docOf(file, '/ { edited };\n', true)];
      const started = Date.now();
      const result = await call({ source: 'last_build', open_files: [file] });
      assert.ok(Date.now() - started < 1000);
      assert.match(result.opened[0].note, /unsaved changes/);
    });

    it('notes that devicetree files get no check without the DTS language server', async () => {
      const overlay = path.join(appRoot, 'app.overlay');
      fs.writeFileSync(overlay, '/ { };\n');
      const result = await call({ source: 'last_build', open_files: [overlay] });
      assert.match(result.opened_note, /DTS LSP/);
      extensions['KyleMicallefBonnici.dts-lsp'] = {};
      assert.equal((await call({ source: 'last_build', open_files: [overlay] })).opened_note, undefined);
    });

    it('opens only existing files inside the application, at most ten', async () => {
      const outside = path.join(root, 'elsewhere.c');
      fs.writeFileSync(outside, '');
      const cases: [unknown, string][] = [
        [[outside], 'PATH_OUTSIDE_WORKSPACE'],
        [[path.join(appRoot, 'missing.c')], 'INVALID_ARGUMENT'],
        [['src/main.c'], 'INVALID_ARGUMENT'],
        [[path.join(appRoot, 'src')], 'INVALID_ARGUMENT'],
        [Array.from({ length: 11 }, (_, i) => path.join(appRoot, `f${i}.c`)), 'INVALID_ARGUMENT'],
      ];
      for (const [files, code] of cases) {
        assert.equal((await errorOf(call({ open_files: files }))).code, code, JSON.stringify(files));
      }
      assert.deepEqual(opened, []);
    });

    it('refuses a link that leads out of the application', async function () {
      const outside = path.join(root, 'secret.c');
      fs.writeFileSync(outside, '');
      try {
        fs.symlinkSync(outside, path.join(appRoot, 'linked.c'));
      } catch {
        this.skip();
      }
      assert.equal((await errorOf(call({ open_files: [path.join(appRoot, 'linked.c')] }))).code, 'PATH_OUTSIDE_WORKSPACE');
    });
  });
});
