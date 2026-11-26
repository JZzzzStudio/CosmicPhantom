import assert from 'node:assert/strict';
import { uniqueBinaryNdcg } from '../eval/retrieval-metrics.js';

assert.equal(uniqueBinaryNdcg([['one'], ['one'], ['one']], 1, 5), 1);
assert.equal(uniqueBinaryNdcg([[], ['one']], 1, 5), 0.6309);
assert.equal(uniqueBinaryNdcg([['one', 'two']], 2, 5), 0.6131);
assert.equal(uniqueBinaryNdcg([['one'], [], ['two']], 2, 5), 0.9197);
assert.equal(uniqueBinaryNdcg([['one'], [], ['two']], 3, 5), 0.7039);
assert.equal(uniqueBinaryNdcg([['one']], 0, 5), null);
console.log('retrieval-metrics-test: all passed');
