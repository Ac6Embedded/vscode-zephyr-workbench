// Utility function to enforce block style in YAML nodes

export function formatYml(node: any): void {
  if (!node || typeof node !== "object") return;

  // If it's a document node, apply recursively to its main contents
  if (node.type === "DOCUMENT" && node.contents) {
    formatYml(node.contents);
    return;
  }

  // If it's a map or sequence, force block style
  if (node.type === "MAP" || node.type === "SEQ") {
    node.flow = false;

    if (Array.isArray(node.items)) {
      for (const item of node.items) {
        if (item.key) formatYml(item.key);
        if (item.value) formatYml(item.value);
      }
    }
  }

  // If the node contains a nested value, apply recursively
  if (node.value && typeof node.value === "object") {
    formatYml(node.value);
  }
}
