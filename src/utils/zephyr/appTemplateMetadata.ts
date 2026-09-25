// The metadata files that make a folder a Zephyr sample or test, free of
// `vscode` so the MCP core can read them too.

/** What a metadata file declares; 'contextual' leaves it to where the folder lives or to the file's content. */
export type AppTemplateMetadataKind = 'sample' | 'test' | 'contextual';

/**
 * The metadata file names at the root of a sample or test, with what each
 * declares. Creating an application from a template never copies them, so a
 * folder holding one is a sample or test itself, not an application made from it.
 */
export const APP_TEMPLATE_METADATA_FILES: Readonly<Record<string, AppTemplateMetadataKind>> = {
  'sample.yaml': 'sample',
  'testcase.yaml': 'test',
  'testcases.yml': 'test',
  'tests.yaml': 'contextual',
  'tests.yml': 'contextual',
};
