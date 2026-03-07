/*
A parser for a lightweight subset of Markdown, inspired by the EasyMark
parser from the egui project: <https://github.com/emilk/egui/blob/fd257b2e95972f2bfe08cbde710f248076a08ee6/crates/egui_demo_lib/src/easy_mark/easy_mark_editor.rs>

Several modifications have been applied to align the syntax more closely
with standard Markdown conventions (e.g. `**bold**`, `_italic_`, `__underline__`).

This custom parser is used instead of markdown-it to avoid pulling in a large
dependency tree and the need for HTML sanitization that comes with any library
that renders to raw HTML strings.
*/

export interface Style {
  /** # heading (large text) */
  heading: boolean;
  /** > quoted (slightly dimmer color or other font style) */
  quoted: boolean;
  /** `code` (monospace, some other color) */
  code: boolean;
  /** **strong** (emphasized, e.g. bold) */
  strong: boolean;
  /** __underline__ */
  underline: boolean;
  /** ~strikethrough~ */
  strikethrough: boolean;
  /** _italics_ */
  italics: boolean;
  /** $small$ */
  small: boolean;
  /** ^raised^ */
  raised: boolean;
}

export function defaultStyle(): Style {
  return {
    heading: false,
    quoted: false,
    code: false,
    strong: false,
    underline: false,
    strikethrough: false,
    italics: false,
    small: false,
    raised: false,
  };
}

export type Item =
  /** `\n` */
  | { type: 'Newline' }
  /** Text with style */
  | { type: 'Text'; style: Style; text: string }
  /** title, url */
  | { type: 'Hyperlink'; style: Style; text: string; url: string }
  /** Leading space before e.g. a BulletPoint */
  | { type: 'Indentation'; level: number }
  /** > */
  | { type: 'QuoteIndent' }
  /** - a point well made. */
  | { type: 'BulletPoint' }
  /** 1. numbered list. The string is the number(s). */
  | { type: 'NumberedPoint'; number: string }
  /** --- */
  | { type: 'Separator' }
  /** language, code */
  | { type: 'CodeBlock'; language: string; code: string };

const SPECIAL_CHARS = ['*', '`', '~', '_', '$', '^', '\\', '<', '[', '\n'];

/** Parser for the EasyMark markup language. */
export class Parser implements Iterable<Item> {
  /** Remaining input text */
  private s: string;
  /** Are we at the start of a line? */
  private startOfLine: boolean;
  /** Current style — reset after a newline */
  private style: Style;

  constructor(s: string) {
    this.s = s;
    this.startOfLine = true;
    this.style = defaultStyle();
  }

  /** `1. `, `42. ` etc. */
  private numberedList(): Item | null {
    let nDigits = 0;
    while (nDigits < this.s.length && this.s[nDigits] >= '0' && this.s[nDigits] <= '9') {
      nDigits++;
    }
    if (nDigits > 0 && this.s.slice(nDigits, nDigits + 2) === '. ') {
      const number = this.s.slice(0, nDigits);
      this.s = this.s.slice(nDigits + 2);
      this.startOfLine = false;
      return { type: 'NumberedPoint', number };
    }
    return null;
  }

  /** ` ```{language}\n{code}``` ` */
  private codeBlock(): Item | null {
    if (!this.s.startsWith('```')) {
      return null;
    }
    const languageStart = this.s.slice(3);
    const newline = languageStart.indexOf('\n');
    if (newline === -1) {
      return null;
    }
    const language = languageStart.slice(0, newline).trim();
    const codeStart = languageStart.slice(newline + 1);
    const end = codeStart.indexOf('\n```');
    if (end !== -1) {
      const code = codeStart.slice(0, end).trim();
      this.s = codeStart.slice(end + 4);
      this.startOfLine = false;
      return { type: 'CodeBlock', language, code };
    } else {
      this.s = '';
      return { type: 'CodeBlock', language, code: codeStart };
    }
  }

  /** `` `code` `` */
  private inlineCode(): Item | null {
    if (!this.s.startsWith('`')) {
      return null;
    }
    this.s = this.s.slice(1);
    this.startOfLine = false;
    this.style.code = true;
    const newlineIdx = this.s.indexOf('\n');
    const restOfLine = newlineIdx === -1 ? this.s : this.s.slice(0, newlineIdx);
    const end = restOfLine.indexOf('`');
    if (end !== -1) {
      const item: Item = { type: 'Text', style: { ...this.style }, text: this.s.slice(0, end) };
      this.s = this.s.slice(end + 1);
      this.style.code = false;
      return item;
    } else {
      const item: Item = { type: 'Text', style: { ...this.style }, text: restOfLine };
      this.s = this.s.slice(restOfLine.length);
      this.style.code = false;
      return item;
    }
  }

  /** `<url>` or `[text](url)` */
  private url(): Item | null {
    if (this.s.startsWith('<')) {
      const newlineIdx = this.s.indexOf('\n');
      const thisLine = newlineIdx === -1 ? this.s : this.s.slice(0, newlineIdx);
      const urlEnd = thisLine.indexOf('>');
      if (urlEnd !== -1) {
        const url = this.s.slice(1, urlEnd);
        this.s = this.s.slice(urlEnd + 1);
        this.startOfLine = false;
        return { type: 'Hyperlink', style: { ...this.style }, text: url, url };
      }
    }

    if (this.s.startsWith('[')) {
      const newlineIdx = this.s.indexOf('\n');
      const thisLine = newlineIdx === -1 ? this.s : this.s.slice(0, newlineIdx);
      const bracketEnd = thisLine.indexOf(']');
      if (bracketEnd !== -1) {
        const text = thisLine.slice(1, bracketEnd);
        if (thisLine[bracketEnd + 1] === '(') {
          const parensEnd = thisLine.slice(bracketEnd + 2).indexOf(')');
          if (parensEnd !== -1) {
            const absParensEnd = bracketEnd + 2 + parensEnd;
            const url = this.s.slice(bracketEnd + 2, absParensEnd);
            this.s = this.s.slice(absParensEnd + 1);
            this.startOfLine = false;
            return { type: 'Hyperlink', style: { ...this.style }, text, url };
          }
        }
      }
    }

    return null;
  }

  *[Symbol.iterator](): Iterator<Item> {
    while (true) {
      if (this.s.length === 0) {
        return;
      }

      // \n
      if (this.s.startsWith('\n')) {
        this.s = this.s.slice(1);
        this.startOfLine = true;
        this.style = defaultStyle();
        yield { type: 'Newline' };
        continue;
      }

      // Ignore line break — `\` followed by newline continues on the same line
      if (this.s.startsWith('\\\n') && this.s.length >= 2) {
        this.s = this.s.slice(2);
        this.startOfLine = false;
        continue;
      }

      // `\x` escape — emit x literally
      if (this.s.startsWith('\\') && this.s.length >= 2) {
        const text = this.s[1];
        this.s = this.s.slice(2);
        this.startOfLine = false;
        yield { type: 'Text', style: { ...this.style }, text };
        continue;
      }

      if (this.startOfLine) {
        // Leading spaces (indentation)
        if (this.s.startsWith(' ')) {
          let length = 0;
          while (length < this.s.length && this.s[length] === ' ') {
            length++;
          }
          this.s = this.s.slice(length);
          // indentation doesn't count as leaving the start-of-line state
          this.startOfLine = true;
          yield { type: 'Indentation', level: length };
          continue;
        }

        // # Heading
        if (this.s.startsWith('# ')) {
          this.s = this.s.slice(2);
          this.startOfLine = false;
          this.style.heading = true;
          continue;
        }

        // > Quote
        if (this.s.startsWith('> ')) {
          this.s = this.s.slice(2);
          this.startOfLine = true; // quote indentation doesn't count
          this.style.quoted = true;
          yield { type: 'QuoteIndent' };
          continue;
        }

        // - Bullet point
        if (this.s.startsWith('- ')) {
          this.s = this.s.slice(2);
          this.startOfLine = false;
          yield { type: 'BulletPoint' };
          continue;
        }

        // `1. `, `42. ` etc.
        const numbered = this.numberedList();
        if (numbered !== null) {
          yield numbered;
          continue;
        }

        // --- Separator
        if (this.s.startsWith('---')) {
          this.s = this.s.slice(3);
          // remove extra dashes
          while (this.s.startsWith('-')) {
            this.s = this.s.slice(1);
          }
          // remove trailing newline
          if (this.s.startsWith('\n')) {
            this.s = this.s.slice(1);
          }
          this.startOfLine = false;
          yield { type: 'Separator' };
          continue;
        }

        // ```{language}\n{code}```
        const block = this.codeBlock();
        if (block !== null) {
          yield block;
          continue;
        }
      }

      // `code`
      const inlineCode = this.inlineCode();
      if (inlineCode !== null) {
        yield inlineCode;
        continue;
      }

      // **strong** — must be checked before single *
      if (this.s.startsWith('**')) {
        this.s = this.s.slice(2);
        this.startOfLine = false;
        this.style.strong = !this.style.strong;
        continue;
      }
      // __underline__ — must be checked before single _
      if (this.s.startsWith('__')) {
        this.s = this.s.slice(2);
        this.startOfLine = false;
        this.style.underline = !this.style.underline;
        continue;
      }
      // _italics_
      if (this.s.startsWith('_')) {
        this.s = this.s.slice(1);
        this.startOfLine = false;
        this.style.italics = !this.style.italics;
        continue;
      }
      // ~strikethrough~
      if (this.s.startsWith('~')) {
        this.s = this.s.slice(1);
        this.startOfLine = false;
        this.style.strikethrough = !this.style.strikethrough;
        continue;
      }
      // $small$
      if (this.s.startsWith('$')) {
        this.s = this.s.slice(1);
        this.startOfLine = false;
        this.style.small = !this.style.small;
        continue;
      }
      // ^raised^
      if (this.s.startsWith('^')) {
        this.s = this.s.slice(1);
        this.startOfLine = false;
        this.style.raised = !this.style.raised;
        continue;
      }

      // `<url>` or `[link](url)`
      const urlItem = this.url();
      if (urlItem !== null) {
        yield urlItem;
        continue;
      }

      // Swallow everything up to the next special character
      let end = this.s.length;
      for (const c of SPECIAL_CHARS) {
        const idx = this.s.indexOf(c);
        if (idx !== -1 && idx < end) {
          end = idx;
        }
      }
      // Always consume at least one character to avoid infinite loops
      if (end === 0) {
        end = 1;
      }

      yield { type: 'Text', style: { ...this.style }, text: this.s.slice(0, end) };
      this.s = this.s.slice(end);
      this.startOfLine = false;
    }
  }

  /** Collect all items into an array. */
  parse(): Item[] {
    return [...this];
  }
}

/** Parse an EasyMark string and return all items. */
export function parseEasyMark(s: string): Item[] {
  return new Parser(s).parse();
}
