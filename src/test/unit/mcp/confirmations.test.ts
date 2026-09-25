import { strict as assert } from 'assert';
import { z } from 'zod';
import { ConfirmPolicy, fingerprint, LATE_ALLOW_TTL_MS } from '../../../mcp/core/confirmPolicy';
import { McpToolError } from '../../../mcp/core/errors';
import { AuditBag, ConfirmCategory, ToolContext, ToolMeta } from '../../../mcp/core/toolSpec';
import { AskAnswer, Confirmations } from '../../../mcp/host/confirmations';

const TOOL: ToolMeta = {
  name: 'remove_or_delete', title: 't', description: 'd', inputSchema: z.object({}),
  annotations: { destructiveHint: true, openWorldHint: false }, category: 'action', toolsets: [], confirm: 'delete',
};

function context(over: Partial<ToolContext<unknown>> = {}): ToolContext<unknown> & { progressed: number } {
  const ctx = {
    signal: new AbortController().signal,
    progress: () => { ctx.progressed++; },
    client: { name: 'claude-code', version: '2', instance: 'session-1' },
    deps: {},
    tool: TOOL,
    startedAt: Date.now(),
    audit: {} as AuditBag,
    progressed: 0,
    ...over,
  };
  return ctx;
}

const SUBJECT = { summary: 'delete the build folder of "primary"', appPath: '/ws/app', configName: 'primary', scope: '/ws/app' };

/** A second agent session in the same window, from another client. */
const COPILOT = { name: 'copilot', version: '1', instance: 'session-2' };

function tick(ms = 20): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function harness(answers: (AskAnswer | 'never')[], categories: ConfirmCategory[] = ['delete'], waitMs = 200) {
  const asked: string[] = [];
  const pending: ((answer: AskAnswer) => void)[] = [];
  const log: string[] = [];
  /** The number of session approvals each time the AI Manager is told something changed. */
  const changes: number[] = [];
  const confirmations: Confirmations = new Confirmations({
    categories: () => categories,
    waitMs: () => waitMs,
    log: { recordConfirmation: event => log.push(`${event.outcome}: ${event.message}`) },
    onDidChange: () => changes.push(confirmations.sessionApprovals),
    ask: message => {
      asked.push(message);
      const answer = answers.shift();
      return new Promise<AskAnswer>(resolve => {
        if (answer === 'never') {
          pending.push(resolve);
        } else {
          setTimeout(() => resolve(answer), 5);
        }
      });
    },
  });
  return { confirmations, asked, pending, log, changes };
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  return (await failure(promise))?.code;
}

async function failure(promise: Promise<unknown>): Promise<McpToolError | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error as McpToolError;
  }
}

function cancelledSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

describe('mcp/core/confirmPolicy', () => {
  it('keys a call by tool, category and what it acts on, whatever the key order', () => {
    assert.equal(fingerprint('t', 'delete', { a: 1, b: 2 }), fingerprint('t', 'delete', { b: 2, a: 1 }));
    assert.notEqual(fingerprint('t', 'delete', { a: 1 }), fingerprint('t', 'hardware', { a: 1 }));
  });

  it('uses a late approval once, and not after it expires', () => {
    let now = 0;
    const policy = new ConfirmPolicy(() => now);
    policy.rememberLateAllow('k', policy.currentGeneration);
    assert.equal(policy.takeLateAllow('k'), true);
    assert.equal(policy.takeLateAllow('k'), false, 'one use only');
    policy.rememberLateAllow('k', policy.currentGeneration);
    now += LATE_ALLOW_TTL_MS + 1;
    assert.equal(policy.takeLateAllow('k'), false);
  });

  it('drops answers to dialogs opened before a clear', () => {
    const policy = new ConfirmPolicy();
    const before = policy.currentGeneration;
    policy.clear();
    assert.equal(policy.rememberLateAllow('k', before), false, 'says it kept nothing');
    assert.equal(policy.rememberDeny('d', before), false);
    assert.equal(policy.grantSession('agent', 'delete', '/ws', before), false);
    assert.equal(policy.takeLateAllow('k'), false);
    assert.equal(policy.isRecentlyDenied('d'), false);
    assert.equal(policy.rememberLateAllow('k', policy.currentGeneration), true);
    assert.equal(policy.rememberDeny('d', policy.currentGeneration), true);
  });
});

describe('mcp/host/confirmations', () => {
  it('always asks when told to, even for a category the user turned off, and never for the session', async () => {
    const offers: boolean[] = [];
    const confirmations = new Confirmations({
      categories: () => [],
      waitMs: () => 200,
      log: { recordConfirmation: () => undefined },
      ask: (_message, detail, offerSession) => {
        offers.push(offerSession);
        assert.match(detail, /always asked/);
        return Promise.resolve<AskAnswer>('allow');
      },
    });
    assert.equal(await confirmations.require(context(), {}, SUBJECT, { always: true }), 'allowed');
    // An Allow never carries over to the next call.
    assert.equal(await confirmations.require(context(), {}, SUBJECT, { always: true }), 'allowed');
    assert.deepEqual(offers, [false, false]);
    assert.equal(await confirmations.require(context(), {}, SUBJECT), 'not-asked');
  });

  it('does not ask for a category the user did not choose, but audits it', async () => {
    const { confirmations, asked } = harness([], ['hardware']);
    const ctx = context();
    assert.equal(await confirmations.require(ctx, {}, SUBJECT), 'not-asked');
    assert.equal(asked.length, 0);
    assert.equal(ctx.audit.confirmation, 'not-asked');
    assert.equal(ctx.audit.confirmCategory, 'delete');
  });

  it('asks, naming the agent and what it wants to do', async () => {
    const { confirmations, asked } = harness(['allow']);
    assert.equal(await confirmations.require(context(), {}, SUBJECT), 'allowed');
    assert.match(asked[0], /The AI agent "claude-code" wants to delete the build folder of "primary"/);
  });

  it('refuses, and does not ask again for the identical call for a minute', async () => {
    const { confirmations, asked } = harness([undefined]);
    assert.equal(await code(confirmations.require(context(), {}, SUBJECT)), 'USER_DENIED');
    assert.equal(await code(confirmations.require(context(), {}, SUBJECT)), 'USER_DENIED');
    assert.equal(asked.length, 1);
  });

  it('remembers Allow for This Session for that agent session and application only', async () => {
    const { confirmations, asked } = harness(['session', 'allow']);
    assert.equal(await confirmations.require(context(), {}, SUBJECT), 'allowed-session');
    assert.equal(await confirmations.require(context(), {}, { ...SUBJECT, configName: 'other' }), 'remembered');
    assert.equal(asked.length, 1);
    const otherSession = context({ client: { name: 'claude-code', version: '2', instance: 'session-2' } });
    assert.equal(await confirmations.require(otherSession, {}, SUBJECT), 'allowed', 'another session must be asked');
    assert.equal(asked.length, 2);
    confirmations.clear('test');
    assert.equal(confirmations.sessionApprovals, 0);
  });

  it('times out while the dialog stays open, then honours a late Allow once', async () => {
    const { confirmations, pending, log } = harness(['never'], ['delete'], 100);
    assert.equal(await code(confirmations.require(context(), {}, SUBJECT)), 'CONFIRMATION_TIMEOUT');
    assert.ok(confirmations.pending, 'the dialog is still open');
    pending[0]('allow');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(log.join('\n'), /allowed-late/);
    assert.equal(await confirmations.require(context(), {}, SUBJECT), 'remembered');
  });

  it('keeps a late Allow for This Session as a session approval', async () => {
    const { confirmations, asked, pending, log, changes } = harness(['never'], ['delete'], 100);
    assert.equal(await code(confirmations.require(context(), {}, SUBJECT)), 'CONFIRMATION_TIMEOUT');
    pending[0]('session');
    await tick();
    assert.equal(confirmations.sessionApprovals, 1);
    assert.equal(changes[changes.length - 1], 1, 'the AI Manager hears about the approval');
    assert.match(log.join('\n'), /allowed-session: .*answered after the call stopped waiting/);
    assert.equal(await confirmations.require(context(), {}, { ...SUBJECT, configName: 'other' }), 'remembered');
    assert.equal(await confirmations.require(context(), {}, SUBJECT), 'remembered');
    assert.equal(asked.length, 1, 'the dialog promised not to ask this agent again');
  });

  it('does not show a queued dialog that Allow for This Session already covers', async () => {
    const { confirmations, asked } = harness(['session', 'allow']);
    const results = await Promise.all([
      confirmations.require(context(), {}, SUBJECT),
      confirmations.require(context(), {}, { ...SUBJECT, configName: 'other' }),
    ]);
    assert.deepEqual(results, ['allowed-session', 'remembered']);
    assert.equal(asked.length, 1);
  });

  it('shows one dialog for identical calls made at the same time', async () => {
    const { confirmations, asked } = harness(['allow']);
    const results = await Promise.all([
      confirmations.require(context(), {}, SUBJECT),
      confirmations.require(context(), {}, SUBJECT),
    ]);
    assert.deepEqual(results, ['allowed', 'allowed']);
    assert.equal(asked.length, 1);
  });

  it('stops waiting when the agent gives up', async () => {
    const { confirmations } = harness(['never'], ['delete'], 5000);
    const controller = new AbortController();
    const ctx = context({ signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    assert.equal(await code(confirmations.require(ctx, {}, SUBJECT)), 'CONFIRMATION_TIMEOUT');
    assert.equal(ctx.audit.confirmation, 'cancelled');
  });

  it('asks nothing for a call cancelled before it reached the dialog', async () => {
    const { confirmations, asked, log } = harness(['allow', 'allow']);
    const ctx = context({ signal: cancelledSignal() });
    const error = await failure(confirmations.require(ctx, {}, SUBJECT));
    assert.equal(error?.code, 'CONFIRMATION_TIMEOUT');
    assert.equal(error?.details?.cancelled, true);
    assert.doesNotMatch(error?.hint ?? '', /still open/, 'no dialog was opened');
    assert.equal(ctx.audit.confirmation, 'cancelled');
    await tick();
    assert.equal(asked.length, 0, 'no modal for a call nobody waits for');
    assert.equal(confirmations.pending, undefined);
    assert.equal(log.length, 0);
    assert.equal(await confirmations.require(context(), {}, SUBJECT), 'allowed', 'nothing was armed for the next call');
  });

  it('does not let a cancelled call use up a late Allow', async () => {
    const { confirmations, pending } = harness(['never'], ['delete'], 100);
    assert.equal(await code(confirmations.require(context(), {}, SUBJECT)), 'CONFIRMATION_TIMEOUT');
    pending[0]('allow');
    await tick();
    const cancelled = context({ signal: cancelledSignal() });
    assert.equal(await code(confirmations.require(cancelled, {}, SUBJECT)), 'CONFIRMATION_TIMEOUT');
    assert.equal(cancelled.audit.confirmation, 'cancelled');
    assert.equal(await confirmations.require(context(), {}, SUBJECT), 'remembered', 'the repeat still finds it');
  });

  it('drops a queued dialog when every call waiting on it was cancelled', async () => {
    const { confirmations, asked, pending, log } = harness(['never', 'allow'], ['delete'], 5000);
    const first = confirmations.require(context(), {}, SUBJECT);
    const controller = new AbortController();
    const second = confirmations.require(context({ signal: controller.signal }), {}, { ...SUBJECT, configName: 'other' });
    await tick(10);
    assert.equal(asked.length, 1, 'the second dialog waits behind the first');
    controller.abort();
    assert.equal(await code(second), 'CONFIRMATION_TIMEOUT');
    pending[0]('allow');
    assert.equal(await first, 'allowed');
    await tick();
    assert.equal(asked.length, 1, 'the cancelled call never shows its dialog');
    assert.doesNotMatch(log.join('\n'), /late/);
  });

  it('says whether a call that timed out has its dialog on screen or still queued', async () => {
    const { confirmations, asked } = harness(['never', 'never'], ['delete'], 100);
    const errors = await Promise.all([
      failure(confirmations.require(context(), {}, SUBJECT)),
      failure(confirmations.require(context(), {}, { ...SUBJECT, configName: 'other' })),
    ]);
    assert.deepEqual(errors.map(error => error?.code), ['CONFIRMATION_TIMEOUT', 'CONFIRMATION_TIMEOUT']);
    assert.equal(asked.length, 1);
    assert.match(errors[0]?.hint ?? '', /still open/);
    assert.match(errors[1]?.hint ?? '', /queued behind another dialog/);
  });

  it('still shows a queued dialog whose call timed out, so a late answer works', async () => {
    const { confirmations, asked, pending } = harness(['never', 'allow'], ['delete'], 100);
    const other = { ...SUBJECT, configName: 'other' };
    await Promise.all([
      failure(confirmations.require(context(), {}, SUBJECT)),
      failure(confirmations.require(context(), {}, other)),
    ]);
    pending[0](undefined);
    await tick(40);
    assert.equal(asked.length, 2);
    assert.equal(await confirmations.require(context(), {}, other), 'remembered');
  });

  it('drops queued dialogs nobody waits for once approvals are cleared, and logs no approval it did not keep', async () => {
    const { confirmations, asked, pending, log } = harness(['never', 'never'], ['delete'], 100);
    await Promise.all([
      failure(confirmations.require(context(), {}, SUBJECT)),
      failure(confirmations.require(context(), {}, { ...SUBJECT, configName: 'other' })),
    ]);
    confirmations.clear('the MCP server stopped');
    pending[0]('allow');
    await tick(40);
    assert.equal(asked.length, 1, 'the queued dialog is never shown');
    assert.equal(confirmations.pending, undefined);
    assert.doesNotMatch(log.join('\n'), /allowed-late/);
    assert.match(log.join('\n'), /ignored-late: .*not kept/);
  });

  it('still asks for a call that waits while approvals are cleared, but grants no session', async () => {
    const { confirmations, asked, pending, log } = harness(['never', 'never'], ['delete'], 5000);
    const first = confirmations.require(context(), {}, SUBJECT);
    const second = confirmations.require(context(), {}, { ...SUBJECT, configName: 'other' });
    await tick(10);
    confirmations.clear('the confirmActions setting changed');
    pending[0]('session');
    assert.equal(await first, 'allowed', 'the answer allows the call it was given for');
    await tick();
    assert.equal(confirmations.sessionApprovals, 0);
    assert.doesNotMatch(log.join('\n'), /allowed-session/);
    assert.equal(asked.length, 2, 'a call still waiting keeps its dialog');
    pending[1]('allow');
    assert.equal(await second, 'allowed');
  });

  it('asks another agent session separately for the same call made at the same time', async () => {
    const { confirmations, asked } = harness(['session', 'allow']);
    const results = await Promise.all([
      confirmations.require(context(), {}, SUBJECT),
      confirmations.require(context({ client: COPILOT }), {}, SUBJECT),
    ]);
    assert.deepEqual(results, ['allowed-session', 'allowed']);
    assert.equal(asked.length, 2, 'each dialog names the agent it is for');
    assert.match(asked[1], /"copilot"/);
    assert.equal(confirmations.sessionApprovals, 1, 'only the agent the user approved gets the session');
  });

  it('keeps a late Allow for the agent session that was asked', async () => {
    const { confirmations, asked, pending } = harness(['never', 'allow'], ['delete'], 100);
    assert.equal(await code(confirmations.require(context(), {}, SUBJECT)), 'CONFIRMATION_TIMEOUT');
    pending[0]('allow');
    await tick();
    assert.equal(await confirmations.require(context({ client: COPILOT }), {}, SUBJECT), 'allowed', 'another session must be asked');
    assert.equal(asked.length, 2);
    assert.equal(await confirmations.require(context(), {}, SUBJECT), 'remembered');
  });

  it('keeps a refusal to the agent session that was refused', async () => {
    const { confirmations, asked } = harness([undefined, 'allow']);
    assert.equal(await code(confirmations.require(context(), {}, SUBJECT)), 'USER_DENIED');
    assert.equal(await confirmations.require(context({ client: COPILOT }), {}, SUBJECT), 'allowed');
    assert.equal(asked.length, 2);
  });

  it('never turns Allow for This Session into a refusal for a caller with no identity', async () => {
    const { confirmations, asked } = harness(['session', 'allow', 'session']);
    const anonymous = () => context({ client: {} });
    const results = await Promise.all([
      confirmations.require(context(), {}, SUBJECT),
      confirmations.require(anonymous(), {}, SUBJECT),
    ]);
    assert.deepEqual(results, ['allowed-session', 'allowed']);
    assert.equal(asked.length, 2);
    assert.equal(await confirmations.require(context(), {}, SUBJECT), 'remembered', 'the approved agent is not blocked');
    // Even an answer the anonymous dialog does not offer allows the call.
    assert.equal(await confirmations.require(anonymous(), {}, { ...SUBJECT, configName: 'other' }), 'allowed');
  });

  it('asks nothing for a tool that has no category', async () => {
    const { confirmations, asked } = harness([]);
    const ctx = context({ tool: { ...TOOL, confirm: undefined } });
    assert.equal(await confirmations.require(ctx, {}, SUBJECT), 'not-required');
    assert.equal(asked.length, 0);
  });
});
