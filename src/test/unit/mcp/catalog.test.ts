import { strict as assert } from 'assert';
import { SERVER_INSTRUCTIONS, SERVER_NAME, TOOL_CATALOG, findTool, serverInstructions } from '../../../mcp/core/catalog';
import {
  catalogVersion, confirmCategoryOf, isMachineScope, permissionOf, Permissions, routeByOf, selectTools,
} from '../../../mcp/core/toolSpec';
import { toToolError } from '../../../mcp/core/errors';

const FULL: Permissions = { preset: 'full', tools: {} };
const CORE: Permissions = { preset: 'core', tools: {} };

describe('mcp/core/catalog', () => {
  it('uses a server key that survives every client prefix scheme', () => {
    // Gemini splits the prefix on the first underscore, so the key must not contain one.
    assert.equal(SERVER_NAME, 'zephyr-workbench');
    assert.ok(!SERVER_NAME.includes('_'));
  });

  it('names every tool in snake_case within the length budget', () => {
    for (const tool of TOOL_CATALOG) {
      assert.match(tool.name, /^[a-z][a-z0-9_]{1,29}$/, `${tool.name} must be snake_case and at most 30 characters`);
      // mcp__zephyr-workbench__ is 23 characters and some gateways cap the full name at 64.
      assert.ok(`mcp__${SERVER_NAME}__${tool.name}`.length <= 64, `${tool.name} makes the prefixed name too long`);
    }
  });

  it('has unique names and a deterministic order', () => {
    const names = TOOL_CATALOG.map(t => t.name);
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual(names, TOOL_CATALOG.map(t => t.name), 'order must be stable');
  });

  it('describes every tool in at least four sentences', () => {
    for (const tool of TOOL_CATALOG) {
      const sentences = tool.description.split(/(?<=\.)\s+/).filter(s => s.trim().length > 0);
      assert.ok(sentences.length >= 4, `${tool.name} has ${sentences.length} sentences, the contract is four`);
      assert.ok(tool.description.length <= 1500, `${tool.name} description is too long for the client budget`);
    }
  });

  it('tells the user what every tool does in a sentence or two short enough for a tooltip', () => {
    for (const tool of TOOL_CATALOG) {
      const sentences = tool.summary.split(/(?<=\.)\s+/).filter(s => s.trim().length > 0);
      assert.ok(sentences.length >= 1 && sentences.length <= 2, `${tool.name} summary has ${sentences.length} sentences`);
      assert.ok(tool.summary.length <= 140, `${tool.name} summary is ${tool.summary.length} characters, too long for a tooltip`);
      assert.match(tool.summary, /^[A-Z].*\.$/, `${tool.name} summary is not a sentence`);
    }
  });

  it('uses no em-dash in anything the user or agent sees', () => {
    for (const tool of TOOL_CATALOG) {
      assert.ok(!tool.description.includes('—'), `${tool.name} description contains an em-dash`);
      assert.ok(!tool.title.includes('—'), `${tool.name} title contains an em-dash`);
      assert.ok(!tool.summary.includes('—'), `${tool.name} summary contains an em-dash`);
    }
    assert.ok(!SERVER_INSTRUCTIONS.includes('—'));
  });

  it('documents every input property, because agents guess otherwise', () => {
    for (const tool of TOOL_CATALOG) {
      const shape = tool.inputSchema.shape as Record<string, { description?: string }>;
      for (const [key, field] of Object.entries(shape)) {
        const described = (field as { description?: string }).description
          ?? (field as { _def?: { description?: string } })._def?.description;
        assert.ok(described, `${tool.name}.${key} has no description`);
      }
    }
  });

  it('never points the agent at a tool this version does not ship', () => {
    // Planned tools named in prose before they exist send agents chasing ghosts.
    const planned = /\b(flash_app|set_build_config|delete_build_config|delete_build|clean_app|run_app|start_debug|debug_session|west_update|kconfig with action|get_job|read_job_log|cancel_job|install_component)\b/;
    for (const tool of TOOL_CATALOG) {
      assert.ok(!planned.test(tool.description), `${tool.name} mentions ${planned.exec(tool.description)?.[0]}`);
    }
    assert.ok(!planned.test(SERVER_INSTRUCTIONS), `the instructions mention ${planned.exec(SERVER_INSTRUCTIONS)?.[0]}`);
    const envHint = toToolError(Object.assign(new Error('no env'), { cause: 'zephyr-workbench.pathToEnvScript' })).hint ?? '';
    assert.ok(!/install_component/.test(envHint), 'the ENV_NOT_READY hint names tools that do not exist');
    assert.match(envHint, /check_environment/, 'the ENV_NOT_READY hint should send the agent to the environment check');
  });

  // The core preset, the default, serves no destructive tool: a plain "delete it with X" sends the agent to a tool it lacks.
  it('names a tool the core preset hides only as a tool of the full toolset', () => {
    const served = selectTools(TOOL_CATALOG, CORE);
    const hidden = TOOL_CATALOG.filter(tool => !served.includes(tool)).map(tool => tool.name);
    assert.ok(hidden.includes('remove_or_delete'));
    for (const tool of served) {
      const texts = [tool.description, ...Object.values(tool.inputSchema.shape as Record<string, { description?: string }>)
        .map(field => field.description ?? '')];
      for (const text of texts) {
        for (const name of hidden.filter(name => new RegExp(`\\b${name}\\b`).test(text))) {
          assert.match(text, /full toolset|AI Manager/, `${tool.name} names ${name} as if the core preset served it`);
        }
      }
    }
  });

  it('names only shipped tools in every error hint in the code', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const shipped = new Set(TOOL_CATALOG.map(tool => tool.name));
    const root = path.resolve(__dirname, '../../../mcp');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); } else if (entry.name.endsWith('.ts')) { files.push(full); }
      }
    };
    walk(root);
    // "Call <tool>" and "call <tool>" are how hints point at the next step.
    for (const file of files) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/[Cc]all ([a-z]+_[a-z_]+|job|kconfig)\b/g)) {
        assert.ok(shipped.has(match[1]), `${path.basename(file)} tells the agent to call ${match[1]}, which is not a tool`);
      }
    }
  });

  it('asks before every destructive tool, and never before a read', () => {
    for (const tool of TOOL_CATALOG) {
      if (tool.annotations.destructiveHint) {
        assert.ok(tool.confirm, `${tool.name} is destructive but never asks the user`);
      }
      if (tool.annotations.readOnlyHint) {
        assert.equal(tool.confirm, undefined, `${tool.name} is read-only and must not ask`);
      }
      if (tool.confirm && typeof tool.confirm === 'object') {
        const shape = tool.inputSchema.shape as Record<string, { options?: string[]; unwrap?: () => { options?: string[] } }>;
        const values = ['action', 'target', 'what']
          .flatMap(key => shape[key]?.options ?? shape[key]?.unwrap?.().options ?? []);
        for (const key of Object.keys(tool.confirm)) {
          assert.ok(values.includes(key), `${tool.name} asks for "${key}", which is not one of its actions`);
        }
      }
    }
  });

  it('routes only by arguments that exist and name folders', () => {
    for (const tool of TOOL_CATALOG) {
      const shape = tool.inputSchema.shape as Record<string, unknown>;
      for (const key of routeByOf(tool)) {
        if (tool.routeBy === undefined && !(key in shape)) {
          continue; // The default, for tools that take no app_path.
        }
        assert.ok(key in shape, `${tool.name} routes by ${key}, which it does not take`);
      }
    }
    // query_devicetree's path is a devicetree node, never a folder.
    assert.ok(!routeByOf(findTool('query_devicetree')!).includes('path'));
  });

  it('marks as machine-wide only actions the tool has', () => {
    for (const tool of TOOL_CATALOG) {
      const scope = tool.machineScope;
      if (scope && typeof scope === 'object') {
        const shape = tool.inputSchema.shape as Record<string, { options?: string[]; unwrap?: () => { options?: string[] } }>;
        const values = ['action', 'target', 'what'].flatMap(key => shape[key]?.options ?? shape[key]?.unwrap?.().options ?? []);
        for (const key of Object.keys(scope)) {
          assert.ok(values.includes(key), `${tool.name} marks "${key}" machine-wide, which is not one of its actions`);
        }
      }
    }
    assert.equal(isMachineScope(findTool('manage_toolchain')!, { action: 'install' }), true);
    assert.equal(isMachineScope(findTool('remove_or_delete')!, { what: 'toolchain' }), true);
    assert.equal(isMachineScope(findTool('remove_or_delete')!, { what: 'build_folder' }), false);
    assert.equal(isMachineScope(findTool('build_app')!, {}), false);
  });

  it('lets any window show the open_in_workbench wizards and Install Runners, which take no folder to route by', () => {
    const open = findTool('open_in_workbench')!;
    for (const target of ['add_application', 'add_west_workspace', 'add_toolchain', 'install_runners', 'pyocd_manager']) {
      assert.equal(isMachineScope(open, { target }), true, target);
    }
    // The build targets and managers go to the window holding the application.
    for (const target of [
      'file', 'dashboard', 'menuconfig', 'west_manager', 'terminal', 'debug_manager',
      'ram_plot', 'rom_plot', 'puncover', 'west_dashboard',
    ]) {
      assert.equal(isMachineScope(open, { target }), false, target);
    }
    // The pyOCD Manager of a configuration too: config_name picks the active application of a window.
    assert.equal(isMachineScope(open, { target: 'pyocd_manager', config_name: 'debug' }), false);
  });

  it('asks only before a flash or a serial send, and lets any window list and open a port but not flash', () => {
    const tool = findTool('hardware')!;
    assert.equal(confirmCategoryOf(tool, { action: 'serial_send' }), 'hardware');
    assert.equal(confirmCategoryOf(tool, { action: 'flash' }), 'hardware');
    for (const action of ['list_ports', 'serial_start', 'serial_read', 'serial_stop']) {
      assert.equal(confirmCategoryOf(tool, { action }), undefined, action);
    }
    // A flash needs the build of its application, so it goes to the window holding it.
    assert.equal(isMachineScope(tool, { action: 'flash' }), false);
    assert.equal(isMachineScope(tool, { action: 'list_ports' }), true);
    assert.equal(isMachineScope(tool, { action: 'serial_start' }), true);
    // Any window may answer a read, send or stop: one without the capture
    // refuses. A job_id still sends the call to the window running it, because
    // the bridge locks on the job's window before it looks at machine scope.
    for (const action of ['serial_read', 'serial_send', 'serial_stop']) {
      assert.equal(isMachineScope(tool, { action }), true, action);
    }
    assert.ok((tool.inputSchema.shape as Record<string, unknown>).job_id, 'job_id is an argument, so the bridge can route by it');
  });

  it('tells agents to capture before flashing only when the hardware tool is served', () => {
    const all = TOOL_CATALOG.map(t => t.name);
    assert.match(serverInstructions(all), /serial_start before flashing or resetting/);
    assert.doesNotMatch(serverInstructions(all.filter(name => name !== 'hardware')), /serial|hardware/);
  });

  it('never names in the instructions a tool the window does not serve', () => {
    const core = selectTools(TOOL_CATALOG, CORE).map(t => t.name);
    const text = serverInstructions(core);
    for (const hidden of TOOL_CATALOG.map(t => t.name).filter(name => !core.includes(name))) {
      assert.ok(!new RegExp(`\\b${hidden}\\b`).test(text), `the core instructions name ${hidden}`);
    }
    assert.match(serverInstructions(TOOL_CATALOG.map(t => t.name)), /manage_toolchain/);
  });

  it('never names a tool once it is taken out of the served set', () => {
    const all = TOOL_CATALOG.map(t => t.name);
    for (const name of all) {
      const text = serverInstructions(all.filter(other => other !== name));
      assert.ok(!new RegExp(`\\b${name}\\b`).test(text), `the instructions still name ${name} without it`);
    }
  });

  describe('instructions within what Claude Code shows', () => {
    // Claude Code cuts the instructions after 2048 characters.
    const SHOWN = 2048;
    const all = TOOL_CATALOG.map(t => t.name);

    it('fit with every tool served, with the core preset, and with the longest fallbacks', () => {
      const core = selectTools(TOOL_CATALOG, CORE).map(t => t.name);
      // Each tool left out is replaced by the longer name of its Workbench command.
      const fallbacks = all.filter(name => !['manage_toolchain', 'manage_west_workspace', 'manage_app', 'manage_runners'].includes(name));
      for (const [label, served] of [['full', all], ['core', core], ['fallbacks', fallbacks]] as const) {
        const text = serverInstructions(served);
        assert.ok(text.length <= SHOWN, `the ${label} instructions are ${text.length} characters`);
      }
    });

    it('put what this server is and the USER_DENIED rule first', () => {
      const text = serverInstructions(all);
      assert.match(text.split('\n')[0], /Zephyr Workbench VS Code extension[\s\S]*not the on-device Zephyr MCP server library/);
      const denied = text.indexOf('USER_DENIED');
      assert.ok(denied >= 0 && denied < 400, `USER_DENIED is at character ${denied}`);
      assert.ok(text.indexOf('CONFIRMATION_TIMEOUT') < SHOWN);
      assert.ok(text.indexOf('error.hint') < SHOWN);
    });

    it('describe debugging only when both debug tools are served', () => {
      assert.match(serverInstructions(all), /configure_debug action apply, then debug_app action start/);
      for (const name of ['configure_debug', 'debug_app']) {
        assert.doesNotMatch(serverInstructions(all.filter(other => other !== name)), /Debug:|configure_debug|debug_app/, name);
      }
    });

    it('send runner installs to manage_runners, or to the Install Runners command when it is not served', () => {
      assert.match(serverInstructions(all), /Install flash and debug tools with manage_runners;/);
      const without = serverInstructions(all.filter(name => name !== 'manage_runners'));
      assert.match(without, /Install flash and debug tools with the Workbench command "Install Runners" \(ask the user\);/);
      assert.match(without, /Never install tools from your own shell\./);
    });

    it('mention run_command only when it is served', () => {
      assert.match(serverInstructions(all), /Run other command lines with run_command, which has the Zephyr environment\./);
      assert.doesNotMatch(serverInstructions(all.filter(name => name !== 'run_command')), /run_command|command lines/);
    });

    it('keep the rules on jobs, Kconfig, configure and restarts', () => {
      const text = serverInstructions(all);
      assert.match(text, /job action "status"/);
      assert.match(text, /job action "log"/);
      assert.match(text, /Never run menuconfig or guiconfig: read and change Kconfig with query_kconfig and set_kconfig\./);
      assert.match(text, /with configure, not settings\.json/);
      assert.match(text, /restart_pending, wait a few seconds, then call get_status\./);
      assert.match(text, /flash with action flash \(wait_for waits for a boot line\)/);
      const dashes = [String.fromCharCode(0x2013), String.fromCharCode(0x2014)];
      assert.ok(!dashes.some(dash => text.includes(dash)), 'no en or em dash');
    });
  });

  it('keeps build_app closed-world, with the network only where it is needed', () => {
    assert.equal(findTool('build_app')?.annotations.openWorldHint, false);
    for (const name of ['manage_toolchain', 'manage_west_workspace', 'manage_app', 'search_zephyr_catalog', 'list_toolchains']) {
      assert.equal(findTool(name)?.annotations.openWorldHint, true, `${name} reaches the network`);
    }
  });

  it('annotates every tool with an explicit open-world hint', () => {
    for (const tool of TOOL_CATALOG) {
      assert.equal(typeof tool.annotations.openWorldHint, 'boolean', `${tool.name} must declare openWorldHint`);
    }
  });

  it('marks the query tools read-only so clients can skip approval', () => {
    for (const name of ['get_status', 'list_apps', 'get_build_info', 'query_devicetree']) {
      assert.equal(findTool(name)?.annotations.readOnlyHint, true, `${name} should be read-only`);
    }
    assert.notEqual(findTool('build_app')?.annotations.readOnlyHint, true, 'build_app changes the build directory');
  });

  it('stays well inside the client tool budget', () => {
    // VS Code caps a chat request at 128 tools across every extension, and
    // Cursor is reported to cut off near 40. 26 is this server's cap: the
    // debugger, the runners and the command line each got a tool of their
    // own, so the user can set each one's permission apart, and anything else
    // new joins an existing tool as an action.
    assert.ok(TOOL_CATALOG.length <= 26, `catalog has ${TOOL_CATALOG.length} tools`);
  });

  describe('permissions', () => {
    const tool = (name: string) => findTool(name)!;

    it('allows every tool under full, and nothing asks', () => {
      assert.equal(selectTools(TOOL_CATALOG, FULL).length, TOOL_CATALOG.length);
      assert.ok(TOOL_CATALOG.every(meta => permissionOf(meta, FULL) === 'allow'));
    });

    it('asks under core before what touches a board or changes the machine, and blocks only deleting', () => {
      const of = (name: string) => permissionOf(tool(name), CORE);
      assert.equal(of('build_app'), 'allow');
      assert.equal(of('get_status'), 'allow');
      // Settings changes do not ask under core.
      assert.equal(of('configure'), 'allow');
      assert.equal(of('configure_debug'), 'allow');
      for (const name of [
        'manage_app', 'hardware', 'manage_west_workspace', 'manage_toolchain', 'manage_runners', 'debug_app', 'run_command',
      ]) {
        assert.equal(of(name), 'ask', name);
      }
      assert.deepEqual(TOOL_CATALOG.filter(meta => permissionOf(meta, CORE) === 'block').map(meta => meta.name), ['remove_or_delete']);
    });

    it('takes each tool of custom from the user, and the core choice for a tool it does not name', () => {
      const custom = { preset: 'custom' as const, tools: { build_app: 'block' as const, remove_or_delete: 'ask' as const } };
      assert.equal(permissionOf(tool('build_app'), custom), 'block');
      assert.equal(permissionOf(tool('remove_or_delete'), custom), 'ask');
      assert.equal(permissionOf(tool('manage_toolchain'), custom), 'ask', 'a tool added later starts as core has it');
      assert.ok(!selectTools(TOOL_CATALOG, custom).some(meta => meta.name === 'build_app'));
    });

    it('serves only the read-only tools when the settings are locked', () => {
      const chosen = selectTools(TOOL_CATALOG, { ...FULL, locked: true });
      assert.ok(chosen.length > 0);
      assert.ok(chosen.every(t => t.annotations.readOnlyHint === true));
      assert.ok(!chosen.some(t => t.name === 'build_app'), 'build_app must not survive a lock');
    });

    it('keeps core a subset of full', () => {
      const core = selectTools(TOOL_CATALOG, CORE).map(t => t.name);
      const full = new Set(selectTools(TOOL_CATALOG, FULL).map(t => t.name));
      assert.ok(core.every(name => full.has(name)));
    });
  });

  describe('catalogVersion', () => {
    it('changes when the visible tool list changes', () => {
      const all = catalogVersion(TOOL_CATALOG);
      const fewer = catalogVersion(selectTools(TOOL_CATALOG, CORE));
      assert.notEqual(all, fewer, 'VS Code uses this to decide the tools changed');
    });
    it('is stable for the same list', () => {
      assert.equal(catalogVersion(TOOL_CATALOG), catalogVersion(TOOL_CATALOG));
    });
  });
});
