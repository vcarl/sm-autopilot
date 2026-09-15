/** Quote one recipe at this base: the server's own dry run, plus what this base's book will
 * actually pay for the output. A dry run consumes nothing and queues nothing.
 *
 * The margin walks the buy levels rather than multiplying the top price by the quantity: a
 * run big enough to eat past the best level fetches less than the best price implies. */
import {details} from './response-details.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {walkBook} from './order-book.ts';

export interface QuoteParams {recipe_id:string;quantity?:number}

export async function quoteRecipe(account:ReadinessAccount,command:ReadinessCommand,
  params:QuoteParams):Promise<Record<string,unknown>> {
  const recipe_id=String(params.recipe_id??'');
  if(!recipe_id)throw new Error('quote requires a recipe_id');
  const quantity=params.quantity===undefined?1:Number(params.quantity);
  if(!Number.isInteger(quantity)||quantity<1)throw new Error('quantity must be a whole number of units, at least one');
  await account.refresh();
  const base_id=account.state.location?.docked_at??null;
  if(!base_id)return {recipe_id,refused:'no workshop: the ship is not docked'};
  const base=details(await command('spacemolt/get_base',{}));
  const services=(Array.isArray(base.services)?base.services:[]).map(String);
  // A craft the base cannot run is not worth a call: the refusal names the base.
  if(!services.includes('crafting'))return {recipe_id,refused:`no workshop at ${base_id}`};

  // The same source/deliver convention every craft here uses (execute.ts).
  let quote:Record<string,any>;
  try {
    quote=details(await command('spacemolt/craft',
      {id:recipe_id,quantity,dry_run:true,source:'storage',deliver_to:'storage'}));
  } catch(error) {
    // A recipe this bench cannot run comes back as an error whose text already names the
    // facility it wants and the nearest one that has it. That is the answer, not a failure:
    // hand it back whole so the pilot can act on it.
    const message=error instanceof Error?error.message:String(error);
    if(!/facility|is made in/i.test(message))throw error;
    return {recipe_id,refused:message};
  }
  const produces=(Array.isArray(quote.produces)?quote.produces:[]).map((row:any)=>
    ({item_id:String(row.item_id),...row.name?{name:String(row.name)}:{},quantity:Number(row.quantity)}));

  const market=[];
  for(const output of produces) {
    const reply=details(await command('spacemolt_market/view_market',{item_id:output.item_id}));
    const row=(Array.isArray(reply.items)?reply.items:[]).find((item:any)=>item.item_id===output.item_id);
    const levels=Array.isArray(row?.buy_orders)?row.buy_orders:[];
    market.push({item_id:output.item_id,best_buy:Number(row?.best_buy??0),
      best_buy_qty:Number(row?.best_buy_qty??0),buy_depth:walkBook(levels,output.quantity)});
  }
  const credits_total=Number(quote.credits_total??0);
  const gross=market.reduce((sum,row)=>sum+row.buy_depth.gross,0);
  return {
    recipe_id,name:quote.recipe,quantity:quote.quantity,runs:quote.runs,
    cost:{inputs:quote.cost?.inputs??[],labor:quote.cost?.labor,fee:quote.cost?.fee,credits_total},
    produces,venue:quote.venue,venue_type:quote.venue_type,facility_id:quote.facility_id,
    have_inputs:quote.have_inputs,have_credits:quote.have_credits,have_capacity:quote.have_capacity,
    market,margin:gross-credits_total,message:quote.message,
  };
}
