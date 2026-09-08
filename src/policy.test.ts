import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalog, validateAction } from './policy.ts';
import { sendAndRefresh } from './execute.ts';

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

test('mutation receipts are reconciled with canonical state and never resent on refresh failure', async () => {
  let cachedProgress = 0;
  let authoritativeProgress = 0;
  let sends = 0;
  let executed = false;
  const account = {
    async send() { sends++; authoritativeProgress++; return {delta:{location:{docked_at:'station'}}}; },
    async refresh() { cachedProgress = authoritativeProgress; },
  };
  await sendAndRefresh(account, 'spacemolt/dock', {}, () => { executed = true; });
  assert.equal(cachedProgress, authoritativeProgress);
  assert.ok(executed);
  account.refresh = async () => { throw new Error('connection lost after execution'); };
  executed = false;
  await assert.rejects(sendAndRefresh(account, 'spacemolt/undock', {}, () => { executed = true; }));
  assert.ok(executed);
  assert.equal(sends, 2);
});
