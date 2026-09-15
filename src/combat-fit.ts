import {evaluateRules,requireAllowed,type Decision,type RuleFacts} from './rules.ts';
import type {Account} from '@spacemolt/lib';
import {details} from './response-details.ts';
import {type IndustryCommand} from './industry.ts';
import {requireCommandSpend} from './spending.ts';

export class CombatBlocked extends Error {}

export interface FitParams {
  weapon_id?:string;
  ammo_id?:string;
  defense_id?:string;
  execute?:boolean;
  max_spend?:number;
  credit_reserve?:number;
}

/** Inspect exact live module requirements before spending or changing the fit. */
export async function prepareCombat(params:FitParams, account:Account, command:IndustryCommand,decided?:(decision:Decision,phase?:RuleFacts['phase'])=>void) {
  const policy_decisions:Decision[]=[];
  const decide=(facts:RuleFacts)=>{const decision=evaluateRules(facts);policy_decisions.push(decision);decided?.(decision,facts.phase);return decision;};
  const block=(reason:string)=>requireAllowed(decide({phase:'checkpoint',action:'prepare',readiness:[reason]}));
  if(!account.location?.docked_at)block('Dock before preparing combat equipment');
  const budget=requireAllowed(decide({phase:'bounds',budgetConfig:{kind:'combat_fit',maxSpend:params.max_spend,reserve:params.credit_reserve}}));
  const maxSpend=budget.limits.max_spend!,reserve=budget.limits.credit_reserve!;
  const afford=(amount:number,spent=0)=>requireAllowed(decide({phase:'command',action:'spacemolt/buy',paid:true,budget:{gross_spend:spent,max_spend:maxSpend,credit_reserve:reserve},affordability:{amount,available:maxSpend-spent,credits:account.credits,reserve}}));
  const ship=account.ship!;
  const before=account.credits!;
  const modules=account.state.modules??[];
  const storage=details(await command('spacemolt_storage/view',{})).items??[];
  const plan:any[]=[];
  let cpu=ship.cpu_used,power=ship.power_used,cargo=ship.cargo_used,cost=0;
  const weaponId=params.weapon_id??modules.find(m=>m.slot==='weapon')?.type_id??'pulse_laser_i';
  const weaponInfo=details(await command('spacemolt/inspect',{id:weaponId})).catalog?.items?.find((i:any)=>i.id===weaponId);
  if(!weaponInfo||weaponInfo.slot!=='weapon'||!(weaponInfo.damage>0))block('Choose a verified damage weapon');
  let ammoId:string|undefined;
  if(weaponInfo.ammo_type) {
    // A large magazine can cover the bounded fight without a mid-battle reload tick.
    if(weaponInfo.ammo_type!=='autocannon'||weaponInfo.magazine_size<500)block('Starter hunting supports ammo-free weapons or large-magazine autocannons');
    ammoId=params.ammo_id??'standard_rounds_box';
    const ammo=details(await command('spacemolt/inspect',{id:ammoId})).catalog?.items?.find((i:any)=>i.id===ammoId);
    if(ammo?.effect?.type!=='ammo'||ammo.effect.subtype!==weaponInfo.ammo_type)block('Ammo does not match the weapon');
    const held=(account.cargo??[]).find(i=>i.item_id===ammoId)?.quantity??0;
    const needed=Math.max(0,2-held);
    if(needed>0) {
      const stored=storage.find((i:any)=>i.item_id===ammoId)?.quantity??0;
      const source=stored>=needed?'storage':'buy';
      let quote;
      if(source==='buy') {
        quote=details(await command('spacemolt_market/estimate_purchase',{item_id:ammoId,quantity:needed}));
        if(quote.unfilled!==0||!Number.isFinite(quote.total_cost)||quote.total_cost<0)block('Source matching ammo before fitting; no complete purchase quote');
        cost+=quote.total_cost;
      }
      cargo+=needed*ammo.size;
      if(cargo>ship.cargo_capacity)block('Insufficient cargo for reserve ammunition');
      plan.push({id:ammoId,slot:'ammo',source,quantity:needed,quote});
    }
  }
  for(const [id,slot] of [[weaponId,'weapon'],[params.defense_id,'defense']]) {
    if(!id||modules.some(m=>m.type_id===id))continue;
    const item=details(await command('spacemolt/inspect',{id})).catalog?.items?.find((i:any)=>i.id===id);
    if(!item||item.slot!==slot)block(`Not a verified ${slot} module: ${id}`);
    if(slot==='weapon'&&!(item.damage>0))block('Starter hunting requires a damage weapon');
    const blocked=Object.entries(item.required_skills??{}).filter(([skill,level])=>(account.state.skills?.[skill]?.level??0)<Number(level));
    if(blocked.length)block(`Unmet fitting skills for ${id}: ${JSON.stringify(blocked)}`);
    if(modules.filter(m=>m.slot===slot).length>=Number(slot==='weapon'?ship.weapon_slots:ship.defense_slots))block(`No empty ${slot} slot; existing equipment is preserved`);
    if(![item.cpu_usage,item.power_usage,item.size].every(Number.isFinite))block('Incomplete fitting requirements');
    cpu+=item.cpu_usage;power+=item.power_usage;
    if(cpu>ship.cpu_capacity||power>ship.power_capacity)block('Insufficient CPU or power');
    if(item.speed_penalty&&ship.speed-item.speed_penalty<2)block('This defense would make the starter ship too slow to withdraw');
    const carried=(account.cargo??[]).some(i=>i.item_id===id&&i.quantity>=1);
    const stored=storage.some((i:any)=>i.item_id===id&&i.quantity>=1);
    if(!carried&&cargo+item.size>ship.cargo_capacity)block('Insufficient cargo room to load the module');
    cargo=(carried?cargo-item.size:cargo);
    if(cargo>ship.cargo_capacity+Number(item.cargo_bonus??0))block('Fit would exceed cargo capacity');
    const source=carried?'cargo':stored?'storage':'buy';
    let quote;
    if(source==='buy') {
      quote=details(await command('spacemolt_market/estimate_purchase',{item_id:id,quantity:1}));
      if(quote.unfilled!==0||!Number.isFinite(quote.total_cost)||quote.total_cost<0)block(`No complete live purchase quote for ${id}`);
      cost+=quote.total_cost;
    }
    plan.push({id,slot,source,quote,requirements:item});
  }
  afford(cost);
  if(!params.execute)return {status:'quoted',policy_decisions,plan,estimated_spend:cost,max_spend:maxSpend,credit_reserve:reserve,ship};
  let spent=0;
  for(const step of plan) {
    if(step.source==='buy') {
      const quote=details(await command('spacemolt_market/estimate_purchase',{item_id:step.id,quantity:step.quantity??1}));
      if(quote.unfilled!==0||!Number.isFinite(quote.total_cost)||quote.total_cost<0)block('Fresh fitting purchase quote is incomplete');
      afford(quote.total_cost,spent);
      const receipt=await command('spacemolt/buy',{id:step.id,quantity:step.quantity??1,auto_list:false});
      const cost=requireCommandSpend('spacemolt/buy',receipt);spent+=cost;
      afford(0,spent);
      if(cost>quote.total_cost)block('Actual fitting spend exceeded quote; stop and reconcile');
    }
    if(step.source==='storage')await command('spacemolt_storage/withdraw',{item_id:step.id,quantity:step.quantity??1});
    if(!(account.cargo??[]).some(i=>i.item_id===step.id&&i.quantity>=(step.quantity??1)))throw new Error('Purchased/withdrawn equipment not verified in cargo');
    if(step.slot==='ammo')continue;
    await command('spacemolt/install_mod',{id:step.id});
    if(!account.state.modules?.some(m=>m.type_id===step.id))throw new Error('Module installation not confirmed');
  }
  if(ammoId) {
    const fitted=account.state.modules?.find(m=>m.type_id===weaponId);
    if(!fitted)throw new Error('Weapon not installed');
    if(Number((fitted as any).current_ammo??0)<100)await command('spacemolt_battle/reload',{id:fitted.module_id,target:ammoId});
    if(Number((account.state.modules?.find(m=>m.module_id===fitted.module_id) as any)?.current_ammo??0)<100)throw new Error('Loaded magazine not verified');
  }
  return {status:'fitted',policy_decisions,plan,actual_spend:spent,cash_delta:account.credits!-before,ship:account.ship,modules:account.state.modules,
    next:'Restore hull, shields and fuel before scouting or hunting. Purchases are equipment capital, not hunting profit.'};
}
