// Build-artifact queries. None of these build anything, so they are safe to
// call repeatedly, and because they read the artifacts directly they work with
// sysbuild, unlike the west report targets.

import * as fs from 'fs';
import { readRunnersYamlForProject, findRunnersYamlForBuildDir, readRunnersYamlFile } from '../../../utils/zephyr/runnersYamlUtils';
import { getDomainBuildDir, readDomainsForBuildDir } from '../../../utils/zephyr/domainsYamlUtils';
import { getStaticFlashRunnerNames } from '../../../utils/debugTools/debugUtils';
import { BuildReportSection, collectBuildReport } from '../../../utils/zephyr/buildReport';
import { ZephyrMemoryTreeNode } from '../../../utils/zephyr/memoryTreeParser';
import { McpToolError } from '../../core/errors';
import { matcherFor } from '../../core/match';
import { ToolContext, ToolHandler } from '../../core/toolSpec';
import { HostDeps } from './deps';
import { explainKconfig, minimalKconfig } from './kconfig';

type Ctx = ToolContext<HostDeps>;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);

function requireBuilt(built: boolean, buildDir: string, what: string): void {
  if (!built) {
    throw new McpToolError('NOT_BUILT', `${what} needs a completed build, and "${buildDir}" has none.`, {
      hint: 'Call build_app first, then retry.',
    });
  }
}

/** Resolve app, config and an optional validated sysbuild domain in one step. */
async function target(ctx: Ctx, args: Record<string, unknown>) {
  const { services } = ctx.deps;
  const resolved = await services.resolveTarget(str(args.app_path), str(args.config_name));
  const domain = services.resolveDomain(resolved.app, resolved.config, str(args.domain));
  return { ...resolved, domain, paths: services.artifactPaths(resolved.app, resolved.config, domain) };
}

export const getBuildInfo: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const { services } = ctx.deps;
  const { app, config, buildDir, domain, paths } = await target(ctx, args);
  const extra = Array.isArray(args.include) ? (args.include as string[]) : [];
  const sections: BuildReportSection[] = ['summary', 'memory'];
  if (extra.includes('sys_init')) { sections.push('sysInit'); }
  if (extra.includes('elf_stat')) { sections.push('elfStat'); }

  const report = collectBuildReport(paths, sections);
  return {
    app_path: app.appRootPath,
    config_name: config.name,
    ...(domain ? { domain } : {}),
    board: config.boardIdentifier,
    build_dir: buildDir,
    configured: report.configured,
    built: report.built,
    last_build_time: report.summary?.lastBuildTimeMs
      ? new Date(report.summary.lastBuildTimeMs).toISOString()
      : undefined,
    target: report.summary?.target,
    toolchain: report.summary?.toolchain,
    image: report.summary?.image,
    memory: report.summary?.memoryCapacities,
    artifacts: report.summary?.artifacts,
    ...(extra.includes('sources') ? { sources: report.summary?.sources } : {}),
    ...(extra.includes('domains') ? { domains: services.listDomains(app, config) ?? null } : {}),
    ...(extra.includes('sys_init') ? { sys_init: report.sysInit } : {}),
    ...(extra.includes('elf_stat') ? { elf_stat: report.elfStat } : {}),
    ...(Object.keys(report.errors).length ? { errors: report.errors } : {}),
  };
};

interface PrunedNode {
  name: string;
  size: number;
  children?: PrunedNode[];
  more_children?: number;
}

/** Bound a DWARF source tree: depth, minimum size and children per node. */
function pruneTree(node: ZephyrMemoryTreeNode, depth: number, top: number, minSize: number): PrunedNode {
  const out: PrunedNode = { name: node.name, size: node.size };
  if (depth <= 0 || !node.children || node.children.length === 0) {
    return out;
  }
  const kept = node.children
    .filter(child => child.size >= minSize)
    .sort((a, b) => b.size - a.size);
  out.children = kept.slice(0, top).map(child => pruneTree(child, depth - 1, top, minSize));
  if (kept.length > top) {
    out.more_children = kept.length - top;
  }
  return out;
}

/**
 * Find the subtree for a source path fragment such as "drivers/gpio": the first
 * node, at any depth, whose name is the first segment and whose descendants
 * follow the remaining segments.
 */
function findSubtree(root: ZephyrMemoryTreeNode, prefix: string): ZephyrMemoryTreeNode | undefined {
  const segments = prefix.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) {
    return root;
  }
  const queue: ZephyrMemoryTreeNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift() as ZephyrMemoryTreeNode;
    if (node.name === segments[0]) {
      let cursor: ZephyrMemoryTreeNode | undefined = node;
      for (const segment of segments.slice(1)) {
        cursor = cursor?.children?.find(child => child.name === segment);
      }
      if (cursor) {
        return cursor;
      }
    }
    queue.push(...(node.children ?? []));
  }
  return undefined;
}

export const getMemoryReport: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const { buildDir, paths } = await target(ctx, args);
  const view = str(args.view) ?? 'sections';
  const region = str(args.region) ?? 'both';
  const top = num(args.top) ?? 25;
  const minSize = num(args.min_size_bytes) ?? 0;
  const prefix = str(args.path_prefix);
  const depth = num(args.depth) ?? 3;

  if (prefix && view !== 'tree') {
    // Symbols and sections carry no source file, so a path filter cannot apply
    // to them. Refuse rather than silently return nothing.
    throw new McpToolError('INVALID_ARGUMENT', 'path_prefix only works with view "tree", which groups memory by source path.', {
      hint: 'Call get_memory_report again with view "tree" and the same path_prefix.',
    });
  }

  const report = collectBuildReport(paths, view === 'tree' ? ['summary', 'memoryTree'] : ['summary', 'memory']);
  requireBuilt(report.built, buildDir, 'get_memory_report');

  const buckets = region === 'both' ? (['rom', 'ram'] as const) : ([region] as ('rom' | 'ram')[]);
  const out: Record<string, unknown> = { elf_path: paths.elfPath, view, region };
  const parseError = view === 'tree' ? report.errors.memoryTree : report.errors.memory;
  if (parseError && buckets.every(bucket => !(view === 'tree' ? report.memoryTree?.[bucket] : report.memory?.[bucket]))) {
    // Nothing could be read: say why rather than return an empty report.
    throw new McpToolError('INTERNAL', `Could not read the memory usage of ${paths.elfPath}: ${parseError}`, {
      hint: view === 'tree'
        ? 'The tree view needs debug information in zephyr.elf. Try view "sections", or rebuild.'
        : 'Rebuild with build_app, then retry.',
    });
  }
  if (Object.keys(report.errors).length > 0) {
    out.errors = report.errors;
  }

  for (const bucket of buckets) {
    if (view === 'tree') {
      const tree = report.memoryTree?.[bucket];
      if (!tree) {
        continue;
      }
      const start = prefix ? findSubtree(tree.root, prefix) : tree.root;
      out[bucket] = start
        ? { total_bytes: tree.total, tree: pruneTree(start, depth, top, minSize) }
        : { total_bytes: tree.total, tree: null, note: `No source path "${prefix}" in the ${bucket.toUpperCase()} tree.` };
      continue;
    }
    const data = report.memory?.[bucket];
    if (!data) {
      continue;
    }
    if (view === 'symbols') {
      out[bucket] = {
        total_bytes: data.totalBytes,
        symbols: data.sections
          .flatMap(section => section.symbols)
          .filter(symbol => symbol.size >= minSize)
          .sort((a, b) => b.size - a.size)
          .slice(0, top)
          .map(symbol => ({ name: symbol.name, size: symbol.size, section: symbol.sectionName, address_hex: symbol.addressHex })),
      };
    } else {
      out[bucket] = {
        total_bytes: data.totalBytes,
        sections: data.sections
          .filter(section => section.size >= minSize)
          .sort((a, b) => b.size - a.size)
          .slice(0, top)
          .map(section => ({
            name: section.name,
            size: section.size,
            address_hex: section.addressHex,
            category: section.category,
            symbols_bytes: section.symbolsBytes,
          })),
      };
    }
  }
  return out;
};

/** Origins that mean a symbol was deliberately set, as opposed to defaulted. */
const EXPLICIT_SOURCES = new Set(['assign', 'select', 'imply']);

export const queryKconfig: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const format = str(args.format) ?? 'values';
  if (format !== 'values' && format !== 'defconfig') {
    throw new McpToolError('INVALID_ARGUMENT', 'format must be values or defconfig.');
  }
  if (format === 'defconfig') {
    // The minimal configuration comes from the live Kconfig tree, like explain.
    return minimalKconfig(args, ctx);
  }
  if (bool(args.explain)) {
    // Needs the live Kconfig tree rather than the build output.
    return explainKconfig(args, ctx);
  }
  const { buildDir, paths } = await target(ctx, args);
  const report = collectBuildReport(paths, ['summary', 'kconfig']);
  if (!report.kconfig) {
    throw new McpToolError('BUILD_NOT_CONFIGURED', `No Kconfig output in "${buildDir}".`, {
      hint: 'Call build_app with cmake_only true to configure, then retry.',
    });
  }
  const kconfig = report.kconfig;
  const names = Array.isArray(args.symbols) ? (args.symbols as string[]).map(n => n.replace(/^CONFIG_/, '')) : undefined;
  const matches = matcherFor(str(args.pattern));
  const onlySet = bool(args.only_set) ?? false;
  const limit = num(args.limit) ?? 50;
  const offset = num(args.offset) ?? 0;

  // Without the configuration trace every symbol's origin is unknown, so
  // "only explicitly set" cannot be answered honestly.
  const originKnown = kconfig.source === 'trace';

  const selected = kconfig.symbols.filter(symbol => {
    if (onlySet && originKnown && !EXPLICIT_SOURCES.has(symbol.source)) { return false; }
    if (names && !names.includes(symbol.name.replace(/^CONFIG_/, ''))) { return false; }
    if (matches && !matches(symbol.name)) { return false; }
    return true;
  });

  return {
    config_path: kconfig.configPath,
    source: kconfig.source,
    ...(onlySet && !originKnown
      ? { note: 'This build has no configuration trace, so only_set could not be applied: every symbol is listed.' }
      : {}),
    total_matches: selected.length,
    symbols: selected.slice(offset, offset + limit).map(symbol => ({
      name: symbol.name,
      type: symbol.type,
      value: symbol.value,
      origin: symbol.source,
      visible: symbol.visible,
      location: symbol.locPath ? { file: symbol.locPath, line: symbol.locLine } : undefined,
    })),
    next_offset: offset + limit < selected.length ? offset + limit : undefined,
  };
};

/** Characters of node text returned per node by include_source. */
const NODE_TEXT_LIMIT = 2000;
/**
 * Characters of nodes per page. The result goes out as text and as structured
 * content, and query_devicetree declares 100000 characters at most.
 */
const PAGE_BUDGET = 40000;

export const queryDevicetree: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const { buildDir, paths } = await target(ctx, args);
  const report = collectBuildReport(paths, ['deviceTree']);
  if (!report.deviceTree) {
    throw new McpToolError('NOT_BUILT', `No resolved devicetree in "${buildDir}".`, {
      hint: 'Call build_app with cmake_only true to generate zephyr.dts, then retry.',
      details: report.errors,
    });
  }
  const wantPath = str(args.path);
  const wantLabel = str(args.label);
  const wantCompatible = str(args.compatible);
  const wantStatus = str(args.status);
  const matches = matcherFor(str(args.pattern));
  const limit = num(args.limit) ?? 40;
  const offset = num(args.offset) ?? 0;
  const includeSource = bool(args.include_source) ?? false;

  const compatiblesOf = (node: { compatible?: string; compatibles?: string[] }) =>
    node.compatibles ?? (node.compatible ? [node.compatible] : []);
  const selected = report.deviceTree.nodes.filter(node => {
    if (wantPath && node.path !== wantPath) { return false; }
    if (wantLabel && !node.labels.includes(wantLabel)) { return false; }
    // Any entry of the list counts: "st,stm32-uart" is often the second one.
    if (wantCompatible && !compatiblesOf(node).includes(wantCompatible)) { return false; }
    if (wantStatus && (node.status ?? 'okay') !== wantStatus) { return false; }
    if (matches && !matches(`${node.path} ${node.labels.join(' ')} ${compatiblesOf(node).join(' ')}`)) { return false; }
    return true;
  });

  const page = selected.slice(offset, offset + limit);
  // The merged node text, with every property, from zephyr.dts itself.
  let dtsLines: string[] | undefined;
  if (includeSource && page.length > 0) {
    try {
      dtsLines = fs.readFileSync(report.deviceTree.dtsPath, 'utf8').split(/\r?\n/);
    } catch {
      dtsLines = undefined;
    }
  }
  const nodeText = (node: { bodyStart?: number; bodyEnd?: number }) => {
    if (!dtsLines || node.bodyStart === undefined) {
      return undefined;
    }
    const text = dtsLines.slice(node.bodyStart, (node.bodyEnd ?? node.bodyStart) + 1).join('\n');
    return text.length > NODE_TEXT_LIMIT ? `${text.slice(0, NODE_TEXT_LIMIT)}\n...` : text;
  };

  // Node text makes entries large, so the page also stops at a size budget
  // below the result size the tool declares, and next_offset picks up there.
  const nodes: Record<string, unknown>[] = [];
  let used = 0;
  for (const node of page) {
    const text = nodeText(node);
    const entry = {
      path: node.path,
      name: node.name,
      labels: node.labels,
      compatible: compatiblesOf(node),
      status: node.status,
      defined_at: node.sourcePath ? { file: node.sourcePath, line: node.sourceLine } : undefined,
      ...(text !== undefined ? { source: text } : {}),
    };
    const size = JSON.stringify(entry).length;
    if (nodes.length > 0 && used + size > PAGE_BUDGET) {
      break;
    }
    nodes.push(entry);
    used += size;
  }
  const next = offset + nodes.length;

  return {
    dts_path: report.deviceTree.dtsPath,
    total_nodes: report.deviceTree.totalNodes,
    total_matches: selected.length,
    nodes,
    next_offset: next < selected.length ? next : undefined,
  };
};

export const listRunners: ToolHandler<HostDeps> = async (args, ctx: Ctx) => {
  const { app, config, buildDir, domain } = await target(ctx, args);
  let parsed = domain ? undefined : readRunnersYamlForProject(app, config);
  if (domain) {
    const domainDir = getDomainBuildDir(readDomainsForBuildDir(buildDir), domain);
    const file = domainDir ? findRunnersYamlForBuildDir(domainDir) : undefined;
    parsed = file ? readRunnersYamlFile(file) : undefined;
  }
  if (!parsed) {
    return {
      built: false,
      configured_runner: config.defaultRunner || undefined,
      runners: getStaticFlashRunnerNames().map(name => ({ name, compatible: false })),
      note: `No runners.yaml in "${buildDir}", so this is the full static list rather than what this board supports. Build first for the real list.`,
    };
  }
  return {
    built: true,
    ...(domain ? { domain } : {}),
    default_flash_runner: parsed.defaultFlashRunner,
    default_debug_runner: parsed.defaultDebugRunner,
    configured_runner: config.defaultRunner || undefined,
    configured_runner_args: config.customArgs || undefined,
    runners: parsed.runners.map(name => ({ name, compatible: true })),
  };
};
