'use strict';

// Run from server/: node --experimental-strip-types --test tests/event-canonical-referrer.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  canonicalize,
  decodeEventOrThrow,
} = require('../src/services/eventDecoder.ts');

const required = {
  prompt_id: '42',
  buyer: 'BUYER_SYNTHETIC',
  creator: 'CREATOR_SYNTHETIC',
  price_stroops: '10000000',
};
const expectedKeys = [
  'prompt_id', 'buyer', 'creator', 'price_stroops',
  'a_metadata', 'referrer', 'z_receipt',
];

for (const schemaVersion of [1, 2]) {
  test(`v${schemaVersion}: absent, null and undefined referrers canonicalize identically`, () => {
    const variants = [
      { ...required, z_receipt: 'receipt', a_metadata: 'metadata' },
      { referrer: null, a_metadata: 'metadata', ...required, z_receipt: 'receipt' },
      { z_receipt: 'receipt', ...required, a_metadata: 'metadata', referrer: undefined },
    ];
    const events = variants.map((value) => decodeEventOrThrow(Object.freeze({
      schemaVersion,
      lifecycle: 'purchase',
      value: Object.freeze(value),
    })));

    assert.deepEqual(events[0], events[1]);
    assert.deepEqual(events[1], events[2]);
    const explicitNull = canonicalize(events[1]);
    for (const event of events) {
      assert.equal(canonicalize(event), explicitNull);
      assert.deepEqual(Object.keys(event.fields), expectedKeys);
      assert.equal(event.fields.referrer, null);
    }
    assert.equal(Object.hasOwn(variants[0], 'referrer'), false);
    assert.equal(variants[1].referrer, null);
    assert.equal(variants[2].referrer, undefined);
  });

  test(`v${schemaVersion}: non-null referrer and topic precedence are preserved`, () => {
    const event = decodeEventOrThrow(Object.freeze({
      schemaVersion,
      lifecycle: 'purchase',
      value: Object.freeze({
        ...required, a_metadata: 'metadata', referrer: null, z_receipt: 'receipt',
      }),
      topics: Object.freeze({ referrer: 'REFERRER_Case_Preserved' }),
    }));

    assert.equal(event.fields.referrer, 'REFERRER_Case_Preserved');
    assert.deepEqual(Object.keys(event.fields), expectedKeys);
    for (const [key, value] of Object.entries(required)) {
      assert.equal(event.fields[key], value);
    }
  });
}
