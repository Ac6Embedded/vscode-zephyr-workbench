// The console baud rate of a build, read from its merged devicetree: the node
// /chosen names as zephyr,console, and that node's current-speed. Pure over the
// nodes the devicetree report parser found and the lines of zephyr.dts, so it
// is tested on fixtures and stays free of any file access.

/** The part of a parsed devicetree node this needs. */
export interface DtsNodeRef {
  path: string;
  labels: string[];
  /** First and last line of the node in zephyr.dts, zero based. */
  bodyStart?: number;
  bodyEnd?: number;
}

export interface ConsoleSpeed {
  /** The console node's path. */
  node: string;
  /** Its current-speed, when it has one. */
  baud?: number;
}

/** The properties of a node itself, skipping the bodies of its child nodes. */
function ownPropertyLines(node: DtsNodeRef, lines: readonly string[]): string[] {
  if (node.bodyStart === undefined) {
    return [];
  }
  const end = Math.min(node.bodyEnd ?? node.bodyStart, lines.length - 1);
  const own: string[] = [];
  let depth = 0;
  for (let index = node.bodyStart + 1; index < end; index++) {
    const line = lines[index].replace(/\/\*.*?\*\//g, '').trim();
    if (line.endsWith('{')) {
      depth++;
    } else if (line === '};' || line === '}') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && line) {
      own.push(line);
    }
  }
  return own;
}

/** The value text of `name = ...;` among a node's own lines. */
function propertyValue(own: readonly string[], name: string): string | undefined {
  const prefix = `${name} =`;
  const line = own.find(entry => entry.startsWith(prefix));
  return line === undefined ? undefined : line.slice(prefix.length).replace(/;\s*$/, '').trim();
}

/**
 * The node a chosen property points at: &label, &{/path}, or "/path". A
 * string that is not a path is an alias, looked up in /aliases.
 */
function resolveReference(value: string, nodes: readonly DtsNodeRef[], lines: readonly string[]): DtsNodeRef | undefined {
  const byPath = (target: string) => nodes.find(node => node.path === target);
  const label = /^&([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  if (label) {
    return nodes.find(node => node.labels.includes(label[1]));
  }
  const pathRef = /^&\{([^}]+)\}$/.exec(value) ?? /^"(\/[^"]*)"$/.exec(value);
  if (pathRef) {
    return byPath(pathRef[1]);
  }
  const alias = /^"([^"/]+)"$/.exec(value);
  const aliases = alias ? byPath('/aliases') : undefined;
  if (!alias || !aliases) {
    return undefined;
  }
  // An alias names a node by label or path, never by another alias.
  const target = propertyValue(ownPropertyLines(aliases, lines), alias[1]);
  return target && /^(&|"\/)/.test(target) ? resolveReference(target, nodes, lines) : undefined;
}

/** A single-cell value such as < 0x1c200 > or < 115200 >. */
function singleCell(value: string | undefined): number | undefined {
  const cell = value ? /^<\s*(0x[0-9a-fA-F]+|\d+)\s*>$/.exec(value) : null;
  if (!cell) {
    return undefined;
  }
  const parsed = Number(cell[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The chosen console of a devicetree and its current-speed. Undefined when
 * the devicetree names no console or the console node is not in it.
 */
export function consoleSpeedFromDevicetree(nodes: readonly DtsNodeRef[], lines: readonly string[]): ConsoleSpeed | undefined {
  const chosen = nodes.find(node => node.path === '/chosen');
  if (!chosen) {
    return undefined;
  }
  const reference = propertyValue(ownPropertyLines(chosen, lines), 'zephyr,console');
  const consoleNode = reference ? resolveReference(reference, nodes, lines) : undefined;
  if (!consoleNode) {
    return undefined;
  }
  const baud = singleCell(propertyValue(ownPropertyLines(consoleNode, lines), 'current-speed'));
  return { node: consoleNode.path, ...(baud !== undefined ? { baud } : {}) };
}
