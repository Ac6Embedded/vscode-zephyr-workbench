import { strict as assert } from 'assert';

import { formatYml } from '../../utilities/formatYml';

describe('formatYml', () => {
  it('does nothing for non-objects', () => {
    assert.doesNotThrow(() => formatYml(undefined));
    assert.doesNotThrow(() => formatYml(null));
    assert.doesNotThrow(() => formatYml(123 as any));
    assert.doesNotThrow(() => formatYml('abc' as any));
  });

  it('forces MAP/SEQ nodes to block style recursively', () => {
    const node: any = {
      type: 'MAP',
      flow: true,
      items: [
        {
          key: { type: 'MAP', flow: true, items: [] },
          value: {
            type: 'SEQ',
            flow: true,
            items: [
              { value: { type: 'MAP', flow: true, items: [] } },
            ],
          },
        },
      ],
    };

    formatYml(node);

    assert.equal(node.flow, false);
    assert.equal(node.items[0].key.flow, false);
    assert.equal(node.items[0].value.flow, false);
    assert.equal(node.items[0].value.items[0].value.flow, false);
  });

  it('handles a DOCUMENT wrapper node', () => {
    const doc: any = {
      type: 'DOCUMENT',
      contents: {
        type: 'MAP',
        flow: true,
        items: [],
      },
    };

    formatYml(doc);
    assert.equal(doc.contents.flow, false);
  });
});
