// The error contract every tool shares. Each code carries a hint naming the
// next tool to call, because agents self-correct from codes far better than
// from prose.

export type McpErrorCode =
  | 'WORKBENCH_NOT_RUNNING'
  | 'AMBIGUOUS_WINDOW'
  | 'APP_NOT_FOUND'
  | 'AMBIGUOUS_APP'
  | 'CONFIG_NOT_FOUND'
  | 'NOT_BUILT'
  | 'BUILD_NOT_CONFIGURED'
  | 'ENV_NOT_READY'
  | 'BUSY'
  | 'BUSY_EXTERNAL'
  | 'RUNNER_UNKNOWN'
  | 'RUNNER_TOOL_MISSING'
  | 'SYSBUILD_UNSUPPORTED'
  | 'INTERACTIVE_UNSUPPORTED'
  | 'INVALID_ARGUMENT'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'USER_DENIED'
  | 'CONFIRMATION_TIMEOUT'
  | 'TOOL_DISABLED'
  | 'DEPENDENCY_MISSING'
  | 'JOB_NOT_FOUND'
  | 'TIMEOUT'
  | 'INTERNAL';

export interface McpErrorBody {
  code: McpErrorCode;
  message: string;
  hint?: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

/** Codes where retrying the identical call can succeed without user action. */
const RETRYABLE = new Set<McpErrorCode>([
  'WORKBENCH_NOT_RUNNING',
  'BUSY',
  'BUSY_EXTERNAL',
  'CONFIRMATION_TIMEOUT',
  'TIMEOUT',
]);

export class McpToolError extends Error {
  readonly code: McpErrorCode;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;
  private readonly retryableOverride?: boolean;

  constructor(code: McpErrorCode, message: string, options: {
    hint?: string;
    details?: Record<string, unknown>;
    /** For the rare case where the code's usual answer is wrong, such as a window that can never serve. */
    retryable?: boolean;
  } = {}) {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
    this.retryableOverride = options.retryable;
  }

  get retryable(): boolean {
    return this.retryableOverride ?? RETRYABLE.has(this.code);
  }

  toBody(): McpErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/** Wrap anything thrown by reused workbench code into the tool error contract. */
export function toToolError(error: unknown): McpToolError {
  if (error instanceof McpToolError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  // `ZephyrTaskProvider.resolve` throws with `cause` set to the setting key when
  // the environment script is missing, which is the single most common setup gap.
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  if (typeof cause === 'string' && cause.includes('pathToEnvScript')) {
    return new McpToolError('ENV_NOT_READY', message, {
      hint: 'The Zephyr host tools are not installed, or zephyr-workbench.pathToEnvScript is not set. Call check_environment to see exactly what is missing and which Zephyr Workbench command fixes it, then ask the user to run that command (usually "Install Host Tools") and retry.',
    });
  }
  if (/west workspace application is not linked|Select a West workspace application/i.test(message)) {
    return new McpToolError('APP_NOT_FOUND', message, {
      hint: 'Call list_apps and pass an app_path it returned.',
    });
  }
  return new McpToolError('INTERNAL', message);
}
