import { ACTIONS } from '@spacemolt/lib';
export const allowed = new Set([
  'spacemolt/get_status', 'spacemolt/get_active_missions', 'spacemolt/get_missions',
  'spacemolt/get_system', 'spacemolt/get_poi', 'spacemolt/get_base', 'spacemolt/find_route',
  'spacemolt/get_skills', 'spacemolt/get_guide', 'spacemolt/completed_missions',
  'spacemolt/survey_system', 'spacemolt/get_tax_estimate',
  'spacemolt/install_mod', 'spacemolt/uninstall_mod', 'spacemolt/get_nearby', 'spacemolt/inspect',
  'spacemolt_ship/browse_ships', 'spacemolt_ship/buy_listed_ship',
  'spacemolt_shipping/list', 'spacemolt_shipping/profile', 'spacemolt_shipping/get',
  'spacemolt_shipping/active', 'spacemolt_shipping/accept', 'spacemolt_shipping/deliver',
  'spacemolt/undock', 'spacemolt/dock', 'spacemolt/travel', 'spacemolt/jump',
  'spacemolt/mine', 'spacemolt/buy', 'spacemolt/sell', 'spacemolt/refuel', 'spacemolt/repair',
  'spacemolt/accept_mission', 'spacemolt/complete_mission',
  'spacemolt_market/view_market', 'spacemolt_market/estimate_purchase',
  'spacemolt_storage/view', 'spacemolt_storage/deposit', 'spacemolt_storage/withdraw',
]);
export function validateAction(action: string, params: Record<string, unknown> = {}) {
  if (!allowed.has(action) || !(action in ACTIONS)) throw new Error('Action is outside the enabled gameplay toolset');
  if (action.startsWith('spacemolt_storage/') && ['target','source','credits','message'].some(key => params[key] !== undefined)) throw new Error('Only personal item storage is enabled');
  if (['spacemolt/refuel','spacemolt/repair'].includes(action) && params.target !== undefined) throw new Error('Only servicing your own ship is enabled');
  if (action.startsWith('spacemolt_shipping/') && params.carrier !== undefined && params.carrier !== 'player') throw new Error('Only personal freight contracts are enabled');
}
export function catalog() {
  return Object.fromEntries(Object.entries(ACTIONS).filter(([key]) => allowed.has(key)).map(([key,value]) => {
    const forbidden = key.startsWith('spacemolt_storage/') ? ['target','source','credits','message'] : ['spacemolt/refuel','spacemolt/repair'].includes(key) ? ['target'] : [];
    return [key, {...value, summary:key.startsWith('spacemolt_storage/') ? 'Manage your personal items at station storage' : value.summary, params:value.params.filter(p => !forbidden.includes(p.name))}];
  }));
}
