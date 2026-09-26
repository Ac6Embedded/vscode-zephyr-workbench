// The tool catalog: metadata only, no handlers, so the bridge can serve
// `tools/list` with no VS Code window running.
//
// Naming follows the market survey: snake_case verb_noun, at most 30
// characters so `mcp__zephyr-workbench__<tool>` stays under the 64 character
// limit some gateways enforce. Families are consolidated behind an `action`
// argument because a VS Code chat request caps at 128 tools across every
// installed extension and Cursor cuts off near 40.

import { z } from 'zod';
import { ToolMeta } from './toolSpec';
import { ANALYZE } from './tools/analyze';
import { HARDWARE } from './tools/hardware';
import { MANAGE_APP } from './tools/manageApp';
import { MANAGE_TOOLCHAIN } from './tools/manageToolchain';
import { MANAGE_WEST_WORKSPACE } from './tools/manageWestWorkspace';
import { OPEN_IN_WORKBENCH } from './tools/openInWorkbench';
import { REMOVE_OR_DELETE } from './tools/removeOrDelete';
import { appPath, configName, domain, JOB_RESULT, listEdit, READ_ONLY, toolchainChoice, waitSec } from './tools/shared';

export { JOB_RESULT };

export const SERVER_NAME = 'zephyr-workbench';
export const SERVER_TITLE = 'Zephyr Workbench (VS Code host build tooling)';

/**
 * The server instructions for the tools actually served. Some clients show
 * the instructions and never the descriptions, so a tool this window does not
 * serve (one the user blocked, or one outside the core preset) must never be named as
 * something to call; the equivalent Zephyr Workbench command is named instead.
 */
export function serverInstructions(served: ReadonlySet<string> | readonly string[]): string {
  const has = (name: string) => (Array.isArray(served) ? served.includes(name) : (served as ReadonlySet<string>).has(name));
  const toolOr = (name: string, command: string) => (has(name) ? name : `the Zephyr Workbench command "${command}" (ask the user)`);
  const lines = [
    'Zephyr Workbench exposes the host build tooling of the Zephyr Workbench VS Code extension.',
    'This configures and drives the editor, it is not the on-device Zephyr MCP server library (CONFIG_MCP_SERVER).',
    '',
    'Model: a west workspace holds Zephyr and its modules. An application (app_path, always absolute) uses one',
    'west workspace and has one or more named build configurations (config_name), each with a board, an optional',
    'sysbuild flag, west arguments, CMake -D flags and variables such as EXTRA_CONF_FILE and EXTRA_DTC_OVERLAY_FILE.',
    'Exactly one configuration is active and is used whenever config_name is omitted.',
    'Build output lives in <app_path>/build/<config_name>.',
    '',
    'Start with get_status, then list_apps. The usual loop is: edit sources, call build_app, read the diagnostics in',
    'the result, fix, build again, then get_build_info or get_memory_report.',
    `Starting from nothing: install a Zephyr SDK with ${toolOr('manage_toolchain', 'Add Toolchain')}, create a west workspace with`
      + ` ${toolOr('manage_west_workspace', 'Add West Workspace')}, pick a sample with search_zephyr_catalog kind sample,`
      + ` create the application with ${toolOr('manage_app', 'Add Application')}, then build_app.`,
    'Long actions return a job: when status is "running", call job with action "status" and the job_id until it is not.',
    'Inline output is a tail only; the full log is at log.path or through job with action "log".',
    ...(has('hardware')
      ? ['To see what a board prints, start a capture with hardware action serial_start before flashing or resetting it, then read it with action serial_read (wait_for waits for a line). A capture stays running until serial_stop or its duration_sec, so do not poll it with job status.']
      : []),
    'Adding a folder to the VS Code window can restart its extensions: a result with restart_pending means the server',
    'comes back within seconds, so wait briefly and call get_status; job ids stay valid.',
    'Never run menuconfig or guiconfig in a shell: they wait for keyboard input. Read Kconfig values with query_kconfig',
    '(explain true says why a value is what it is), change them with set_kconfig, edit overlay files for devicetree changes, then rebuild.',
    'Use get_diagnostics to re-read errors without rebuilding, including builds the user started in VS Code.',
    'Change a board, overlays, conf files or -D flags with configure rather than editing settings.json, and find valid',
    'boards, shields, snippets and samples with search_zephyr_catalog. When the environment is not ready, check_environment',
    'says what is missing and which Zephyr Workbench command installs it. Do not install host tools, flash or debug',
    'tools from your own shell: ask the user to run the command check_environment names.',
    'Some actions ask the user in VS Code first (get_status lists them under safety): if a call returns USER_DENIED, do not',
    'repeat it unless the user asks; after CONFIRMATION_TIMEOUT, ask the user to answer the dialog, then repeat the call.',
    'Every path is absolute. Errors carry error.code and error.hint naming the next tool to call.',
  ];
  return lines.join('\n');
}

export const TOOL_CATALOG: readonly ToolMeta[] = [
  {
    name: 'get_status',
    title: 'Workbench status',
    summary: 'Gives the agent an overview of this window: applications, west workspaces, toolchains, readiness and running jobs.',
    description: [
      'Reports the state of the Zephyr Workbench window: workspace folders, known applications with their active build configuration, west workspaces, installed toolchains, whether the host tools and Python environment are ready, and any running jobs.',
      'Call this first in a new session, and again whenever a tool reports that something is missing; use list_apps instead when you only need the applications.',
      'Takes no required arguments; pass all_windows true to merge the answer across every open VS Code window.',
      'Returns a summary object plus next_steps, a list of concrete tool calls to fix whatever is not ready.',
    ].join(' '),
    inputSchema: z.object({
      all_windows: z.boolean().optional().describe('Merge results from every open VS Code window instead of just this one. Windows whose server is not started are listed but not started.'),
    }),
    annotations: READ_ONLY,
    category: 'query',
  },
  {
    name: 'check_environment',
    title: 'Check the host environment',
    summary: 'Checks that the host tools, the Python environment, the Zephyr SDKs and the flash and debug tools are installed and ready.',
    description: [
      'Checks everything the Zephyr Workbench build and flash tools depend on: the host tools install and its completion stamp, the environment script and Python virtual environment settings, west, Python, the registered Zephyr SDKs, and the flash and debug tools listed in the workbench runner manifest, with the versions it detects.',
      'Call it when get_status reports the environment is not ready, when a build fails with ENV_NOT_READY, or before flashing to confirm the tool a board\'s runner needs is installed; use list_toolchains for toolchain details and list_runners for the runners a board supports.',
      'depth quick reads files and settings only and answers in well under a second, while depth full (the default) also runs each tool once for its version and can take several seconds, longer on Windows; sections picks the areas returned, app_path and config_name add that application\'s venv, SDK compatibility and runner tools, and tools limits which flash and debug tools are probed.',
      'Returns one section per area with installed flags, versions and paths, plus problems, each with a code, a message and the Zephyr Workbench command that fixes it, and next_steps; nothing is installed or changed.',
    ].join(' '),
    inputSchema: z.object({
      app_path: z.string().optional().describe(
        'Absolute application root as returned by list_apps; a file or folder inside an application also selects it. Omit it to check the machine only: with a single application in the window, that application is checked too.'),
      config_name: configName,
      depth: z.enum(['quick', 'full']).optional().describe(
        'quick reads files and settings only and runs no process. full, the default, also runs each tool once to read its version.'),
      sections: z.array(z.enum(['host_tools', 'settings', 'python', 'west', 'sdks', 'debug_tools'])).optional().describe(
        'Areas to return. Defaults to all of them. ready is computed from every area either way.'),
      tools: z.array(z.string()).max(50).optional().describe(
        'Flash and debug tools to report, each a tool id or alias from the runner manifest (such as jlink or openocd) or a Zephyr runner name. Defaults to every tool in the manifest; the tools the checked configuration\'s runners need are always included. An unknown name is an error that lists the valid ones.'),
    }),
    annotations: READ_ONLY,
    category: 'query',
    maxResultChars: 60000,
  },
  {
    name: 'list_apps',
    title: 'List applications',
    summary: 'Lists the applications of this window with their build configurations: board, build folder and whether they are built.',
    description: [
      'Lists every Zephyr application the window knows about, with all of its build configurations including board, sysbuild flag, build directory, whether it has been built, the default runner, west arguments and build variables.',
      'Use it to discover the app_path and config_name every other tool takes; use get_build_info when you already know the application and want the results of its last build.',
      'Pass app_path to narrow the answer to one application.',
      'Returns an array of applications, and hints when a folder looks like a Zephyr application but is not registered with the workbench yet.',
    ].join(' '),
    inputSchema: z.object({
      app_path: appPath,
      all_windows: z.boolean().optional().describe('Merge results from every open VS Code window instead of just this one. Windows whose server is not started are listed but not started.'),
    }),
    annotations: READ_ONLY,
    category: 'query',
  },
  {
    name: 'list_toolchains',
    title: 'List toolchains',
    summary: 'Lists the installed Zephyr SDKs and the Arm GNU, IAR and Rust toolchains, and the ones that can be installed.',
    description: [
      'Lists the toolchains Zephyr Workbench knows: Zephyr SDKs (registered, global and the host tools one) with the GNU toolchains and LLVM actually installed in each, and the Arm GNU, IAR and Rust toolchains with their versions, targets and links, plus registrations whose folder is gone; with available it lists what can be installed instead.',
      'Use it when a build fails because a toolchain is missing or the wrong variant is selected, to pick the toolchain of an application in configure or manage_app, and before installing one; use check_environment for host tools and the Python environment.',
      'available picks a family to list the installable versions of (for zephyr_sdk, version adds the toolchain ids and LLVM offer of that version, and app_path or west_workspace the SDK version they recommend), include usage adds the applications using each toolchain, and rescan detects global SDKs again first.',
      'Returns one array per toolchain family, or the installable versions; available asks the official release sites and can take several seconds. Credentials such as IAR licence tokens are never returned.',
    ].join(' '),
    inputSchema: z.object({
      available: z.enum(['zephyr_sdk', 'arm_gnu', 'rust', 'llvm']).optional().describe(
        'List what can be installed for this family instead of what is installed.'),
      version: z.string().optional().describe(
        'With available zephyr_sdk: one SDK version, to list its GNU toolchain ids and whether it offers LLVM.'),
      app_path: z.string().optional().describe(
        'With available zephyr_sdk: absolute application root as returned by list_apps, to add the SDK version its Zephyr version recommends.'),
      west_workspace: z.string().optional().describe(
        'With available zephyr_sdk: absolute west workspace root as get_status returns it, to add the SDK version its Zephyr version recommends.'),
      include: z.array(z.enum(['usage'])).optional().describe(
        'usage adds, for each installed toolchain, the applications of this window that build with it.'),
      rescan: z.boolean().optional().describe(
        'Detect global Zephyr SDKs again before answering, after one was installed or removed outside the workbench.'),
    }),
    annotations: { ...READ_ONLY, openWorldHint: true },
    category: 'query',
    routeBy: ['app_path', 'west_workspace'],
  },
  {
    name: 'search_zephyr_catalog',
    title: 'Search boards, shields, snippets and samples',
    summary: 'Searches a west workspace for boards, shields, snippets, samples, projects and binary blobs.',
    description: [
      'Searches what a west workspace offers: boards and shields as west boards and west shields list them, snippets, samples and tests, the west projects of its manifest, its binary blobs, and, to create a workspace, the Zephyr revisions of a repository and the bundled workspace templates.',
      'Use it to find a valid board identifier, shield, snippet or sample before changing a build configuration or creating an application, and the revisions, templates, projects and blobs before manage_west_workspace; use list_apps to see the boards your applications already use.',
      'kind picks what to search, pattern filters with * wildcards, vendor keeps one board or shield vendor, app_path or west_workspace picks the workspace, url and revision name a repository when there is no workspace yet, and refresh lists again instead of reusing the cached list.',
      'Returns matching entries with absolute paths, paginated through limit and offset. The first board or shield search in a workspace runs west, and revision asks the git server, so they can take several seconds; if a search reports TIMEOUT, call it again without refresh, because the list keeps building and later calls reuse it.',
    ].join(' '),
    inputSchema: z.object({
      kind: z.enum(['board', 'shield', 'snippet', 'sample', 'test', 'project', 'revision', 'template', 'blob']).describe(
        'What to search: board identifiers for west build -b, shields for SHIELD, snippets for west build -S, sample and test folders to start an application from, west projects of the manifest (or of url at revision), Zephyr revisions (tags and branches) of url or of the workspace repository, workspace templates, or the binary blobs of the workspace modules.'),
      url: z.string().optional().describe(
        'kind revision, and kind project without a west workspace: the Zephyr repository, https://host/path or git@host:path. Defaults to the repository of the west workspace.'),
      revision: z.string().optional().describe(
        'kind project with url, and kind template: the Zephyr revision to read the project list or template modules of.'),
      pattern: z.string().optional().describe(
        'Text to look for in names, board identifiers, vendors, full names and sample paths, case-insensitive; * matches any run of characters. Not a regular expression.'),
      app_path: z.string().optional().describe(
        'Absolute application root as returned by list_apps. Searches the west workspace that application uses, plus the snippets folder of the application and the board roots its existing builds recorded. Snippets from that folder carry needs_snippet_root when the Zephyr version only uses them once the application adds its folder to SNIPPET_ROOT. Omit it to search a west workspace on its own.'),
      west_workspace: z.string().optional().describe(
        'Absolute west workspace root, one of the west_workspaces[].path values get_status returns. Omit it when the window has a single west workspace or when app_path is given.'),
      vendor: z.string().optional().describe(
        'Keep only boards or shields of this vendor, such as nordic or st, compared exactly and case-insensitively. Only for kind board or shield.'),
      refresh: z.boolean().optional().describe(
        'List again instead of reusing the list an earlier call cached, for example after west update or after adding a board.'),
      limit: z.number().int().min(1).max(200).optional().describe(
        'Maximum entries to return. Defaults to 50. A page holds fewer when the entries are long; next_offset then says where the next page starts.'),
      offset: z.number().int().min(0).optional().describe(
        'Index of the first entry to return, for paging: pass the next_offset of the previous answer.'),
    }),
    annotations: { ...READ_ONLY, openWorldHint: true },
    category: 'query',
    maxResultChars: 100000,
    routeBy: ['app_path', 'west_workspace'],
  },
  {
    name: 'get_build_info',
    title: 'Read the last build',
    summary: 'Reads the result of the last build: board, toolchain, image sizes, memory use and output files.',
    description: [
      'Reads the results of the last build of one configuration straight from the build directory: target board, toolchain, image sizes, memory region usage, produced artifacts, and whether the directory is configured and built.',
      'Use it after a build, or instead of rebuilding when you only need numbers or artifact paths; use build_app when the sources changed and get_memory_report for a breakdown by symbol or source file.',
      'app_path and config_name select the build; include may request the extra sections sources, domains, sys_init and elf_stat.',
      'Returns a summary object with absolute artifact paths. It never builds anything, so it is fast and safe to call repeatedly.',
    ].join(' '),
    inputSchema: z.object({
      app_path: appPath,
      config_name: configName,
      domain,
      include: z.array(z.enum(['sources', 'domains', 'sys_init', 'elf_stat'])).optional()
        .describe('Extra sections to include. Each one costs time, so ask only for what you need.'),
    }),
    annotations: READ_ONLY,
    category: 'artifact',
    maxResultChars: 100000,
  },
  {
    name: 'get_memory_report',
    title: 'Memory report',
    summary: 'Shows what takes up flash and RAM in the built firmware, by section, symbol or source folder.',
    description: [
      'Breaks the built firmware down by memory usage, reading zephyr.elf directly: by linker section, by largest symbols, or as a tree grouped by source path.',
      'Use it to find what is filling flash or RAM after a region overflow; this replaces the west ram_report and rom_report targets, which need a terminal and refuse to run when sysbuild is enabled.',
      'region selects rom, ram or both, view selects sections, symbols or tree, and top caps how many entries come back.',
      'Returns sizes in bytes with percentages. Large reports are truncated, so narrow the view with path_prefix or min_size_bytes rather than raising top.',
    ].join(' '),
    inputSchema: z.object({
      app_path: appPath,
      config_name: configName,
      domain,
      region: z.enum(['rom', 'ram', 'both']).optional().describe('Which memory to report. Defaults to both.'),
      view: z.enum(['sections', 'symbols', 'tree']).optional().describe('sections lists linker sections, symbols lists the largest symbols, tree groups by source path. Defaults to sections.'),
      top: z.number().int().min(1).max(200).optional().describe('How many entries to return for the symbols view. Defaults to 25.'),
      path_prefix: z.string().optional().describe('Source path fragment such as drivers/gpio. Only with view "tree": returns that subtree.'),
      min_size_bytes: z.number().int().min(0).optional().describe('Drop entries smaller than this, to cut noise from a large report.'),
      depth: z.number().int().min(1).max(10).optional().describe('Tree depth when view is tree.'),
    }),
    annotations: READ_ONLY,
    category: 'artifact',
    maxResultChars: 100000,
  },
  {
    name: 'query_kconfig',
    title: 'Query built Kconfig values',
    summary: 'Looks up the Kconfig values of the last build, and why each option has its value.',
    description: [
      'Looks up the resolved Kconfig values of the last build from build/zephyr/.config, and where the workbench recorded a configuration trace it also reports why each symbol holds its value, whether assigned, selected, implied or defaulted; with explain true it loads the real Kconfig tree of the build and explains each symbol instead.',
      'Use it to check what a build actually enabled, and use explain before changing an option or when a value did not take; change values with set_kconfig.',
      'Pass symbols for exact names or pattern for a name fragment with * wildcards, and only_set to skip symbols left at their default; explain takes up to 10 names in symbols and no other filter.',
      'Returns matching symbols with their value and origin, paginated through limit and offset, or with explain their type, help, dependencies with the terms that block them, selecting symbols with their state, defaults, definition sites and how to change them, or with format defconfig the minimal configuration text.',
    ].join(' '),
    inputSchema: z.object({
      app_path: appPath,
      config_name: configName,
      domain,
      symbols: z.array(z.string()).max(100).optional().describe('Exact symbol names to look up, with or without the CONFIG_ prefix.'),
      pattern: z.string().optional().describe('Text to look for in the symbol name, case-insensitive; * matches any run of characters. Not a regular expression.'),
      only_set: z.boolean().optional().describe('Return only symbols that were explicitly assigned, selected or implied, skipping those left at a default. Needs the configuration trace the workbench records; without it a note says the filter could not apply.'),
      limit: z.number().int().min(1).max(500).optional().describe('Maximum entries to return.'),
      offset: z.number().int().min(0).optional().describe('Index of the first entry to return, for paging.'),
      explain: z.boolean().optional().describe('Explain each name in symbols (at most 10) from the Kconfig tree of the build: type, value, help, dependencies with the terms that block it, selecting symbols with their state, defaults, definition sites and how to change it. Takes a second or two the first time for a build, and cannot be combined with pattern, only_set, limit or offset.'),
      format: z.enum(['values', 'defconfig']).optional().describe('values (the default) returns symbols; defconfig returns the minimal configuration of the build instead, only the options that differ from their defaults, as menuconfig\'s save minimal config writes it. defconfig takes no other filter.'),
    }),
    annotations: READ_ONLY,
    category: 'artifact',
    maxResultChars: 100000,
  },
  {
    name: 'set_kconfig',
    title: 'Change Kconfig options',
    summary: 'Changes Kconfig options in the application\'s prj.conf or a .conf fragment, and checks that each value takes effect.',
    description: [
      'Changes Kconfig options of one build configuration by writing them into the workbench managed region of the application prj.conf (whichever file CONF_FILE names) or of a .conf fragment, after merging the configuration files exactly as the next CMake configure will, with the new text in place, to prove that every value takes.',
      'Use it instead of editing prj.conf by hand or running menuconfig, then call build_app to apply the change; call query_kconfig with explain true first when you do not know what an option depends on.',
      'assignments lists up to 50 changes, each a symbol with a value or with unset true to remove its managed line, persist_temporary also saves the values the user changed in menuconfig, guiconfig or the Kconfig Manager, target picks prj_conf or fragment with fragment_path, register_fragment adds a new fragment to EXTRA_CONF_FILE, and dry_run checks without writing.',
      'Returns a result per symbol (applied, unchanged, removed, rejected or overridden, with the reason, the blocking dependencies or the later file that wins), the managed region after the change, side effects on other options and the temporary .config values the next build discards; when any assignment fails, nothing is written.',
    ].join(' '),
    inputSchema: z.object({
      app_path: appPath,
      config_name: configName,
      domain,
      assignments: z.array(z.object({
        symbol: z.string().describe('Symbol name, with or without the CONFIG_ prefix.'),
        value: z.union([z.string(), z.boolean(), z.number()]).optional().describe('The new value: y, n or m (or true and false) for bool and tristate, a decimal number for int, a hexadecimal number for hex, and plain text without surrounding quotes for string. Omit it when unset is true.'),
        unset: z.boolean().optional().describe('true removes the managed line of this symbol, so its value comes from the other configuration files or its default again.'),
      })).min(1).max(50).optional().describe('The changes to make, written together or not at all. Required unless persist_temporary is true.'),
      persist_temporary: z.boolean().optional().describe('Also save the values that differ in build/zephyr/.config from what the configuration files give, which is what the user changed in menuconfig, guiconfig or the Kconfig Manager and the next build would otherwise discard, checked like assignments, which win for the same symbol. Refused while the Kconfig Manager of that build has unsaved edits, and after a configuration file changed since the last configure.'),
      target: z.enum(['prj_conf', 'fragment']).optional().describe('prj_conf, the default, writes the application configuration file the build merges; fragment writes the .conf file named by fragment_path.'),
      fragment_path: z.string().optional().describe('Absolute path of a .conf file inside the application, for target fragment. It is created when missing.'),
      register_fragment: z.boolean().optional().describe('With target fragment: add the file to EXTRA_CONF_FILE of the build configuration when the build does not merge it yet. Not available for sysbuild configurations.'),
      dry_run: z.boolean().optional().describe('Check the assignments and report what would change, without writing anything.'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    category: 'config',
    confirm: 'settings',
    maxResultChars: 100000,
  },
  {
    name: 'query_devicetree',
    title: 'Query the built devicetree',
    summary: 'Finds nodes in the final devicetree of the last build, with the file and line that defined each one.',
    description: [
      'Queries the final merged devicetree of the last build, read from build/zephyr/zephyr.dts, finding nodes by path, label, compatible string or status, and reporting the file and line that defined each one.',
      'Use it to confirm what a board plus its overlays actually produced; to change the devicetree, edit an overlay file yourself and then call build_app, because this tool never writes.',
      'Pass path, label, compatible, status or pattern to narrow the search, and include_source to get the node text.',
      'Returns matching nodes with their labels, compatible strings and definition sites. Node source text is capped, so request it only when you need it.',
    ].join(' '),
    inputSchema: z.object({
      app_path: appPath,
      config_name: configName,
      domain,
      path: z.string().optional().describe('Devicetree node path such as /soc/uart@40011000.'),
      label: z.string().optional().describe('Node label such as uart1.'),
      compatible: z.string().optional().describe('Compatible string such as st,stm32-uart.'),
      status: z.enum(['okay', 'disabled']).optional().describe('Only return nodes with this status.'),
      pattern: z.string().optional().describe('Text to look for in the node path, labels and compatible strings, case-insensitive; * matches any run of characters. Not a regular expression.'),
      include_source: z.boolean().optional().describe('Include the devicetree source text of each node. Capped per node, so ask only when you need it.'),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum nodes to return.'),
      offset: z.number().int().min(0).optional().describe('Index of the first node to return, for paging.'),
    }),
    annotations: READ_ONLY,
    category: 'artifact',
    maxResultChars: 100000,
  },
  {
    name: 'list_runners',
    title: 'List flash and debug runners',
    summary: 'Lists the flash and debug runners a built board supports, and which one is the default.',
    description: [
      'Lists the flash and debug runners available for a built configuration, read from the runners.yaml the build produced, together with the board default and whatever default runner the workbench has configured.',
      'Call it when you need to know which runner a board supports; it needs a completed build, because runners.yaml is a build artifact.',
      'app_path, config_name and domain select the build whose runners.yaml is read.',
      'Returns the runner names with the configured and board defaults marked, or the full static list with a note when the configuration is not built yet.',
    ].join(' '),
    inputSchema: z.object({
      app_path: appPath,
      config_name: configName,
      domain,
    }),
    annotations: READ_ONLY,
    category: 'artifact',
  },
  {
    name: 'get_diagnostics',
    title: 'Build errors and warnings',
    summary: 'Reads the errors and warnings of the last build, including builds you started yourself.',
    description: [
      'Returns structured errors and warnings for one build configuration: the diagnostics parsed from the last agent build of that configuration, the VS Code Problems panel entries for the application files (which also cover builds the user started by hand and language server findings), or the findings of the last ECLAIR analysis.',
      'Use it to re-read problems without rebuilding, after the user built from VS Code, after analyze with analysis eclair, or to have the language servers check files you just wrote; build_app already returns the diagnostics of the build it ran.',
      'source picks last_build, problems_panel, both or sca, severity keeps only errors or only warnings, rule and path_prefix filter ECLAIR findings, limit and offset page them, and open_files opens up to 10 files so their language servers report on them first.',
      'Returns items with severity, file, line, column and message, with error and warning counts per source. Only agent builds made since this VS Code window started are remembered.',
    ].join(' '),
    inputSchema: z.object({
      app_path: appPath,
      config_name: configName,
      source: z.enum(['last_build', 'problems_panel', 'both', 'sca']).optional().describe('Where to read diagnostics from: the last agent build, the Problems panel, both (the default), or sca for the findings of the last ECLAIR analysis of the configuration.'),
      severity: z.enum(['error', 'warning', 'all']).optional().describe('Keep only this severity. Defaults to all.'),
      rule: z.string().optional().describe('source sca only: keep findings of rules matching this text, case-insensitive; * matches any run of characters, such as MC3R1.R10*.'),
      path_prefix: z.string().optional().describe('source sca only: keep findings in files under this absolute folder or matching this path fragment.'),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum items returned per source. Defaults to 50.'),
      offset: z.number().int().min(0).optional().describe('source sca only: index of the first finding to return, for paging.'),
      open_files: z.array(z.string()).max(10).optional().describe('Absolute paths of files inside the application, such as an overlay you just wrote, to open (without showing them) so the devicetree and C language servers check them; their problems are then waited for up to about 3 seconds and returned under opened, whatever the source.'),
    }),
    annotations: READ_ONLY,
    category: 'query',
  },
  {
    name: 'build_app',
    title: 'Build',
    summary: 'Builds a build configuration with west build, in a VS Code terminal you can watch.',
    description: [
      'Runs west build for one build configuration in a visible VS Code task terminal, reusing the board, sysbuild flag, west arguments, CMake flags and environment already stored in the workbench settings.',
      'Use it after editing sources, prj.conf or an overlay; pass pristine "always" only when the board or toolchain changed or CMake state is broken, and use get_build_info to read an earlier build without rebuilding.',
      'app_path and config_name select what to build, cmake_only runs the configure stage alone, and wait_sec bounds how long the call blocks.',
      'Returns a job: when status is "running" poll job with the job_id. A finished job carries the exit code, parsed compiler, linker, CMake, Kconfig and devicetree diagnostics with file and line, flash and RAM usage, the last log lines and the full log path. A clean build can take several minutes.',
    ].join(' '),
    inputSchema: z.object({
      app_path: appPath,
      config_name: configName,
      pristine: z.enum(['never', 'always']).optional().describe('always forces a full clean rebuild. Use it only when the board or toolchain changed. Defaults to never.'),
      cmake_only: z.boolean().optional().describe('Run only the CMake configure stage, never the compile.'),
      wait_sec: waitSec,
    }),
    outputSchema: JOB_RESULT,
    annotations: { idempotentHint: true, openWorldHint: false },
    category: 'action',
  },
  ANALYZE,
  {
    name: 'configure',
    title: 'Change settings',
    summary: 'Changes build configurations and application or west workspace settings, as the Workbench views do.',
    description: [
      'Changes the workbench settings the Zephyr Workbench views edit: with target "build_config" it creates, updates, renames or activates a build configuration (board, sysbuild, west arguments, CMake -D flags, default runner and its arguments, EXTRA_CONF_FILE, EXTRA_DTC_OVERLAY_FILE, EXTRA_ZEPHYR_MODULES, SHIELD, SNIPPETS); with target "app" it selects the application of a west workspace, or with action "update" changes its toolchain, IntelliSense provider, Python venv or linked west workspace; with target "west_workspace" and action "update" it changes the board, DTS, SoC, arch and snippet roots and the venv of a west workspace.',
      'Use it instead of editing settings.json: read the values with list_apps, list_toolchains or get_status first, then call build_app, with pristine "always" when the result says needs_pristine; it never deletes, which remove_or_delete does in the full toolset.',
      'config_name names the configuration (the new one for create, the active one when omitted for update), new_name is only for rename, list fields take set to replace or add and remove to edit, an empty string clears a text field, and dry_run reports an app or west_workspace update without writing.',
      'Returns the configuration, application or west workspace as the listing tools report it after the write, the fields that changed, warnings and the settings file; a rename never moves the build folder, it reports it as orphaned_build_dir instead.',
    ].join(' '),
    inputSchema: (() => {
      const paths = (items: string) => listEdit(`${items}, each absolute or relative to app_path`).optional();
      const roots = (items: string) => listEdit(`${items}, each absolute or relative to the west workspace root`).optional();
      return z.object({
        target: z.enum(['build_config', 'app', 'west_workspace']).describe('What to change: a build configuration, an application, or a west workspace.'),
        action: z.enum(['create', 'update', 'rename', 'activate', 'select']).describe('create, update, rename or activate with target "build_config"; select or update with target "app"; update with target "west_workspace".'),
        app_path: appPath,
        config_name: z.string().optional().describe(
          'The configuration to act on. For create it is the new name: letters, digits, - and _, unique ignoring case, defaulting to the next free setup_N. Omit it with update to change the active configuration. Required for rename and activate.'),
        new_name: z.string().optional().describe('rename only: the new name, with the same rules as a created one.'),
        copy_from: z.string().optional().describe('create only: an existing configuration whose settings the new one starts from, before the other fields apply.'),
        activate: z.boolean().optional().describe('create only: make the new configuration the active one. The first configuration of an application is always active.'),
        board: z.string().optional().describe(
          'Board identifier as west build -b takes it, such as nrf52840dk/nrf52840. Required for create unless copy_from provides one. It is not checked against the installed boards, so a wrong one fails at build time.'),
        sysbuild: z.boolean().optional().describe('Build with sysbuild, for multi-image builds such as MCUboot plus the application.'),
        west_args: z.string().optional().describe(
          'Extra west build arguments stored as one string, such as -o=-j4. An empty string clears them. Options another field owns (board, build folder, sysbuild, snippets, shields, pristine, target, -D flags) are refused.'),
        west_flags: listEdit('CMake -D flags').optional().describe(
          'CMake cache variables passed as -D flags, each NAME=VALUE or NAME, such as CONFIG_DEBUG_OPTIMIZATIONS=y. Adding a name already set replaces its value; removing a bare NAME removes it whatever its value.'),
        default_runner: z.string().optional().describe('Runner used to flash and debug, such as jlink or openocd. An empty string clears it together with runner_args.'),
        runner_args: z.string().optional().describe('Extra arguments for the default runner. An empty string clears them. Needs a default runner, stored already or given in the same call.'),
        env: z.object({
          EXTRA_CONF_FILE: paths('Kconfig fragment files').describe('Extra Kconfig fragments merged after prj.conf.'),
          EXTRA_DTC_OVERLAY_FILE: paths('devicetree overlay files').describe('Extra devicetree overlays applied after the board and application ones.'),
          EXTRA_ZEPHYR_MODULES: paths('module folders').describe('Extra Zephyr module folders added to the build.'),
          SHIELD: listEdit('shield names').optional().describe('Shields to build with, by name, such as x_nucleo_iks01a3.'),
          SNIPPETS: listEdit('snippet names').optional().describe('Snippets to build with, by name, such as cdc-acm-console.'),
        }).strict().optional().describe(
          'target build_config only: build variable lists of the configuration. Paths must stay inside the workspace, and a path that does not exist yet is stored with a warning.'),
        west_workspace: z.string().optional().describe(
          'With target west_workspace: the absolute west workspace root to change, as get_status returns it, optional when the window has one. With target app and action update: link a freestanding application to this west workspace.'),
        toolchain: toolchainChoice.optional().describe(
          'target app, action update: the toolchain the application builds with, one list_toolchains reports as installed.'),
        intellisense_provider: z.enum(['cpptools', 'clangd']).optional().describe(
          'target app, action update: the C/C++ language support the application is set up for.'),
        venv: z.object({
          mode: z.enum(['inherit', 'path']).describe('inherit clears the setting, so the west workspace venv or the global one is used; path uses the venv at path.'),
          path: z.string().optional().describe('With mode path: absolute root of an existing Python virtual environment.'),
        }).strict().optional().describe(
          'target app or west_workspace, action update: the Python virtual environment used to build.'),
        roots: z.object({
          BOARD_ROOT: roots('board root folders').describe('Extra folders searched for boards.'),
          DTS_ROOT: roots('devicetree root folders').describe('Extra folders searched for devicetree sources and bindings.'),
          SOC_ROOT: roots('SoC root folders').describe('Extra folders searched for SoC definitions.'),
          ARCH_ROOT: roots('architecture root folders').describe('Extra folders searched for architectures.'),
          SNIPPET_ROOT: roots('snippet root folders').describe('Extra folders searched for snippets.'),
        }).strict().optional().describe(
          'target west_workspace, action update: the root folder lists every application of the workspace builds with. Paths must stay inside the folders of the window.'),
        dry_run: z.boolean().optional().describe('target app or west_workspace with action update: report what would change without writing.'),
      });
    })(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    category: 'config',
    confirm: 'settings',
    routeBy: ['app_path', 'west_workspace'],
  },
  MANAGE_APP,
  MANAGE_WEST_WORKSPACE,
  MANAGE_TOOLCHAIN,
  OPEN_IN_WORKBENCH,
  REMOVE_OR_DELETE,
  HARDWARE,
  {
    name: 'job',
    title: 'Job status, log and cancel',
    summary: 'Follows a long action such as a build: its status, its log, or cancelling it.',
    description: [
      'Inspects and controls the long running actions started by tools such as build_app: action "status" polls a job and waits for it, action "log" reads a slice of its full output, and action "cancel" stops it and its process tree.',
      'Call it whenever an action returned status "running"; with no job_id and action "status" it lists the recent jobs of the window serving the call instead.',
      'job_id identifies the job, wait_sec bounds a status call, and offset with max_chars page through the log.',
      'Returns the same job shape the action returned, with only the log text after offset so repeated polling stays cheap.',
    ].join(' '),
    inputSchema: z.object({
      action: z.enum(['status', 'log', 'cancel']).describe('What to do with the job.'),
      job_id: z.string().optional().describe('The job_id an action returned, used as is: it names the VS Code window that runs the job. Omit it with action status to list recent jobs.'),
      wait_sec: waitSec,
      offset: z.number().int().min(0).optional().describe('Byte offset into the log for action log.'),
      max_chars: z.number().int().min(1).max(40000).optional().describe('Maximum characters of log text to return in one call.'),
      grep: z.string().optional().describe('Only return log lines containing this text, case-insensitive; * matches any run of characters. Not a regular expression.'),
      context_lines: z.number().int().min(0).max(20).optional().describe('Lines of surrounding context to include around each grep match.'),
    }),
    annotations: { openWorldHint: false },
    category: 'job',
    maxResultChars: 100000,
  },
] as const;

/** The instructions with every tool of the catalog served. */
export const SERVER_INSTRUCTIONS = serverInstructions(TOOL_CATALOG.map(tool => tool.name));

export function findTool(name: string): ToolMeta | undefined {
  return TOOL_CATALOG.find(tool => tool.name === name);
}
