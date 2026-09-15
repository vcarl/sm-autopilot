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
