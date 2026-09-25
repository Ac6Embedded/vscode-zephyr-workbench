// Argument shapes and result shapes shared by several tool definitions.

import { z } from 'zod';

export const appPath = z.string().optional().describe(
  'Absolute application root as returned by list_apps; a file or folder inside an application also selects it. Omit it when the window has a single application.');
export const configName = z.string().optional().describe(
  'Build configuration name. Omit it to use the active configuration.');
export const domain = z.string().optional().describe('Sysbuild domain such as mcuboot. Omit it for the application image. An unknown domain, or one given for a build without sysbuild, is an error that lists the valid names.');
export const waitSec = z.number().int().min(0).max(1500).optional().describe(
  'Seconds to wait before returning a job handle. Defaults to the workbench setting, normally 45, which keeps the call under the 60 second timeout most agents use.');
export const dryRun = z.boolean().optional().describe(
  'Check everything and report what would happen, without asking the user or changing anything.');

/** One list field: set replaces it, add and remove edit it. */
export function listEdit(items: string) {
  return z.object({
    set: z.array(z.string()).max(32).optional().describe(`Replace the whole list with these ${items}. Cannot be combined with add or remove.`),
    add: z.array(z.string()).max(32).optional().describe(`Append these ${items}, skipping any already in the list.`),
    remove: z.array(z.string()).max(32).optional().describe(`Remove these ${items} from the list.`),
  }).strict();
}

/** A toolchain choice, as list_toolchains reports the installed ones. */
export const toolchainChoice = z.object({
  family: z.enum(['zephyr_sdk', 'global_sdk', 'arm_gnu', 'iar', 'rust']).describe(
    'zephyr_sdk: a registered Zephyr SDK; global_sdk: the Zephyr SDK found in the global location for the Zephyr version in use; arm_gnu, iar, rust: a registered toolchain of that family.'),
  path: z.string().optional().describe(
    'Absolute root of the toolchain, exactly as list_toolchains returns it. Required for every family except global_sdk.'),
  variant: z.enum(['gnu', 'llvm']).optional().describe(
    'Compiler suite of a Zephyr SDK: gnu (the default) or llvm, which needs an SDK that has its LLVM toolchain installed.'),
}).strict();

/** The shape every long action and the job tool return. */
export const JOB_RESULT = z.object({
  job_id: z.string(),
  kind: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  attached: z.boolean().optional(),
  exit_code: z.number().optional(),
  app_path: z.string().optional(),
  config_name: z.string().optional(),
  build_dir: z.string().optional(),
  command: z.string(),
  started_at: z.string(),
  ended_at: z.string().optional(),
  duration_ms: z.number(),
  diagnostics: z.object({
    errors: z.number(),
    warnings: z.number(),
    truncated: z.boolean(),
    items: z.array(z.object({
      severity: z.string(), tool: z.string(), file: z.string().optional(),
      line: z.number().optional(), column: z.number().optional(),
      message: z.string(), code: z.string().optional(),
    })),
  }).optional(),
  memory: z.array(z.object({
    region: z.string(), used_bytes: z.number(), total_bytes: z.number(), percent: z.number(),
  })).optional(),
  log: z.object({ path: z.string(), bytes: z.number(), tail: z.string() }),
  /** What the job produced beyond its output, such as an installed path or analysis findings. */
  result: z.record(z.string(), z.unknown()).optional(),
  /**
   * True when the answer was read back from disk, because the VS Code window
   * that ran the job reloaded or restarted its extensions since.
   */
  persisted: z.boolean().optional(),
  next: z.string(),
  /** Present when the action asked the user first. */
  confirmation: z.object({ category: z.string(), outcome: z.string() }).optional(),
});

export const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;
