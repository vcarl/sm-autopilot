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

/** The fuel cell: the cargo item `refuel` burns in space (lib `RefuelRequest.id`: "fuel_cell,
 * fuel_cell_premium, fuel_cell_military. Auto-selects cheapest if omitted"). Only the base cell
 * is bought and kept. */
export const FUEL_CELL='fuel_cell';
/** ponytail: one cargo unit a cell when no cell aboard carries its catalog `size`. Nothing recorded
 * shows it; `inspect({id:'fuel_cell'})` answers the catalog row, and a cell aboard says it outright. */
export const FUEL_CELL_SIZE=1;
/** Cells kept aboard, as a share of the hold: bought up to TARGET, only once they fall under FLOOR. */
export const CELL_TARGET=0.05,CELL_FLOOR=0.01;

type Hold={ship?:{cargo_capacity?:number}|null;cargo?:{item_id:string;quantity:number;size?:number}[]|null};

/** The cells aboard against the reserve the hold keeps: `target` whole cells (at least one, if one
 * fits), `due` when the cells aboard occupy under `CELL_FLOOR` of the hold. */
export function cellReserve(state:Hold):{held:number;target:number;size:number;due:boolean} {
  const rows=(state.cargo??[]).filter(row=>row.item_id===FUEL_CELL);
  const held=rows.reduce((sum,row)=>sum+row.quantity,0);
  const size=rows.find(row=>Number(row.size)>0)?.size??FUEL_CELL_SIZE;
  const capacity=Number(state.ship?.cargo_capacity);
  if(!(capacity>=size))return {held,target:0,size,due:false};
  const target=Math.max(1,Math.floor(capacity*CELL_TARGET/size));
  return {held,target,size,due:held<target&&(!held||held*size<capacity*CELL_FLOOR)};
}

/** What the hold may part with: everything, less the cells the reserve keeps. Every sell, deposit
 * and settle reads this instead of `miningInventory`, so the reserve is never sold off or stowed. */
export function disposable(state:GameState):Record<string,number> {
  const held=miningInventory(state);
  if(held[FUEL_CELL])held[FUEL_CELL]=Math.max(0,held[FUEL_CELL]-cellReserve(state).target);
  return held;
}
