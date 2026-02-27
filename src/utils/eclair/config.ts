import { z } from "zod";

export const EclairPresetTemplateSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("system-path"),
    path: z.string(),
  }),
  z.object({
    type: z.literal("repo-path"),
    /** Logical repo name */
    repo: z.string(),
    path: z.string(),
  }),
]);

export type EclairPresetTemplateSource = z.infer<typeof EclairPresetTemplateSourceSchema>;

export const PresetSelectionStateSchema = z.object({
  source: EclairPresetTemplateSourceSchema,
  edited_flags: z.record(z.string(), z.union([z.string(), z.boolean()])),
});

export type PresetSelectionState = z.infer<typeof PresetSelectionStateSchema>;

export const EclairScaPresetConfigSchema = z.object({
  ruleset: PresetSelectionStateSchema,
  variants: z.array(PresetSelectionStateSchema),
  tailorings: z.array(PresetSelectionStateSchema),
});

export type EclairScaPresetConfig = z.infer<typeof EclairScaPresetConfigSchema>;

export const EclairScaCustomEclConfigSchema = z.object({
  ecl_path: z.string(),
});

export type EclairScaCustomEclConfig = z.infer<typeof EclairScaCustomEclConfigSchema>;

export const EclairScaZephyrRulesetConfigSchema = z.object({
  ruleset: z.string(),
  userRulesetName: z.string().optional(),
  userRulesetPath: z.string().optional(),
});

export type EclairScaZephyrRulesetConfig = z.infer<typeof EclairScaZephyrRulesetConfigSchema>;

export const EclairScaMainConfigSchema = z.discriminatedUnion("type", [
  EclairScaPresetConfigSchema.extend({
    type: z.literal("preset"),
  }),
  EclairScaCustomEclConfigSchema.extend({
    type: z.literal("custom-ecl"),
  }),
  EclairScaZephyrRulesetConfigSchema.extend({
    type: z.literal("zephyr-ruleset"),
  }),
]);

export type EclairScaMainConfig = z.infer<typeof EclairScaMainConfigSchema>;

export type EclairScaConfigType = EclairScaMainConfig["type"];

export const ALL_ECLAIR_REPORTS = [
  "ECLAIR_METRICS_TAB",
  "ECLAIR_REPORTS_TAB",
  "ECLAIR_REPORTS_SARIF",
  "ECLAIR_SUMMARY_TXT",
  "ECLAIR_SUMMARY_DOC",
  "ECLAIR_SUMMARY_ODT",
  "ECLAIR_SUMMARY_HTML",
  "ECLAIR_FULL_TXT",
  "ECLAIR_FULL_DOC",
  "ECLAIR_FULL_ODT",
  "ECLAIR_FULL_HTML",
];

export type EclairScaReportOption = typeof ALL_ECLAIR_REPORTS[number];

/**
 * A single repository entry: a human-readable logical name mapped to an origin
 * URL and the revision (branch, tag, or commit SHA) to check out.
 */
export const EclairRepoEntrySchema = z.object({
  origin: z.string(),
  ref: z.string(),
  /**
   * Optional locked commit hash. When set, the repo checkout is pinned
   * to this exact revision.
   */
  rev: z.string().optional(),
});

export type EclairRepoEntry = z.infer<typeof EclairRepoEntrySchema>;

/**
 * A map from logical repo name (used as the checkout directory name) to its
 * origin/rev descriptor.  These repos are checked out on demand into the
 * extension's internal storage and used as sources for preset templates.
 *
 * Example:
 *   repos:
 *     my-presets:
 *       origin: https://github.com/acme/eclair-presets.git
 *       rev: main
 */
export const EclairReposSchema = z.record(z.string(), EclairRepoEntrySchema);

export type EclairRepos = z.infer<typeof EclairReposSchema>;

export const EclairScaConfigSchema = z.object({
  name: z.string(),
  description_md: z.string().optional(),
  main_config: EclairScaMainConfigSchema,
  extra_config: z.string().optional(),
  reports: z.array(z.union([z.enum(ALL_ECLAIR_REPORTS), z.literal("ALL")])).optional(),
});

export type EclairScaConfig = z.infer<typeof EclairScaConfigSchema>;

export const FullEclairScaConfigSchema = z.object({
  install_path: z.string().optional(),
  configs: z.array(EclairScaConfigSchema),
  current_config_index: z.number().optional(),
  repos: EclairReposSchema.optional(),
});

export type FullEclairScaConfig = z.infer<typeof FullEclairScaConfigSchema>;
