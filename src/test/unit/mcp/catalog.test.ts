import { strict as assert } from 'assert';
import { SERVER_INSTRUCTIONS, SERVER_NAME, TOOL_CATALOG, findTool, serverInstructions } from '../../../mcp/core/catalog';
import { catalogVersion, confirmCategoryOf, isMachineScope, routeByOf, selectTools } from '../../../mcp/core/toolSpec';
import { toToolError } from '../../../mcp/core/errors';

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

  it('uses no em-dash in anything the user or agent sees', () => {
    for (const tool of TOOL_CATALOG) {
      assert.ok(!tool.description.includes('—'), `${tool.name} description contains an em-dash`);
      assert.ok(!tool.title.includes('—'), `${tool.name} title contains an em-dash`);
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

  it('lets any window show the open_in_workbench wizards, which take no folder to route by', () => {
    const open = findTool('open_in_workbench')!;
    for (const target of ['add_application', 'add_west_workspace', 'add_toolchain']) {
      assert.equal(isMachineScope(open, { target }), true, target);
    }
    for (const target of ['file', 'dashboard', 'menuconfig', 'west_manager', 'terminal']) {
      assert.equal(isMachineScope(open, { target }), false, target);
    }
  });

  it('asks only before a serial send, and lets any window list and open a port', () => {
    const tool = findTool('hardware')!;
    assert.deepEqual(tool.toolsets, ['core']);
    assert.equal(confirmCategoryOf(tool, { action: 'serial_send' }), 'hardware');
    for (const action of ['list_ports', 'serial_start', 'serial_read', 'serial_stop']) {
      assert.equal(confirmCategoryOf(tool, { action }), undefined, action);
    }
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
    const core = selectTools(TOOL_CATALOG, 'core').map(t => t.name);
    const text = serverInstructions(core);
    for (const hidden of TOOL_CATALOG.map(t => t.name).filter(name => !core.includes(name))) {
      assert.ok(!new RegExp(`\\b${hidden}\\b`).test(text), `the core instructions name ${hidden}`);
    }
    assert.match(serverInstructions(TOOL_CATALOG.map(t => t.name)), /manage_toolchain/);
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
    // Cursor is reported to cut off near 40. 22 is this server's cap, and
    // hardware holds the last slot: flash, run and debug become its actions,
    // and anything else new joins an existing tool as an action.
    assert.ok(TOOL_CATALOG.length <= 22, `catalog has ${TOOL_CATALOG.length} tools`);
  });

  describe('selectTools', () => {
    it('returns everything for the full toolset', () => {
      assert.equal(selectTools(TOOL_CATALOG, 'full').length, TOOL_CATALOG.length);
    });
    it('returns only read-only tools for the read-only toolset', () => {
      const chosen = selectTools(TOOL_CATALOG, 'read-only');
      assert.ok(chosen.length > 0);
      assert.ok(chosen.every(t => t.annotations.readOnlyHint === true));
      assert.ok(!chosen.some(t => t.name === 'build_app'), 'build_app must not survive read-only');
    });
    it('honours the disabled list in every toolset', () => {
      assert.ok(!selectTools(TOOL_CATALOG, 'full', ['build_app']).some(t => t.name === 'build_app'));
      assert.ok(!selectTools(TOOL_CATALOG, 'core', ['list_apps']).some(t => t.name === 'list_apps'));
    });
    it('keeps the core toolset a subset of full', () => {
      const core = selectTools(TOOL_CATALOG, 'core').map(t => t.name);
      const full = new Set(selectTools(TOOL_CATALOG, 'full').map(t => t.name));
      assert.ok(core.every(name => full.has(name)));
    });
  });

  describe('catalogVersion', () => {
    it('changes when the visible tool list changes', () => {
      const all = catalogVersion(TOOL_CATALOG);
      const fewer = catalogVersion(selectTools(TOOL_CATALOG, 'read-only'));
      assert.notEqual(all, fewer, 'VS Code uses this to decide the tools changed');
    });
    it('is stable for the same list', () => {
      assert.equal(catalogVersion(TOOL_CATALOG), catalogVersion(TOOL_CATALOG));
    });
  });
});
