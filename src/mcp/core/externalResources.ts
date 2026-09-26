// What the AI Manager points to outside Zephyr Workbench: the Zephyr Project's
// own MCP server and third-party agent skills. Data only, shared by the panel
// and its webview, so both show the same facts, and the panel opens a link only
// when its id is listed here.
//
// Checked on 2026-09-25 against the Zephyr documentation page
// develop/tools/kapa_ai.html, the Kapa.ai page of the Zephyr infrastructure
// wiki, the endpoint itself (streamable HTTP, OAuth sign-in with dynamic client
// registration) and each skills page.

/** The Zephyr Project's MCP server, hosted by Kapa.ai. */
export const ZEPHYR_PROJECT_MCP = {
  /** The key the entry is written under in each agent's config, as the Zephyr documentation names it. */
  name: 'zephyr-docs',
  url: 'https://zephyrproject.mcp.kapa.ai',
} as const;

/** Every page the AI Manager may open in the browser. */
export const EXTERNAL_LINKS = {
  'zephyr-mcp-docs': 'https://docs.zephyrproject.org/latest/develop/tools/kapa_ai.html',
  'zephyr-mcp-wiki': 'https://github.com/zephyrproject-rtos/infrastructure/wiki/Kapa.ai',
  'mcp-remote': 'https://www.npmjs.com/package/mcp-remote',
  'zephyr-api-reference': 'https://docs.zephyrproject.org/latest/doxygen/html/index.html',
  'zephyr-bindings': 'https://docs.zephyrproject.org/latest/build/dts/api/bindings.html',
  'zephyr-docs': 'https://docs.zephyrproject.org/latest/',
  'zephyr-wiki': 'https://github.com/zephyrproject-rtos/zephyr/wiki',
  'skills-ac6': 'https://github.com/Ac6Embedded/Zephyr-RTOS-AI-Skills',
  'skills-zephyr-agent-skills': 'https://github.com/beriberikix/zephyr-agent-skills',
  'skills-beningo': 'https://www.beningo.com/zephyr-ai-skills/',
} as const;

export type ExternalLinkId = keyof typeof EXTERNAL_LINKS;

export function isExternalLinkId(value: unknown): value is ExternalLinkId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(EXTERNAL_LINKS, value);
}

export interface DataSource {
  source: string;
  details: string;
  /** Set when the details are a page the user can open. */
  link?: ExternalLinkId;
  refresh: string;
}

/** The Data sources table of the Zephyr documentation, row for row. */
export const ZEPHYR_MCP_DATA_SOURCES: readonly DataSource[] = [
  {
    source: 'Source code',
    details: 'zephyrproject-rtos/zephyr repository (excluding the boards/ and doc/ folders); C, Markdown, Python, and text files',
    refresh: 'Hourly',
  },
  { source: 'API reference', details: EXTERNAL_LINKS['zephyr-api-reference'], link: 'zephyr-api-reference', refresh: 'Daily' },
  { source: 'Devicetree bindings', details: EXTERNAL_LINKS['zephyr-bindings'], link: 'zephyr-bindings', refresh: 'Daily' },
  {
    source: 'Main documentation',
    details: `${EXTERNAL_LINKS['zephyr-docs']} (excluding the API reference and Devicetree bindings sections)`,
    link: 'zephyr-docs',
    refresh: 'Daily',
  },
  { source: 'Project wiki', details: EXTERNAL_LINKS['zephyr-wiki'], link: 'zephyr-wiki', refresh: 'Daily' },
  { source: 'GitHub issues', details: 'zephyrproject-rtos/zephyr issues from the last 6 months', refresh: 'Every 5 minutes' },
  {
    source: 'GitHub pull requests',
    details: 'zephyrproject-rtos/zephyr pull requests from the last 6 months (excluding those closed without being merged)',
    refresh: 'Every 10 minutes',
  },
];

export interface SkillCollection {
  link: ExternalLinkId;
  name: string;
  author: string;
  /** What it holds, in one line. */
  summary: string;
  /** Ways to install it, each with the commands to run. */
  install?: { label: string; commands: string[] }[];
}

/** Agent skill collections written by others. Zephyr Workbench neither maintains nor checks them. */
export const THIRD_PARTY_SKILLS: readonly SkillCollection[] = [
  {
    link: 'skills-ac6',
    name: 'Zephyr RTOS AI Skills',
    author: 'Ac6',
    summary: 'Devicetree and Kconfig skills with vendor pages (Silicon Labs, STM32, NXP, ESP32, Nordic).',
    install: [
      {
        label: 'For any agent, with the skills CLI, which asks which skills and agents (needs Node.js)',
        commands: ['npx skills add Ac6Embedded/Zephyr-RTOS-AI-Skills'],
      },
      {
        label: 'As a Claude Code plugin, typed in Claude Code',
        commands: [
          '/plugin marketplace add Ac6Embedded/Zephyr-RTOS-AI-Skills',
          '/plugin install zephyr-skills@zephyr-rtos-ai-skills',
        ],
      },
      {
        label: 'By hand, for all your projects (Claude Code reads ~/.claude/skills/ instead)',
        commands: [
          'git clone https://github.com/Ac6Embedded/Zephyr-RTOS-AI-Skills.git',
          'mkdir -p ~/.agents/skills',
          'cp -R Zephyr-RTOS-AI-Skills/skills/* ~/.agents/skills/',
        ],
      },
    ],
  },
  {
    link: 'skills-zephyr-agent-skills',
    name: 'Zephyr Agent Skills',
    author: 'beriberikix',
    summary: 'Skills for building with Zephyr, from the build basics to hardware, connectivity and production.',
    install: [
      {
        label: 'As a Claude Code plugin',
        commands: [
          'claude plugin marketplace add beriberikix/zephyr-agent-skills',
          'claude plugin install zephyr-skills@zephyr-agent-skills',
        ],
      },
      {
        label: 'With zephyr-cli, which suggests the skill for a task',
        commands: [
          'zephyr-cli skills suggest "enable an i2c sensor in my devicetree overlay"',
          'zephyr-cli skills install devicetree',
        ],
      },
    ],
  },
  {
    link: 'skills-beningo',
    name: 'Zephyr AI Skills',
    author: 'Beningo Embedded Group',
    summary: 'Five skills for board support work: BSP scaffold, devicetree, Kconfig tuning, build doctor and Renode runner.',
  },
];
