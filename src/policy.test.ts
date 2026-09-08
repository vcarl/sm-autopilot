import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalog, validateAction } from './policy.ts';

test('personal storage and consumables work, transfers and messaging are excluded', () => {
  validateAction('spacemolt_storage/deposit', {item_id:'iron_ore',quantity:2});
  validateAction('spacemolt/refuel', {id:'fuel_cell',quantity:1});
  assert.throws(() => validateAction('spacemolt_storage/deposit', {target:'someone',credits:100}));
  assert.throws(() => validateAction('spacemolt/refuel', {target:'someone'}));
  assert.throws(() => validateAction('spacemolt_social/chat', {content:'hello'}));
  for (const [action, metadata] of Object.entries(catalog())) {
    validateAction(action);
    if (action.startsWith('spacemolt_storage/')) assert.ok(metadata.params.every(p => !['target','source','credits','message'].includes(p.name)));
  }
});
