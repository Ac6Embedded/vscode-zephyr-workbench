// Asks the user before an agent does something they asked to approve first.
//
// The VS Code dialog is the one prompt an agent cannot answer for itself:
// tool-approval prompts in an agent, or MCP elicitation, may be answered by the
// client. So the dialog stays the gate, whatever the client does on its side.
//
// A dialog cannot be closed from code. When the call gives up waiting, the
// dialog stays open, and an answer given later is remembered for the identical
// call from the same agent session (see ConfirmPolicy), or for that whole
// session when it is Allow for This Session, so the agent can simply repeat it.

import * as vscode from 'vscode';
import { ConfirmPolicy, fingerprint } from '../core/confirmPolicy';
import { McpToolError } from '../core/errors';
import { logSafe } from '../core/redact';
import { AskCategory, confirmCategoryOf, ToolContext, ToolHandler, ToolMeta, ToolPermission } from '../core/toolSpec';

export interface ConfirmSubject {
  /** What will happen, in our words, completing "wants to ...": `delete the build folder of "primary"`. */
  summary: string;
  appPath?: string;
  configName?: string;
  board?: string;
  runner?: string;
  folder?: string;
  /**
   * What an approval for the session covers: the application root, the west
   * workspace root, or a fixed key such as "toolchains" for machine-wide actions.
   */
  scope: string;
  /** How the dialog names the scope, completing "actions on ...". Defaults to "this application". */
  scopeLabel?: string;
}

export type AskAnswer = 'allow' | 'session' | undefined;
export type AskFn = (message: string, detail: string, offerSession: boolean) => PromiseLike<AskAnswer>;

export type ConfirmOutcome = 'not-required' | 'not-asked' | 'allowed' | 'allowed-session' | 'remembered';

/** How each category reads in "...before <text> actions". */
const CATEGORY_TEXT: Record<AskCategory, string> = {
  hardware: 'serial send',
  delete: 'remove and delete',
  workspace: 'application and west workspace',
  install: 'install',
  settings: 'settings',
  call: 'these',
};

const HEARTBEAT_MS = 5000;

function defaultAsk(message: string, detail: string, offerSession: boolean): PromiseLike<AskAnswer> {
  const allow = 'Allow';
  const session = 'Allow for This Session';
  const buttons = offerSession ? [allow, session] : [allow];
  return vscode.window.showWarningMessage(message, { modal: true, detail }, ...buttons)
    .then(choice => (choice === allow ? 'allow' : choice === session ? 'session' : undefined));
}

export interface ConfirmationsOptions {
  /** What the user lets agents do with a tool, read on every call: only Ask asks. */
  permission(tool: ToolMeta): ToolPermission;
  /** The longest one call waits for an answer. */
  waitMs(): number;
  log: { recordConfirmation(event: { message: string; client?: string; tool?: string; category?: string; outcome?: string }): void };
  /** Something the status bar or the AI Manager shows has changed. */
  onDidChange?(): void;
  ask?: AskFn;
  now?(): number;
}

/**
 * What a dialog comes to: the user's answer, or why it was never shown:
 * 'skipped' when nobody wants it any more, 'granted' when an Allow for This
 * Session given meanwhile already covers it.
 */
type DialogOutcome = AskAnswer | 'skipped' | 'granted';

interface Dialog {
  answer: Promise<DialogOutcome>;
  /** Set once a waiting call has taken the answer, so it is not also stored as a late one. */
  taken: boolean;
  /** Calls waiting on it right now. */
  waiters: number;
  /**
   * Set when a call stopped waiting because its time ran out. Its agent was
   * told to have the user answer and then repeat the call, so the dialog is
   * still wanted even though nobody waits on it.
   */
  outlived: boolean;
  /** On screen, rather than still queued behind another dialog. */
  shown: boolean;
  /** Its Allow for This Session was stored as a session approval. */
  sessionGranted: boolean;
}

export class Confirmations {
  private readonly policy: ConfirmPolicy;
  private readonly dialogs = new Map<string, Dialog>();
  /** One dialog at a time per window: a second one waits for the first to close. */
  private slot: Promise<unknown> = Promise.resolve();
  private waiting: { tool: string; since: number } | undefined;

  constructor(private readonly options: ConfirmationsOptions) {
    this.policy = new ConfirmPolicy(options.now ?? Date.now);
  }

  /** A dialog the user has not answered yet, for the status bar and the AI Manager. */
  get pending(): { tool: string; since: number } | undefined {
    return this.waiting;
  }

  get sessionApprovals(): number {
    return this.policy.sessionGrants().length;
  }

  /** Forget every approval and remembered answer. */
  clear(reason: string): void {
    const approvals = this.policy.sessionGrants().length;
    this.policy.clear();
    if (approvals > 0) {
      this.options.log.recordConfirmation({ message: `forgot ${approvals} session approval(s): ${reason}`, outcome: 'cleared' });
    }
    this.options.onDidChange?.();
  }

  /**
   * Resolve when the call may go ahead, or throw USER_DENIED or
   * CONFIRMATION_TIMEOUT. Call it after every check that can refuse the call
   * on its own, and after a dry run has returned, so the user is only asked
   * about something that would really happen.
   */
  async require(
    ctx: ToolContext<unknown>, args: Record<string, unknown>, subject: ConfirmSubject,
    options: {
      /**
       * Ask even when the user turned this category off, and never offer or
       * use Allow for This Session: for an action that accepts something on
       * the user's behalf, such as click-through licenses.
       */
      always?: boolean;
      /**
       * Ask about the call itself, for a tool with no action that changes
       * anything, which the user set to Ask before each use.
       */
      call?: boolean;
    } = {},
  ): Promise<ConfirmOutcome> {
    ctx.audit.target = {
      app_path: subject.appPath, config_name: subject.configName, folder: subject.folder, runner: subject.runner,
    };
    const category: AskCategory | undefined = options.call ? 'call' : confirmCategoryOf(ctx.tool, args);
    if (!category) {
      ctx.audit.confirmation = 'not-required';
      return 'not-required';
    }
    ctx.audit.confirmCategory = category;
    const always = options.always === true;
    if (!always && this.options.permission(ctx.tool) !== 'ask') {
      // Still audited: a destructive action taken without asking stays visible.
      ctx.audit.confirmation = 'not-asked';
      return 'not-asked';
    }

    const tool = ctx.tool.name;
    // Before any remembered answer is looked at: a call nobody waits for any
    // more must neither put a dialog in front of the user nor use up an
    // approval and then act.
    if (ctx.signal.aborted) {
      ctx.audit.confirmation = 'cancelled';
      throw this.cancelled(tool, category);
    }
    const agent = ctx.client.instance ?? (ctx.client.name ? `${ctx.client.name}@${ctx.client.version ?? ''}` : undefined);
    // The agent is part of "the same call": a dialog names one agent, so the
    // dialog, and any answer to it given in time or late, belong to that
    // agent session alone. Callers with no identity share one key, and their
    // dialogs never offer Allow for This Session.
    const key = fingerprint(tool, category, { agent, subject: { ...subject, summary: undefined }, always });
    if (this.policy.isRecentlyDenied(key)) {
      ctx.audit.confirmation = 'denied';
      throw this.denied(tool, category);
    }
    if (this.policy.takeLateAllow(key) || (!always && this.policy.hasSessionGrant(agent, category, subject.scope))) {
      ctx.audit.confirmation = 'remembered';
      return 'remembered';
    }

    const generation = this.policy.currentGeneration;
    const dialog = this.dialogs.get(key) ?? this.open(key, ctx, category, subject, always ? undefined : agent, generation, always);
    const waitMs = Math.max(1000, this.options.waitMs());
    const result = await this.await(dialog, ctx, waitMs);

    // Allow for This Session, given to another dialog of this agent while
    // this one was queued, already covers the call.
    if (result.kind === 'answer' && result.answer === 'granted') {
      ctx.audit.confirmation = 'remembered';
      return 'remembered';
    }
    // A skipped dialog never reaches a waiting call: it is skipped only when
    // nobody waits on it, and it leaves `dialogs` at once so nobody joins it.
    if (result.kind === 'answer' && result.answer !== 'skipped') {
      const first = !dialog.taken;
      dialog.taken = true;
      if (result.answer === 'session' && dialog.sessionGranted) {
        if (first) {
          this.options.log.recordConfirmation({
            message: `approved ${CATEGORY_TEXT[category]} actions on ${subject.scope} for this session`,
            client: ctx.client.name, tool, category, outcome: 'allowed-session',
          });
        }
        ctx.audit.confirmation = 'allowed-session';
        return 'allowed-session';
      }
      // An Allow for This Session that cannot be kept, because the caller has
      // no identity or approvals were cleared while the dialog was open, still
      // allows this call: an Allow must never become a refusal.
      if (result.answer === 'allow' || result.answer === 'session') {
        ctx.audit.confirmation = 'allowed';
        return 'allowed';
      }
      this.policy.rememberDeny(key, generation);
      ctx.audit.confirmation = 'denied';
      throw this.denied(tool, category);
    }

    ctx.audit.confirmation = result.kind === 'aborted' ? 'cancelled' : 'timeout';
    throw new McpToolError('CONFIRMATION_TIMEOUT',
      `Nobody answered the confirmation for ${tool} in VS Code within ${Math.round(waitMs / 1000)} seconds.`, {
        hint: dialog.shown
          ? 'The dialog is still open in VS Code. Ask the user to answer it, then repeat the identical request: an Allow given meanwhile is used by it for 5 minutes.'
          : 'The confirmation is queued behind another dialog in VS Code. Ask the user to answer the open dialogs, then repeat the identical request: an Allow given meanwhile is used by it for 5 minutes.',
        details: { category, waited_seconds: Math.round(waitMs / 1000) },
      });
  }

  private cancelled(tool: string, category: AskCategory): McpToolError {
    return new McpToolError('CONFIRMATION_TIMEOUT', `The call to ${tool} was cancelled before the user was asked in VS Code, so nothing was changed.`, {
      hint: 'Repeat the identical request if it is still wanted: the user is asked then.',
      details: { category, cancelled: true },
    });
  }

  private denied(tool: string, category: AskCategory): McpToolError {
    return new McpToolError('USER_DENIED', `The user declined ${tool} in VS Code.`, {
      hint: 'Do not repeat this action unless the user asks for it. Tell the user what you wanted to do and why.',
      details: { category },
    });
  }

  /** Queue a dialog behind any open one, and remember an answer that comes after the call gave up. */
  private open(
    key: string, ctx: ToolContext<unknown>, category: AskCategory, subject: ConfirmSubject,
    agent: string | undefined, generation: number, always = false,
  ): Dialog {
    // Only an agent session can be approved for the session.
    const offerSession = !!agent;
    const who = ctx.client.name ? `The AI agent "${logSafe(ctx.client.name, 64)}"` : 'An AI agent';
    const message = `${who} wants to ${subject.summary}.`;
    const detail = [
      ctx.client.name ? `Agent: ${logSafe(ctx.client.name, 64)}${ctx.client.version ? ` ${logSafe(ctx.client.version, 32)}` : ''} (the name the agent reports)` : undefined,
      `Tool: ${ctx.tool.name}`,
      subject.appPath ? `Application: ${subject.appPath}` : undefined,
      subject.configName ? `Configuration: ${subject.configName}${subject.board ? ` (board ${subject.board})` : ''}` : undefined,
      subject.runner ? `Runner: ${subject.runner}` : undefined,
      subject.folder ? `Folder: ${subject.folder}` : undefined,
      '',
      (always
        ? 'You are always asked before this action, whatever the Permissions of the AI Manager say.'
        : `You are asked because ${ctx.tool.name} is set to Ask in the Permissions of the AI Manager.`)
        + (offerSession
          ? ` Allow for This Session stops asking this agent before ${category === 'call'
            ? `it uses ${ctx.tool.name}`
            : `${CATEGORY_TEXT[category]} actions on ${subject.scopeLabel ?? 'this application'}`} until the MCP server restarts.`
          : ''),
    ].filter((line): line is string => line !== undefined).join('\n');

    const ask = this.options.ask ?? defaultAsk;
    const answer = this.slot.then((): DialogOutcome | PromiseLike<DialogOutcome> => {
      // The user chose Allow for This Session for this agent and application
      // while this dialog was queued: it promised not to ask again.
      if (agent && this.policy.hasSessionGrant(agent, category, subject.scope)) {
        this.detach(key, dialog);
        return 'granted';
      }
      // Nobody waits on this dialog any more, and either every call that
      // wanted it was cancelled while it was queued, or approvals were
      // cleared since (the server stopped, the setting changed, or the user
      // forgot them), so a late answer could not be kept. Showing it would ask
      // about something nobody waits for; for a cancelled call, an Allow would
      // arm the very call the agent gave up.
      if (dialog.waiters === 0 && (!dialog.outlived || generation !== this.policy.currentGeneration)) {
        this.detach(key, dialog);
        return 'skipped';
      }
      dialog.shown = true;
      this.waiting = { tool: ctx.tool.name, since: Date.now() };
      this.options.onDidChange?.();
      return ask(message, detail, offerSession);
    }).then(
      value => {
        // Stored as soon as the answer arrives, whether or not a call still
        // waits: the dialog promised that this button stops asking the agent,
        // and a dialog queued behind this one that the approval covers must
        // find it when its turn comes. Before the `finally` below, so the
        // change that fires already counts it.
        if (value === 'session' && agent) {
          dialog.sessionGranted = this.policy.grantSession(agent, category, subject.scope, generation);
        }
        return value;
      },
      () => undefined,
    ).finally(() => {
      this.waiting = undefined;
      this.detach(key, dialog);
      this.options.onDidChange?.();
    });
    this.slot = answer;
    const dialog: Dialog = { answer, taken: false, waiters: 0, outlived: false, shown: false, sessionGranted: false };
    this.dialogs.set(key, dialog);

    // Checked a turn later, after any waiting call has taken the answer.
    void answer.then(value => setImmediate(() => {
      if (dialog.taken || value === 'skipped' || value === 'granted') {
        return;
      }
      if (value === 'session' && dialog.sessionGranted) {
        this.options.log.recordConfirmation({
          message: `approved ${CATEGORY_TEXT[category]} actions on ${subject.scope} for this session (answered after the call stopped waiting)`,
          client: ctx.client.name, tool: ctx.tool.name, category, outcome: 'allowed-session',
        });
        return;
      }
      const allowed = value !== undefined;
      const kept = allowed ? this.policy.rememberLateAllow(key, generation) : this.policy.rememberDeny(key, generation);
      const answered = allowed ? 'allowed' : 'declined';
      // Only claim what was kept: an answer to a dialog opened before a clear is dropped.
      this.options.log.recordConfirmation({
        message: kept
          ? `${ctx.tool.name} was answered after the call stopped waiting: ${answered}`
          : `${ctx.tool.name} was answered after the call stopped waiting, but approvals were cleared meanwhile, so the answer was not kept: ${answered}`,
        client: ctx.client.name, tool: ctx.tool.name, category,
        outcome: !kept ? 'ignored-late' : allowed ? 'allowed-late' : 'denied-late',
      });
    }));
    return dialog;
  }

  /** Stop new calls joining a dialog, unless another one already took its key. */
  private detach(key: string, dialog: Dialog): void {
    if (this.dialogs.get(key) === dialog) {
      this.dialogs.delete(key);
    }
  }

  /** Wait for the answer, the timeout or the agent giving up, whichever is first. */
  private await(dialog: Dialog, ctx: ToolContext<unknown>, waitMs: number):
    Promise<{ kind: 'answer'; answer: DialogOutcome } | { kind: 'timeout' } | { kind: 'aborted' }> {
    return new Promise(resolve => {
      let pulse: NodeJS.Timeout | undefined;
      let settled = false;
      // Counted from here, in the same turn the call found or opened the
      // dialog, so the queue never sees a dialog with a caller not yet counted.
      dialog.waiters++;
      const done = (value: { kind: 'answer'; answer: DialogOutcome } | { kind: 'timeout' } | { kind: 'aborted' }) => {
        if (settled) {
          // The answer can still arrive after a timeout or an abort.
          return;
        }
        settled = true;
        dialog.waiters--;
        if (value.kind === 'timeout') {
          dialog.outlived = true;
        }
        clearTimeout(timer);
        if (pulse) {
          clearInterval(pulse);
        }
        ctx.signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => done({ kind: 'aborted' });
      const timer = setTimeout(() => done({ kind: 'timeout' }), waitMs);
      // Keeps the agent's idle timer alive, and tells it what it is waiting for.
      pulse = setInterval(() => ctx.progress({
        progress: Math.round((Date.now() - ctx.startedAt) / 1000),
        message: 'Waiting for the user to answer in VS Code',
      }), HEARTBEAT_MS);
      if (ctx.signal.aborted) {
        done({ kind: 'aborted' });
        return;
      }
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      void dialog.answer.then(answer => done({ kind: 'answer', answer }));
    });
  }
}

/**
 * Ask before each use of a tool that never asks on its own, such as build_app
 * or a query, when the user set it to Ask. A tool with actions that change
 * something asks itself, at the point where the change would happen, and only
 * before those actions, so it is returned as it is.
 */
export function withAskBeforeUse<S extends { confirmations: Confirmations }>(meta: ToolMeta, handler: ToolHandler<S>): ToolHandler<S> {
  if (meta.confirm !== undefined) {
    return handler;
  }
  const what = meta.summary.replace(/\.$/, '');
  return async (args, ctx) => {
    await ctx.deps.confirmations.require(ctx, args, {
      summary: `use ${meta.name} (${what.charAt(0).toLowerCase()}${what.slice(1)})`,
      appPath: typeof args.app_path === 'string' ? args.app_path : undefined,
      configName: typeof args.config_name === 'string' ? args.config_name : undefined,
      scope: meta.name,
      scopeLabel: meta.name,
    }, { call: true });
    return handler(args, ctx);
  };
}

