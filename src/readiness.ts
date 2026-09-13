import {evaluateRules,requireAllowed,type Decision,type RuleFacts} from './rules.ts';
import type { GameState } from '@spacemolt/lib';
import {requireCommandSpend} from './spending.ts';

export interface ReadinessOptions {
  decided?:(decision:Decision,phase?:RuleFacts['phase'])=>void;
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
export interface ReadinessPlan { decision:Decision; ready: boolean; blockers: string[]; actions: ReadinessAction[] }
export interface ReadinessAccount { state: GameState; refresh(): Promise<unknown> }
export type ReadinessCommand = (action: string, params: Record<string, unknown>) => Promise<unknown>;
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const identity=(value:unknown)=>typeof value==='string'&&value.length>0;

export function canonicalReadinessBlockers(state:GameState):string[] {
  const {ship,location,cargo,modules,player}=state??{};
  if(!ship||!location||!Array.isArray(cargo)||!Array.isArray(modules)||!player)return ['Canonical ship, location, cargo, modules and player state required'];
  const blockers:string[]=[];
  if(!identity(ship.id)||!finite(player.credits))blockers.push('Canonical ship identity and wallet required');
  if(!modules.every(row=>identity(row?.module_id)&&identity(row?.type_id)&&identity(row?.slot)&&(row.size===undefined||finite(row.size)))||new Set(modules.map(row=>row?.module_id)).size!==modules.length||
    !cargo.every(row=>identity(row?.item_id)&&Number.isInteger(row?.quantity)&&row.quantity>=0&&(row.size===undefined||finite(row.size))))blockers.push('Canonical module and cargo custody required');
  const resources=[
    [ship.cpu_used,ship.cpu_capacity],[ship.power_used,ship.power_capacity],[ship.cargo_used,ship.cargo_capacity],
    [ship.fuel,ship.max_fuel],[ship.hull,ship.max_hull],[ship.shield,ship.max_shield],
  ];
  if(resources.some(([used,max])=>!finite(used)||!finite(max)||used>max)||!finite(ship.utility_slots)||!Number.isInteger(ship.utility_slots)||
    modules.filter(row=>row?.slot==='utility').length>ship.utility_slots)blockers.push('Canonical ship capacities unavailable or exceeded');
  if(ship.incapacitated!==undefined&&typeof ship.incapacitated!=='boolean')blockers.push('Canonical crew condition required');
  else if(ship.incapacitated)blockers.push('Ship crew incapacitated');
  return blockers;
}

function validate(options: ReadinessOptions) {
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('Invalid readiness options');
  if(options.requireMining!==undefined&&typeof options.requireMining!=='boolean')throw new Error('Invalid readiness requireMining');
  for(const key of ['minFreeCargo','minFuel','minHull','creditReserve','maxServiceSpend'] as const)
    if(options[key]!==undefined&&!finite(options[key]))throw new Error(`Invalid readiness ${key}`);
  if(options.serviceQuotes!==undefined) {
    if(!options.serviceQuotes||typeof options.serviceQuotes!=='object'||Array.isArray(options.serviceQuotes))throw new Error('Invalid readiness serviceQuotes');
    for(const key of ['refuel','repair'] as const)if(options.serviceQuotes[key]!==undefined&&!finite(options.serviceQuotes[key]))throw new Error(`Invalid readiness ${key}`);
  }
}

const readinessPlan=(blockers:string[],actions:ReadinessAction[]):ReadinessPlan=>{
  const decision=evaluateRules({phase:'checkpoint',action:'prepare',readiness:blockers});
  return {decision,ready:decision.allowed&&actions.length===0,blockers,actions};
};

export function inspectReadiness(state: GameState, options: ReadinessOptions = {}): ReadinessPlan {
  validate(options);
  const blockers = canonicalReadinessBlockers(state);
  const actions: ReadinessAction[] = [];
  if(blockers.length)return readinessPlan(blockers,actions);
  const {ship, location, cargo, modules, player} = state;
  if (!ship || !location || !cargo || !modules || !player) return readinessPlan(['Canonical ship, location, cargo, modules and player state required'],actions);
  let projectedFree = ship.cargo_capacity - ship.cargo_used;
  const mining = modules.some(m => finite(m.stats?.mining_power) && m.stats!.mining_power! > 0);
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
  return readinessPlan(blockers,actions);
}

/** The callback must use the caller's existing serialized, audited connection.
 * Station services have no atomic server-side price cap. Quotes are preflight
 * estimates; canonical post-action spend is checked and any discrepancy stops.
 */
export async function ensureReadiness(account: ReadinessAccount, command: ReadinessCommand, options: ReadinessOptions = {}, execute = false) {
  await account.refresh();
  const plan = inspectReadiness(account.state, options);
  const policy_decisions:Decision[]=[plan.decision];options.decided?.(plan.decision,'checkpoint');
  const enforce=(facts:RuleFacts)=>{const decision=evaluateRules(facts);policy_decisions.push(decision);options.decided?.(decision,facts.phase);return requireAllowed(decision);};
  const completed: ReadinessAction[] = [];
  if (!execute || !plan.decision.allowed || plan.ready) return {plan,policy_decisions, completed, verification:plan};
  let spent=0;
  const shipId=account.state.ship!.id,dock=account.state.location!.docked_at,system=account.state.location!.system_id;
  const expectedModules=new Map(account.state.modules!.map(module=>[module.module_id,module.type_id]));
  const expectedCargo=new Map<string,number>();
  for(const row of account.state.cargo!)expectedCargo.set(row.item_id,(expectedCargo.get(row.item_id)??0)+row.quantity);
  const held=(id:string)=>account.state.cargo!.filter(row=>row.item_id===id).reduce((sum,row)=>sum+row.quantity,0);
  const verify=()=>{
    const blockers=canonicalReadinessBlockers(account.state);
    if(blockers.length)throw new Error(blockers.join('; '));
    if(account.state.ship!.id!==shipId||account.state.location!.docked_at!==dock||account.state.location!.system_id!==system||account.state.location!.in_transit)throw new Error('Ship or docking changed during readiness');
    for(const [id,type] of expectedModules)if(!account.state.modules!.some(module=>module.module_id===id&&module.type_id===type))throw new Error('Readiness module custody was not preserved');
    for(const [id,quantity] of expectedCargo)if(held(id)<quantity)throw new Error('Readiness cargo custody was not preserved');
  };
  for (const step of plan.actions) {
    verify();
    if (!account.state.location?.docked_at) throw new Error('Readiness stopped: ship is no longer docked');
    const service = step.action === 'spacemolt/refuel' ? 'refuel' : step.action === 'spacemolt/repair' ? 'repair' : null;
    const quote = service ? options.serviceQuotes?.[service] ?? 0 : 0;
    const availableCredits = account.state.player?.credits;
    enforce({phase:'command',action:step.action,affordability:{amount:quote,available:(options.maxServiceSpend??0)-spent,credits:availableCredits,reserve:options.creditReserve??0}});
    const removed = step.action === 'spacemolt/uninstall_mod'
      ? account.state.modules?.find(m => m.module_id === step.params.id) : undefined;
    const previousCargo = removed ? held(removed.type_id) : 0;
    const installing=step.action==='spacemolt/install_mod';
    const laserBefore=installing?held('mining_laser_i'):0;
    const moduleIds=new Set(account.state.modules!.map(module=>module.module_id));
    const reply=await command(step.action, step.params);
    const cost=requireCommandSpend(step.action,reply);
    spent+=cost;
    completed.push(step);
    await account.refresh();
    const blockers=canonicalReadinessBlockers(account.state);
    if(blockers.length)throw new Error(blockers.join('; '));
    if (removed && (account.state.modules?.some(m => m.module_id === removed.module_id)
      || held(removed.type_id)!==previousCargo+1)) {
      throw new Error('Readiness stopped: removed equipment was not verified preserved in cargo');
    }
    if(removed) {
      expectedModules.delete(removed.module_id);
      expectedCargo.set(removed.type_id,(expectedCargo.get(removed.type_id)??0)+1);
    }
    if(installing) {
      const fitted=account.state.modules!.filter(module=>!moduleIds.has(module.module_id)&&module.type_id==='mining_laser_i'&&module.slot==='utility'&&finite(module.stats?.mining_power)&&module.stats!.mining_power!>0);
      if(fitted.length!==1||laserBefore<1||held('mining_laser_i')!==laserBefore-1)throw new Error('Readiness stopped: exact mining module installation and cargo consumption not verified');
      expectedModules.set(fitted[0]!.module_id,fitted[0]!.type_id);
      expectedCargo.set('mining_laser_i',expectedCargo.get('mining_laser_i')!-1);
    }
    verify();
    const credits = account.state.player?.credits;
    enforce({phase:'spent',action:step.action,paid:true,budget:{gross_spend:spent,max_spend:options.maxServiceSpend??0,credit_reserve:options.creditReserve??0},credits});
    if(cost>quote)throw new Error('Readiness stopped: canonical spending breached the accepted quote');
  }
  return {plan,policy_decisions, completed, actual_spend:spent, verification:inspectReadiness(account.state, options)};
}
