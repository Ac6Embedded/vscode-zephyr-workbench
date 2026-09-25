import { strict as assert } from 'assert';
import { compileMatcher, MAX_PATTERN_LENGTH, PatternError } from '../../../mcp/core/match';

describe('mcp/core/match', () => {
  it('matches case-insensitive text anywhere', () => {
    const m = compileMatcher('gpio');
    assert.equal(m('CONFIG_GPIO'), true);
    assert.equal(m('CONFIG_GPIO_STM32'), true);
    assert.equal(m('CONFIG_SPI'), false);
  });

  it('treats * as any run of characters', () => {
    const m = compileMatcher('CONFIG_*_STM32');
    assert.equal(m('CONFIG_GPIO_STM32'), true);
    assert.equal(m('CONFIG_UART_STM32_ASYNC'), true, 'the match is anywhere, not anchored');
    assert.equal(m('CONFIG_GPIO'), false);
  });

  it('treats regular expression syntax as plain text', () => {
    assert.equal(compileMatcher('uart@4001')('/soc/uart@40011000'), true);
    assert.equal(compileMatcher('(a+)+')('xx(a+)+yy'), true);
    assert.equal(compileMatcher('(a+)+')('aaaa'), false);
  });

  it('stays fast on the inputs that freeze a backtracking regex', () => {
    // (\w+)+! against a long word takes minutes with RegExp. Here it must be instant.
    const subject = `CONFIG_${'A'.repeat(5000)}`;
    const started = Date.now();
    for (const pattern of ['(\\w+)+!', '*a*a*a*a*a*a*a*a*a*a*a*a*a*a*!', 'a*'.repeat(90)]) {
      compileMatcher(pattern)(subject);
    }
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  });

  it('rejects an empty or over-long pattern', () => {
    assert.throws(() => compileMatcher('   '), PatternError);
    assert.throws(() => compileMatcher('x'.repeat(MAX_PATTERN_LENGTH + 1)), PatternError);
  });
});
