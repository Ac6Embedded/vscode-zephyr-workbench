import {
  AnyDataValue,
  all_eclair_template_kinds,
  EclairTemplate,
  EclairTemplateKind,
  EclairTemplateOption,
  EclairTemplateSelectValue,
} from "./template";


function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function extract_yaml_from_ecl_content(ecl_text: string): string | undefined {
  const lines = ecl_text.split(/\r?\n/);

  // New syntax: YAML is embedded in a fenced code block:
  // ```ECL:
  // title: ...
  // ```
  // The closing fence must use the same number of backticks as the opening.
  const open_re = /^(?<ticks>`{3,})\s*ECL:\s*$/;

  let start_index = -1;
  let closing_fence: string | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    const m = trimmed.match(open_re);
    if (m?.groups?.ticks) {
      start_index = i + 1;
      closing_fence = m.groups.ticks;
      break;
    }
  }

  if (start_index === -1 || !closing_fence) {
    return undefined;
  }

  let end_index = -1;
  for (let i = start_index; i < lines.length; i += 1) {
    if (lines[i].trim() === closing_fence) {
      end_index = i;
      break;
    }
  }

  if (end_index === -1) {
    return undefined;
  }

  return lines.slice(start_index, end_index).join("\n");
}

function parse_string(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid template: ${field} must be a string`);
  }
  return value;
}

function parse_description(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  throw new Error("Invalid template: description must be a string");
}

function parse_authors(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Invalid template: authors must be an array of strings");
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`Invalid template: authors[${index}] must be a string`);
    }
    return item;
  });
}

function parse_map(value: unknown, field: string): Record<string, AnyDataValue> {
  if (value === undefined || value === null) {
    return {};
  }
  if (Array.isArray(value)) {
    const entries: [string, AnyDataValue][] = value.map((item) => {
      if (typeof item === "string") {
        return [item, true];
      }
      throw new Error(`Invalid template: ${field} array items must be strings`);
    });
    return Object.fromEntries(entries);
  }
  if (is_record(value)) {
    return Object.fromEntries(Object.entries(value) as [string, AnyDataValue][]);
  }
  throw new Error(`Invalid template: ${field} must be an object or an array`);
}

function parse_deps(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Invalid template: deps must be an array of strings");
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`Invalid template: deps[${index}] must be a string`);
    }
    return item;
  });
}

function parse_option(value: unknown): EclairTemplateOption {
  if (!is_record(value)) {
    throw new Error("Invalid template: option must be an object");
  }

  const id = parse_string(value.id, "option.id");
  const title = typeof value.title === "string" ? value.title : undefined;
  const description = typeof value.description === "string" ? value.description : undefined;

  const kind_value = value.kind ?? value.variant;
  if (!is_record(kind_value) && typeof kind_value !== "string") {
    throw new Error("Invalid template: option.kind must be a string or object");
  }

  const kind = typeof kind_value === "string" ? kind_value : kind_value.kind;
  if (kind === "group") {
    const children_raw = typeof kind_value === "string" ? value.children : kind_value.children;
    if (!Array.isArray(children_raw)) {
      throw new Error("Invalid template: group option requires children array");
    }
    const children = children_raw.map(parse_option);
    return {
      id,
      title,
      description,
      variant: {
        kind: "group",
        children,
      },
    };
  }

  if (kind === "flag") {
    const default_value = typeof kind_value === "string" ? value.default : kind_value.default;
    if (default_value !== undefined && typeof default_value !== "boolean") {
      throw new Error("Invalid template: flag option default must be boolean");
    }
    return {
      id,
      title,
      description,
      variant: {
        kind: "flag",
        default: default_value,
      },
    };
  }

  if (kind === "select") {
    const values_raw = typeof kind_value === "string" ? value.values : kind_value.values;
    if (!Array.isArray(values_raw) || values_raw.length === 0) {
      throw new Error("Invalid template: select option requires non-empty values array");
    }
    const values = values_raw.map((item, index): EclairTemplateSelectValue => {
      if (typeof item === "string") {
        return { value: item };
      }
      if (!is_record(item)) {
        throw new Error(`Invalid template: select option values[${index}] must be a string or object`);
      }
      const item_value = parse_string(item.value, `select option values[${index}].value`);
      const description = item.description;
      if (description !== undefined && typeof description !== "string") {
        throw new Error(`Invalid template: select option values[${index}].description must be a string`);
      }
      return description === undefined ? { value: item_value } : { value: item_value, description };
    });

    const default_value = typeof kind_value === "string" ? value.default : kind_value.default;
    if (typeof default_value !== "string") {
      throw new Error("Invalid template: select option default must be a string");
    }
    if (!values.some((item) => item.value === default_value)) {
      throw new Error("Invalid template: select option default must be one of the values");
    }

    return {
      id,
      title,
      description,
      variant: {
        kind: "select",
        values,
        default: default_value,
      },
    };
  }

  throw new Error("Invalid template: option.kind must be 'group', 'flag', or 'select'");
}

function parse_options(value: unknown): EclairTemplateOption[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Invalid template: options must be an array");
  }
  return value.map(parse_option);
}

export function parse_eclair_template_from_any(data: unknown): EclairTemplate {
  if (!is_record(data)) {
    throw new Error("Invalid template: expected an object");
  }

  const title = parse_string(data.title, "title");
  if (data.kind === undefined || typeof data.kind !== "string" || !all_eclair_template_kinds.includes(data.kind as EclairTemplateKind)) {
    throw new Error("Invalid template: kind must be one of 'ruleset', 'variant', 'tailoring'");
  }
  const kind: EclairTemplateKind = data.kind as EclairTemplateKind;

  const description = parse_description(data.description);
  const authors = parse_authors(data.authors);
  const provides = parse_map(data.provides, "provides");
  const requires = parse_map(data.requires, "requires");
  const deps = parse_deps(data.deps);
  const options = parse_options(data.options);

  return {
    title,
    kind,
    description,
    authors,
    provides,
    requires,
    deps,
    options,
  };
}

export type OptionValue = boolean | string;
export type EclairOptionSetting = EclairSetFlag | EclairSetSelect;

export interface EclairSetFlag {
  kind: "flag";
  flag_id: string;
  ecl_id: string;
  source: "default" | "user";
  statement: string,
}

export interface EclairSetSelect {
  kind: "select";
  option_id: string;
  ecl_id: string;
  source: "default" | "user";
  value: string;
  statement: string;
}

type ResolvedOptionSettings = {
  flags: Map<string, boolean>;
  selects: Map<string, string>;
  order: { kind: "flag" | "select"; id: string }[];
  select_values: Map<string, string[]>;
};

function resolve_option_settings(
  template: EclairTemplate,
  selected_options: Record<string, OptionValue>,
): ResolvedOptionSettings {
  const flags = new Map<string, boolean>();
  const selects = new Map<string, string>();
  const order: { kind: "flag" | "select"; id: string }[] = [];
  const select_values = new Map<string, string[]>();

  const collect = (options: EclairTemplateOption[]) => {
    for (const option of options) {
      if (option.variant.kind === "group") {
        collect(option.variant.children);
      } else if (option.variant.kind === "flag") {
        flags.set(option.id, option.variant.default ?? false);
        order.push({ kind: "flag", id: option.id });
      } else if (option.variant.kind === "select") {
        select_values.set(option.id, option.variant.values.map((item) => item.value));
        selects.set(option.id, option.variant.default);
        order.push({ kind: "select", id: option.id });
      }
    }
  };

  collect(template.options);

  for (const option_id in selected_options) {
    const value = selected_options[option_id];
    if (typeof value === "boolean") {
      if (!flags.has(option_id)) {
        throw new Error(`Unknown flag: ${option_id}`);
      }
      flags.set(option_id, value);
    } else if (typeof value === "string") {
      const allowed = select_values.get(option_id);
      if (!allowed) {
        throw new Error(`Unknown select option: ${option_id}`);
      }
      if (!allowed.includes(value)) {
        throw new Error(`Invalid value for ${option_id}: ${value}`);
      }
      selects.set(option_id, value);
    }
  }

  return { flags, selects, order, select_values };
}

export function format_option_settings(
  template: EclairTemplate,
  selected_options: Record<string, OptionValue>,
): EclairOptionSetting[] {
  const { flags, selects, order } = resolve_option_settings(template, selected_options);
  return order.flatMap((entry): EclairOptionSetting[] => {
    if (entry.kind === "flag") {
      const ecl_id = flag_to_ecl_identifier(entry.id);
      return [{
        kind: "flag",
        flag_id: entry.id,
        ecl_id,
        source: selected_options[entry.id] === undefined ? "default" : "user",
        statement: `setq(${ecl_id},${flags.get(entry.id) ? "1" : "nil"})`,
      }];
    }

    const value = selects.get(entry.id);
    if (value === undefined) {
      return [];
    }
    const ecl_id = flag_to_ecl_identifier(entry.id);
    return [{
      kind: "select",
      option_id: entry.id,
      ecl_id,
      source: selected_options[entry.id] === undefined ? "default" : "user",
      value,
      statement: `-setq=${ecl_id},"${value.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"")}"`,
    }];
  });
}


export function flag_to_ecl_identifier(flag: string): string {
  const ecl_identifier = flag
    .toLowerCase()
    .replace(/[^a-zA-Z0-9_]/g, "_");

  if (/^\d/.test(ecl_identifier)) {
    return "_" + ecl_identifier;
  }
  return ecl_identifier;
}
