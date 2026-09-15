import {gather,storage,where,type Ctx,type ScriptResult} from '../jobs/index.ts';

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

export default async (ctx:Ctx,args:Args):Promise<ScriptResult>=>{
  let trips=0,held=0,base=args.base_id??'the store';
  const say=()=>({reason:`${args.item_id} at ${base}: ${held} of ${args.quantity} after ${trips} trip${trips===1?'':'s'}`,
    held,target:args.quantity,trips});
  // One more time round than trips allowed: the last pass makes no trip, it reads the store
  // the last trip filled, so the count the script reports is the one the pilot came home to.
  for(let run=0;run<=args.max_runs;run++) {
    // The store is read where the pilot can read it: at a dock. A run re-run after a
    // restart may start out at the belt with a trip half done — that trip finishes first,
    // and the next time round the loop the pilot is home and the count decides.
    const at=args.base_id??(await where(ctx)).docked_at?.base_id;
    if(at) {
      base=at;
      const store=await storage(ctx,at);
      held=store.items.find(row=>row.item_id===args.item_id)?.quantity??0;
      if(held>=args.quantity)return say();
    }
    if(run===args.max_runs)break;
    const outcome=await gather(ctx,{poi_id:args.poi_id,
      ...args.base_id===undefined?{}:{base_id:args.base_id}});
    trips++;
    // The job that did not finish is the run's outcome; all this adds is the sentence.
    if(outcome.outcome!=='done')return {reason:say().reason};
  }
  return say();
};
