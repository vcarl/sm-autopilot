// Tactical commands are internal to the bounded wildlife controller, not model tools.
export const combatActions = new Set([
  'spacemolt/hunt', 'spacemolt/scan', 'spacemolt_battle/status',
  'spacemolt_battle/stance', 'spacemolt_battle/advance', 'spacemolt_battle/retreat',
  'spacemolt_battle/target', 'spacemolt_battle/summary', 'spacemolt_battle/log',
  'spacemolt_battle/reload',
  'spacemolt_salvage/wrecks', 'spacemolt_salvage/loot',
]);
export const allowed = new Set([
  'spacemolt_intel/query_trade_intel',
  ...combatActions,
  'spacemolt/list_station_passengers', 'spacemolt/load_passenger', 'spacemolt/unload_passenger',
  'spacemolt/list_passengers', 'spacemolt/get_status', 'spacemolt/get_active_missions', 'spacemolt/get_missions',
  'spacemolt/get_system', 'spacemolt/get_poi', 'spacemolt/get_base', 'spacemolt/find_route',
  'spacemolt/get_skills', 'spacemolt/get_guide', 'spacemolt/completed_missions',
  'spacemolt/get_ship', 'spacemolt_market/analyze_market',
  'spacemolt/survey_system', 'spacemolt/get_tax_estimate',
  'spacemolt/install_mod', 'spacemolt/uninstall_mod', 'spacemolt/get_nearby', 'spacemolt/inspect',
  'spacemolt_ship/browse_ships', 'spacemolt_ship/buy_listed_ship',
  'spacemolt_shipping/list', 'spacemolt_shipping/profile', 'spacemolt_shipping/get',
  'spacemolt_shipping/active', 'spacemolt_shipping/accept', 'spacemolt_shipping/deliver', 'spacemolt_shipping/return',
  'spacemolt/undock', 'spacemolt/dock', 'spacemolt/travel', 'spacemolt/jump',
  'spacemolt/mine', 'spacemolt/buy', 'spacemolt/sell', 'spacemolt/refuel', 'spacemolt/repair',
  'spacemolt/craft', 'spacemolt_facility/list', 'spacemolt_facility/owned',
  'spacemolt/accept_mission', 'spacemolt/complete_mission', 'spacemolt/abandon_mission',
  'spacemolt_market/view_market', 'spacemolt_market/estimate_purchase',
  'spacemolt_storage/view', 'spacemolt_storage/deposit', 'spacemolt_storage/withdraw',
]);
