import {gather,storage,where,type Ctx} from '../jobs/index.ts';

/** Gather trips back to back until the store at home holds enough of one item.
 *
 * The stop condition is read from the world between runs, not counted: a trip that came
 * home short, a deposit someone else made, and a store that was already full all end the
 * script at the same place. A job that did not finish ends it there too — the outcome the
 * runner reports is that job's, and the agent answers it at the juncture.
 */
export const params={
  type:'object',
  description:'Gather repeatedly until the home store holds the quantity asked for, or the run cap is reached.',
  properties:{
    poi_id:{type:'string',description:'The mining site to work, trip after trip.'},
    item_id:{type:'string',description:'The item the store is counted for.'},
    quantity:{type:'integer',minimum:1,description:'How much of it the store must hold before the script stops.'},
    max_runs:{type:'integer',minimum:1,description:'Most trips to make, however short the store still is.'},
    base_id:{type:'string',description:'Optional: the base the take is stowed and counted at.'},
  },
  required:['poi_id','item_id','quantity','max_runs'],
};

interface Args {poi_id:string;item_id:string;quantity:number;max_runs:number;base_id?:string}

export default async (ctx:Ctx,args:Args)=>{
  for(let run=0;run<args.max_runs;run++) {
    // The store is read where the pilot can read it: at a dock. A run re-run after a
    // restart may start out at the belt with a trip half done — that trip finishes first,
    // and the next time round the loop the pilot is home and the count decides.
    const at=args.base_id??(await where(ctx)).docked_at?.base_id;
    if(at) {
      const store=await storage(ctx,at);
      const held=store.items.find(row=>row.item_id===args.item_id)?.quantity??0;
      if(held>=args.quantity)return;
    }
    const outcome=await gather(ctx,{poi_id:args.poi_id,
      ...args.base_id===undefined?{}:{base_id:args.base_id}});
    if(outcome.outcome!=='done')return;
  }
};
