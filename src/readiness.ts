import type { GameState } from '@spacemolt/lib';
import {requireCommandSpend} from './spending.ts';

export interface ReadinessOptions {
  requireMining?: boolean;
  minFreeCargo?: number;
  minFuel?: number;
  minHull?: number;
  creditReserve?: number;
  maxServiceSpend?: number;
  /** Current station's quoted total price, including tax, for full service. */
  serviceQuotes?: { refuel?: number; repair?: number };
}
export interface ReadinessAction { action: string; params: Record<string, unknown>; reason: string }
export interface ReadinessPlan { ready: boolean; blockers: string[]; actions: ReadinessAction[] }
export interface ReadinessAccount { state: GameState; refresh(): Promise<unknown> }
export type ReadinessCommand = (action: string, params: Record<string, unknown>) => Promise<unknown>;

function validate(options: ReadinessOptions) {
  for (const [key, value] of Object.entries({...options, ...options.serviceQuotes})) {
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) throw new Error(`Invalid readiness ${key}`);
  }
}

export function inspectReadiness(state: GameState, options: ReadinessOptions = {}): ReadinessPlan {
  validate(options);
  const blockers: string[] = [];
  const actions: ReadinessAction[] = [];
  const {ship, location, cargo, modules, player} = state;
  if (!ship || !location || !cargo || !modules || !player) return {ready:false, blockers:['Canonical ship, location, cargo, modules and player state required'], actions};
  if (ship.incapacitated) blockers.push('Ship crew incapacitated');
  let projectedFree = ship.cargo_capacity - ship.cargo_used;
  const mining = modules.some(m => Number(m.stats?.mining_power ?? 0) > 0);
  if (options.requireMining && !mining) {
    if (!location.docked_at) blockers.push('Dock at a refit station before installing mining equipment');
    else {
      const laser = cargo.find(item => item.item_id === 'mining_laser_i' && item.quantity > 0);
      if (!laser) blockers.push('Mining Laser I must already be in cargo; retrieve or explicitly acquire equipment');
      else {
        const utilityCount = modules.filter(m => m.slot === 'utility').length;
        // Only remove the known scanner: other utilities may have load-bearing effects.
        const scanner = modules.find(m => m.type_id === 'survey_scanner_i');
        if (utilityCount >= ship.utility_slots && !scanner) blockers.push('No utility slot: explicitly choose an equipment change');
        else if (utilityCount >= ship.utility_slots && (scanner?.size === undefined || projectedFree < scanner.size)) blockers.push('Make cargo room to preserve the removed scanner before refitting');
        else {
          if (utilityCount >= ship.utility_slots && scanner) {
            actions.push({action:'spacemolt/uninstall_mod', params:{id:scanner.module_id}, reason:'Preserve survey scanner in cargo and free a utility slot'});
            projectedFree -= scanner.size!;
          }
          actions.push({action:'spacemolt/install_mod', params:{id:'mining_laser_i'}, reason:'Install owned mining equipment'});
          projectedFree += laser.size ?? 0;
        }
      }
    }
  }
  if (projectedFree < (options.minFreeCargo ?? 0)) blockers.push(`Need ${options.minFreeCargo} free cargo; projected ${projectedFree}`);
  let quotedSpend = 0;
  const services = [
    {name:'refuel' as const, current:ship.fuel, target:options.minFuel ?? 0, max:ship.max_fuel},
    {name:'repair' as const, current:ship.hull, target:options.minHull ?? ship.max_hull, max:ship.max_hull},
  ];
  for (const service of services) {
    if (service.target > service.max) { blockers.push(`${service.name} target exceeds ship capacity`); continue; }
    if (service.current >= service.target) continue;
    const quote = options.serviceQuotes?.[service.name];
    if (!location.docked_at) blockers.push(`Dock for ${service.name} service`);
    else if (quote === undefined) blockers.push(`Current full ${service.name} quote required before spending`);
    else {
      quotedSpend += quote;
      actions.push({action:`spacemolt/${service.name}`, params:{}, reason:`Full station service quoted at ${quote} credits`});
    }
  }
  if (quotedSpend > (options.maxServiceSpend ?? 0)) blockers.push('Quoted services exceed the service budget');
  if (player.credits - quotedSpend < (options.creditReserve ?? 0)) blockers.push('Services would breach the credit reserve');
  return {ready:blockers.length === 0 && actions.length === 0, blockers, actions};
}

/** The callback must use the caller's existing serialized, audited connection.
 * Station services have no atomic server-side price cap. Quotes are preflight
 * estimates; canonical post-action spend is checked and any discrepancy stops.
 */
export async function ensureReadiness(account: ReadinessAccount, command: ReadinessCommand, options: ReadinessOptions = {}, execute = false) {
  await account.refresh();
  const plan = inspectReadiness(account.state, options);
  const completed: ReadinessAction[] = [];
  if (!execute || plan.blockers.length || plan.ready) return {plan, completed, verification:plan};
  let spent=0;
  for (const step of plan.actions) {
    if (!account.state.location?.docked_at) throw new Error('Readiness stopped: ship is no longer docked');
    const service = step.action === 'spacemolt/refuel' ? 'refuel' : step.action === 'spacemolt/repair' ? 'repair' : null;
    const quote = service ? options.serviceQuotes?.[service] ?? 0 : 0;
    const availableCredits = account.state.player?.credits;
    if (availableCredits === undefined || availableCredits - quote < (options.creditReserve ?? 0)
      || spent + quote > (options.maxServiceSpend ?? 0)) {
      throw new Error('Readiness stopped: remaining service would breach budget or reserve');
    }
    const removed = step.action === 'spacemolt/uninstall_mod'
      ? account.state.modules?.find(m => m.module_id === step.params.id) : undefined;
    const previousCargo = removed ? account.state.cargo?.find(i => i.item_id === removed.type_id)?.quantity ?? 0 : 0;
    const reply=await command(step.action, step.params);
    const cost=requireCommandSpend(step.action,reply);
    spent+=cost;
    completed.push(step);
    await account.refresh();
    if (removed && (account.state.modules?.some(m => m.module_id === removed.module_id)
      || (account.state.cargo?.find(i => i.item_id === removed.type_id)?.quantity ?? 0) <= previousCargo)) {
      throw new Error('Readiness stopped: removed equipment was not verified preserved in cargo');
    }
    if (step.action === 'spacemolt/install_mod' && !account.state.modules?.some(m => m.type_id === 'mining_laser_i' && Number(m.stats?.mining_power ?? 0) > 0)) {
      throw new Error('Readiness stopped: mining module installation not verified');
    }
    const credits = account.state.player?.credits;
    if (credits === undefined || credits < (options.creditReserve ?? 0) || spent > (options.maxServiceSpend ?? 0) || cost>quote) {
      throw new Error('Readiness stopped: canonical spending breached budget or reserve');
    }
  }
  return {plan, completed, actual_spend:spent, verification:inspectReadiness(account.state, options)};
}
