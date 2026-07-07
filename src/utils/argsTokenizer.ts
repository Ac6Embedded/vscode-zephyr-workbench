/**
 * Shell-style tokenizer shared by the west runners and the debug backends:
 * splits on whitespace but treats a `"…"` span as one token (quotes are kept
 * on the token; `unquoteToken` strips them when needed). Sufficient for the
 * argument strings VS Code stores in launch.json.
 */
export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) {i++;}
    if (i >= input.length) {break;}

    let token = '';
    if (input[i] === '"') {
      token += input[i++];
      while (i < input.length && input[i] !== '"') {token += input[i++];}
      if (i < input.length) {token += input[i++];} // consume closing quote
    } else {
      while (i < input.length && !/\s/.test(input[i])) {token += input[i++];}
    }
    tokens.push(token);
  }
  return tokens;
}

/** Strip a single pair of surrounding double quotes, if any. */
export function unquoteToken(value: string): string {
  return value.replace(/^"(.*)"$/, '$1');
}
