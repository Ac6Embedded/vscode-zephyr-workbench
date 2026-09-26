import { strict as assert } from 'assert';
import { withSettingsWarnings } from '../../../mcp/host/settingsWarnings';

describe('mcp/host/settingsWarnings', () => {
  const ctx = { tool: { name: 'configure' } } as never;
  /** Stands in for the settings writers: warn() pushes to the sink of the call it runs in. */
  function collector() {
    let sink: string[] | undefined;
    return {
      collect: async <T>(warnings: string[], work: () => Promise<T>) => { sink = warnings; return work(); },
      warn: (message: string) => { sink?.push(message); },
    };
  }

  it('adds the warnings raised during the call to the answer', async () => {
    const writers = collector();
    const handler = withSettingsWarnings(async () => {
      writers.warn('c_cpp_properties.json could not be parsed');
      return { ok: true, warnings: ['earlier'] };
    }, () => undefined, writers.collect);
    const value = await handler({}, ctx) as { warnings: string[] };
    assert.deepEqual(value.warnings, ['earlier', 'c_cpp_properties.json could not be parsed']);
  });

  it('leaves an answer without warnings untouched', async () => {
    const writers = collector();
    const handler = withSettingsWarnings(async () => ({ ok: true }), () => undefined, writers.collect);
    assert.deepEqual(await handler({}, ctx), { ok: true });
  });

  it('logs a warning raised after the call answered, as a job still running would', async () => {
    const writers = collector();
    const logged: string[] = [];
    const handler = withSettingsWarnings(async () => ({ ok: true }), line => logged.push(line), writers.collect);
    const value = await handler({}, ctx) as Record<string, unknown>;
    writers.warn('late');
    assert.equal(value.warnings, undefined);
    assert.deepEqual(logged, ['configure: late']);
  });
});
