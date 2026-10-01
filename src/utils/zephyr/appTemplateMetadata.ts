// The metadata files that make a folder a Zephyr sample or test, free of
// `vscode` so the MCP core can read them too.

export type AppTemplateKind = 'sample' | 'test';

/** What a metadata file declares; 'contextual' leaves it to where the folder lives or to the file's content. */
export type AppTemplateMetadataKind = AppTemplateKind | 'contextual';

/**
 * The test definition files twister reads at the root of a sample or test,
 * with what each declares: sample.yaml and testcase.yaml up to Zephyr 4.4,
 * tests.yaml for both from Zephyr 4.5, which still reads the older two.
 * Creating an application from a template never copies them, so a folder
 * holding one is a sample or test itself, not an application made from it.
 */
export const APP_TEMPLATE_METADATA_FILES: Readonly<Record<string, AppTemplateMetadataKind>> = {
  'sample.yaml': 'sample',
  'testcase.yaml': 'test',
  'tests.yaml': 'contextual',
};

/** The metadata file among the file names of a folder, if any. */
export function findAppTemplateMetadataFile(fileNames: readonly string[] | ReadonlySet<string>): string | undefined {
  const names = new Set(fileNames);
  return Object.keys(APP_TEMPLATE_METADATA_FILES).find(name => names.has(name));
}
