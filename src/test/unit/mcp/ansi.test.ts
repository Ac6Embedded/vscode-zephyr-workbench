import { strict as assert } from 'assert';
import { cleanForLog, collapseCarriageReturns, normalizeNewlines, stripAnsi, toTerminalText } from '../../../mcp/core/ansi';

describe('mcp/core/ansi', () => {
  it('strips the colour codes Zephyr builds emit', () => {
    // Zephyr passes -fdiagnostics-color=always, so real logs look like this.
    const coloured = '\u001b[01m\u001b[Kmain.c:12:5:\u001b[m\u001b[K \u001b[01;31m\u001b[Kerror:\u001b[m\u001b[K boom';
    assert.equal(stripAnsi(coloured), 'main.c:12:5: error: boom');
  });

  it('strips OSC sequences such as a terminal title', () => {
    assert.equal(stripAnsi('\u001b]0;building\u0007done'), 'done');
  });

  it('leaves plain text untouched', () => {
    assert.equal(stripAnsi('[12/430] Building C object'), '[12/430] Building C object');
  });

  it('collapses a carriage-return progress repaint to its final state', () => {
    assert.equal(collapseCarriageReturns('10%\r50%\r100%'), '100%');
  });

  it('keeps each line independent when collapsing', () => {
    assert.equal(collapseCarriageReturns('a\r\nb'), 'a\nb');
    assert.equal(collapseCarriageReturns('1%\rdone\nnext'), 'done\nnext');
  });

  it('ignores a trailing carriage return with nothing after it', () => {
    assert.equal(collapseCarriageReturns('final\r'), 'final');
  });

  it('normalizes CRLF', () => {
    assert.equal(normalizeNewlines('a\r\nb\r\n'), 'a\nb\n');
  });

  it('runs the whole log pipeline in the right order', () => {
    const raw = '\u001b[32m[1/2]\u001b[0m compiling\r\n\u001b[32m[2/2]\u001b[0m linking\r\n';
    assert.equal(cleanForLog(raw), '[1/2] compiling\n[2/2] linking\n');
  });

  it('converts to CRLF for a pseudoterminal, which needs explicit carriage returns', () => {
    assert.equal(toTerminalText('a\nb'), 'a\r\nb');
    assert.equal(toTerminalText('a\r\nb'), 'a\r\nb');
  });
});
