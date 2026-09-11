import type {GameState} from '@spacemolt/lib';

/** Cargo rows can repeat an item; preserve their total when measuring new yield. */
export function miningInventory(state:GameState):Record<string,number> {
  if(!Array.isArray(state.cargo))throw new Error('Canonical cargo required to measure mining yield');
  const amounts:Record<string,number>={};
  for(const item of state.cargo) {
    if(typeof item.item_id!=='string'||!item.item_id||!Number.isFinite(item.quantity)||item.quantity<0)throw new Error('Invalid canonical cargo quantity');
    amounts[item.item_id]=(amounts[item.item_id]??0)+item.quantity;
  }
  return amounts;
}

export function miningYield(before:Record<string,number>,after:Record<string,number>):Record<string,number> {
  return Object.fromEntries(Object.entries(after).map(([item,quantity])=>[item,Math.max(0,quantity-(before[item]??0))] as const).filter(([,quantity])=>quantity>0));
}

/** Accept a detailed pilot yield or the correlated mine command's state delta.
 * A later refresh alone cannot attribute incoming cargo to mining.
 */
export function measureMineYield(before:Record<string,number>,after:Record<string,number>,reply:any,
  site:{ship_id:string;system_id:string;poi_id:string},resourceIds:Set<string>) {
  const changes=miningYield(before,after);
  const result=reply?.structuredContent??reply?.delta?.details??reply;
  if(result?.kind==='yield'&&!result.drone_id&&typeof result.resource_id==='string'&&
    Number.isFinite(result.quantity)&&result.quantity>0&&(changes[result.resource_id]??0)>=result.quantity) {
    return {source:'pilot_yield_details',yields:{[result.resource_id]:result.quantity},note:'Pilot mine details corroborated by current cargo.'};
  }
  const delta=reply?.delta,location=delta?.location;
  if(reply?.command!=='mine'||!Number.isInteger(reply.tick)||reply.tick<0||reply.structuredContent!==undefined||
    !delta||delta.details!==undefined||delta.ship?.id!==site.ship_id||location?.system_id!==site.system_id||
    location?.poi_id!==site.poi_id||location.in_transit||location.docked_at||!Array.isArray(delta.cargo))return {source:'unverified',yields:{},note:'No matching pilot yield or correlated mine state delta.'};
  const accepted=miningInventory({cargo:delta.cargo} as GameState);
  if(Object.entries(before).some(([item,quantity])=>(accepted[item]??0)<quantity))return {source:'unverified',yields:{},note:'Mine delta does not preserve the starting inventory.'};
  const measured=miningYield(before,accepted);
  const eligible=Object.entries(measured).filter(([item])=>resourceIds.has(item));
  if(eligible.some(([item,quantity])=>(changes[item]??0)<quantity))return {source:'unverified',yields:{},note:'Accepted resource gains are not all retained in current cargo.'};
  const yields=Object.fromEntries(eligible);
  return {source:'command_state_delta',yields,tick:reply.tick,
    note:'Site-resource gains in the accepted mine command delta, corroborated by current cargo. Detailed extraction attribution is unavailable; simultaneous same-resource gains cannot be separated.'};
}
