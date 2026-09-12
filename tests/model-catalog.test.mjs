import test from 'node:test';
import assert from 'node:assert/strict';

import { availableFor, findModel, loadModelCatalog } from '../ai/model-catalog.js';

function client(rows) {
  let orders = 0;
  const query = {
    select() { return query; },
    eq() { return query; },
    order() {
      orders += 1;
      return orders === 2 ? Promise.resolve({ data: rows, error: null }) : query;
    },
  };
  return { from() { return query; } };
}

test('remote model catalogue sorts safely and keeps free and Pro access separate', async () => {
  const models = await loadModelCatalog(client([
    { id: 'b', provider: 'deepseek', display_name: 'Pro', model_name: 'deepseek-v4-pro', free_enabled: false, pro_enabled: true, enabled: true, sort_order: 20 },
    { id: 'a', provider: 'deepseek', display_name: 'Flash', model_name: 'deepseek-v4-flash', free_enabled: true, pro_enabled: true, enabled: true, sort_order: 10 },
    { id: 'c', provider: 'sunland', display_name: 'Hidden', model_name: 'frost', free_enabled: true, pro_enabled: true, enabled: false, sort_order: 0 },
  ]));

  assert.deepEqual(models.map(model => model.displayName), ['Flash', 'Pro']);
  assert.equal(availableFor(models[0], false), true);
  assert.equal(availableFor(models[1], false), false);
  assert.equal(availableFor(models[1], true), true);
  assert.equal(findModel(models, 'deepseek', 'deepseek-v4-pro')?.displayName, 'Pro');
});

test('remote model catalogue rejects malformed public data', async () => {
  await assert.rejects(
    loadModelCatalog(client([
      { id: 'bad', provider: 'unknown', display_name: 'Bad', model_name: 'bad', free_enabled: true, pro_enabled: true, enabled: true, sort_order: 0 },
    ])),
    /Unsupported model provider/,
  );
});
