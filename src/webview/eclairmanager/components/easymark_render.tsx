import React, { useMemo } from "react";
import { Item, Style, parseEasyMark } from "./easymark";
import { match } from "ts-pattern";

function apply_style_tags(children: React.ReactNode, style: Style): React.ReactNode {
  let node = children;
  if (style.code) {
    return (<code>{node}</code>);
  }
  if (style.strong) {
    return (<strong>{node}</strong>);
  }
  if (style.italics) {
    return (<em>{node}</em>);
  }
  if (style.underline) {
    return (<u>{node}</u>);
  }
  if (style.strikethrough) {
    return (<s>{node}</s>);
  }
  if (style.small) {
    return (<small>{node}</small>);
  }
  if (style.raised) {
    return (<sup>{node}</sup>);
  }
  return node;
}

function render_inline_item(item: Item, key: React.Key): React.ReactNode {
  if (item.type === "Text") {
    return <React.Fragment key={key}>{apply_style_tags(item.text, item.style)}</React.Fragment>;
  }
  if (item.type === "Hyperlink") {
    return <a key={key} href={item.url}>{apply_style_tags(item.text, item.style)}</a>;
  }
  return null;
}

function render_inline_items(items: Item[]): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let i = 0;
  for (const item of items) {
    const node = render_inline_item(item, i++);
    if (node !== null) nodes.push(node);
  }
  return nodes;
}

type Line = Item[];

function split_into_lines(items: Item[]): Line[] {
  const lines: Line[] = [];
  let current: Item[] = [];
  for (const item of items) {
    if (item.type === "Newline") {
      lines.push(current);
      current = [];
    } else {
      current.push(item);
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines;
}

function first_meaningful_type(line: Line): Item["type"] | null {
  for (const item of line) {
    if (item.type !== "Indentation") return item.type;
  }
  return null;
}

function indent_level(line: Line): number {
  let level = 0;
  for (const item of line) {
    if (item.type === "Indentation") level += item.level;
    else break;
  }
  return level;
}

function strip_leading(line: Line, ...types: Array<Item["type"]>): Item[] {
  let i = 0;
  while (i < line.length && line[i].type === "Indentation") i++;
  if (i < line.length && types.includes(line[i].type)) i++;
  return line.slice(i);
}

type Block =
  | { kind: "paragraph"; lines: Line[] }
  | { kind: "bullet_list"; items: Line[] }
  | { kind: "numbered_list"; items: Array<{ number: string; line: Line }> }
  | { kind: "blockquote"; lines: Line[] }
  | { kind: "code_block"; language: string; code: string }
  | { kind: "separator" }
  | { kind: "empty" };

function group_into_blocks(lines: Line[]): Block[] {
  const blocks: Block[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const ft = first_meaningful_type(line);

    if (ft === null) {
      blocks.push({ kind: "empty" });
      i++;
      continue;
    }

    if (ft === "Separator") {
      blocks.push({ kind: "separator" });
      i++;
      continue;
    }

    if (ft === "CodeBlock") {
      const item = line.find((x) => x.type === "CodeBlock")!;
      blocks.push({ kind: "code_block", language: (item as any).language, code: (item as any).code });
      i++;
      continue;
    }

    if (ft === "BulletPoint") {
      const items: Line[] = [];
      while (i < lines.length && first_meaningful_type(lines[i]) === "BulletPoint") {
        items.push(strip_leading(lines[i], "BulletPoint"));
        i++;
      }
      blocks.push({ kind: "bullet_list", items });
      continue;
    }

    if (ft === "NumberedPoint") {
      const items: Array<{ number: string; line: Line }> = [];
      while (i < lines.length && first_meaningful_type(lines[i]) === "NumberedPoint") {
        const np = lines[i].find((x) => x.type === "NumberedPoint")!;
        items.push({ number: (np as any).number, line: strip_leading(lines[i], "NumberedPoint") });
        i++;
      }
      blocks.push({ kind: "numbered_list", items });
      continue;
    }

    if (ft === "QuoteIndent") {
      const quoteLines: Line[] = [];
      while (i < lines.length && first_meaningful_type(lines[i]) === "QuoteIndent") {
        quoteLines.push(strip_leading(lines[i], "QuoteIndent"));
        i++;
      }
      blocks.push({ kind: "blockquote", lines: quoteLines });
      continue;
    }

    // Regular paragraph line (possibly a heading)
    // Collect consecutive paragraph-ish lines
    const paragraphLines: Line[] = [];
    while (
      i < lines.length &&
      !["Separator", "CodeBlock", "BulletPoint", "NumberedPoint", "QuoteIndent"].includes(
        first_meaningful_type(lines[i]) ?? ""
      )
    ) {
      paragraphLines.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "paragraph", lines: paragraphLines });
  }

  return blocks;
}

function is_heading_line(line: Line): boolean {
  return line.some((item) => item.type === "Text" && (item as any).style.heading);
}

function render_block(block: Block, key: React.Key): React.ReactNode {
  return match(block)
    .with({ kind: "empty" }, () => <p key={key} />)
    .with({ kind: "separator" }, () => <hr key={key} />)
    .with({ kind: "code_block" }, (block) => (<pre key={key} data-language={block.language || undefined}>
        <code>{block.code}</code>
      </pre>
    ))
    .with({ kind: "bullet_list" }, (block) => (<ul key={key}>
      {block.items.map((line, i) => (
        <li key={i}>{render_inline_items(line)}</li>
      ))}
    </ul>))
    .with({ kind: "numbered_list" }, (block) => (<ol key={key}>
      {block.items.map(({ line }, i) => (
        <li key={i}>{render_inline_items(line)}</li>
      ))}
    </ol>))
    .with({ kind: "blockquote" }, (block) => (<blockquote key={key}>
      {block.lines.map((line, i) => (
        <p key={i}>{render_inline_items(line)}</p>
      ))}
    </blockquote>))
    .with({ kind: "paragraph" }, (block) => {
      const nodes: React.ReactNode[] = [];
      for (let i = 0; i < block.lines.length; i++) {
        const line = block.lines[i];
        if (line.length === 0) {
          nodes.push(<br key={`br-${i}`} />);
          continue;
        }
        if (is_heading_line(line)) {
          // Flush any preceding inline content as its own <p>, then emit <h>
          if (nodes.length > 0) {
            const flushed = nodes.splice(0);
            nodes.push(<p key={`p-${i}`}>{flushed}</p>);
          }
          //nodes.push(<h3 key={i}>{render_inline_items(line)}</h3>);
          const indent = indent_level(line);
          const content = indent > 0 ? strip_leading(line) : line;
          const font_sizes = ["1.5em", "1.25em", "1.1em"]; // Support up to 3 levels of heading
          const font_size = font_sizes[Math.min(indent, font_sizes.length - 1)];
          nodes.push(<><b key={i} style={{ fontSize: font_size }}>{render_inline_items(content)}</b><br/></>);
        } else {
          const indent = indent_level(line);
          const content = indent > 0 ? strip_leading(line) : line;
          if (indent > 0) {
            nodes.push(<span key={i} style={{ marginLeft: `${indent * 8}px`, display: "block" }}>{render_inline_items(content)}</span>);
          } else {
            // Separate lines within a paragraph with a line break
            if (nodes.length > 0) nodes.push(<br key={`br-${i}`} />);
            nodes.push(...render_inline_items(content));
          }
        }
      }
      return <p key={key}>{nodes}</p>;
    })
    .exhaustive();
}


export function EasyMarkInline({ text, style }: {
  text: string;
  style?: React.CSSProperties;
}) {
  const items = useMemo(() => parseEasyMark(text), [text]);

  // Collect only inline-render-able items; treat Newline as a space
  const nodes: React.ReactNode[] = [];
  let key = 0;
  for (const item of items) {
    if (item.type === "Newline") {
      nodes.push(" ");
    } else {
      const node = render_inline_item(item, key++);
      if (node !== null) nodes.push(node);
    }
  }

  return <span style={style}>{nodes}</span>;
}

export function EasyMark({ text, style }: {
  text: string;
  style?: React.CSSProperties;
}) {
  const items = useMemo(() => parseEasyMark(text), [text]);
  const lines = useMemo(() => split_into_lines(items), [items]);
  const blocks = useMemo(() => group_into_blocks(lines), [lines]);

  return (
    <div style={style}>
      {blocks.map((block, i) => render_block(block, i))}
    </div>
  );
}
