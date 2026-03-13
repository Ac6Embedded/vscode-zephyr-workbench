
export interface EclairTemplate {
  title: string;
  kind: EclairTemplateKind;
  description: string;
  authors: string[];
  provides: Record<string, AnyDataValue>;
  requires: Record<string, AnyDataValue>;
  deps: string[];
  options: EclairTemplateOption[];
}

export type AnyDataValue = string | number | boolean | null | AnyDataValue[] | { [key: string]: AnyDataValue };

export const all_eclair_template_kinds = ["ruleset", "variant", "tailoring"] as const;
export type EclairTemplateKind = typeof all_eclair_template_kinds[number];

export type EclairTemplateOption = {
  id: string;
  title?: string;
  description?: string;
  variant: EclairTemplateOptionVariant;
};

export type EclairTemplateOptionVariant =
  EclairTemplateGroupOption |
  EclairTemplateFlagOption |
  EclairTemplateSelectOption;

export type EclairTemplateGroupOption = {
  kind: "group";
  children: EclairTemplateOption[];
};

export type EclairTemplateFlagOption = {
  kind: "flag";
  default?: boolean;
};

export type EclairTemplateSelectOption = {
  kind: "select";
  values: EclairTemplateSelectValue[];
  default: string;
};

export type EclairTemplateSelectValue = {
  value: string;
  description?: string;
};

