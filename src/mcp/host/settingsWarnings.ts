// Keeps the notifications of the application settings writers away from
// agent calls.

import { collectSettingsWarnings } from '../../providers/ZephyrTaskProvider';
import { ToolHandler } from '../core/toolSpec';

/**
 * Run a handler with the warnings of the application settings writers (an
 * unreadable c_cpp_properties.json, a settings file that does not parse)
 * collected instead of shown as notifications nobody at the agent can see.
 * They are added to the answer's warnings; one raised after the call answered,
 * such as by a job still running, goes to the activity log.
 */
export function withSettingsWarnings<D>(
  handler: ToolHandler<D>,
  log: (line: string) => void,
  // Injected by tests; the workbench's own collector otherwise.
  collect: <T>(sink: string[], work: () => Promise<T>) => Promise<T> = collectSettingsWarnings,
): ToolHandler<D> {
  return async (args, ctx) => {
    const warnings: string[] = [];
    let answered = false;
    warnings.push = (...items: string[]) => {
      if (answered) {
        for (const item of items) {
          log(`${ctx.tool.name}: ${item}`);
        }
        return warnings.length;
      }
      return Array.prototype.push.apply(warnings, items);
    };
    let value: unknown;
    try {
      value = await collect(warnings, () => handler(args, ctx));
    } finally {
      answered = true;
    }
    if (warnings.length === 0 || !value || typeof value !== 'object' || Array.isArray(value)) {
      return value;
    }
    const existing = (value as { warnings?: unknown }).warnings;
    return { ...(value as object), warnings: [...(Array.isArray(existing) ? existing : []), ...warnings] };
  };
}
