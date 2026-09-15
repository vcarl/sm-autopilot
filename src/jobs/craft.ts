/** One craft at the bench the ship is docked at: quote, commit the escrow, wait out the
 * queue, confirm the output landed in this base's store.
 *
 * Every step is named for an end state and sends nothing when that state already holds, so a
 * run re-run after a restart never escrows twice: the job it already queued IS this job, and
 * the re-run re-enters at the wait. Nothing here sells, withdraws or buys — the inputs are
 * escrowed from this base's storage and the output is delivered back to it, which is the one
 * call convention every craft in this tree uses.
 */
import {details} from '../response-details.ts';
import type {MineYieldRow} from '../mine.ts';
import type {Ctx,JobOutcome} from './ctx.ts';
import {storage} from './helpers.ts';

export interface CraftParams {
  /** The recipe to run, as `spacemolt_recipes` lists it. */
  recipe_id:string;
  /** How many units of the output to ask for. The server answers with the runs it will do. */
  quantity:number;
  /** Optional: the facility to run it at, when the recipe names one. */
  facility_id?:string;
}

/** ponytail: the game quotes a craft in ticks and a tick is ten seconds of real time. One
 * number, not a config system; lift it the day a recipe is quoted in anything else. */
const TICK_MS=10_000;
/** The runner's wall-clock cap ends the whole run; this is the job's own ceiling, so one
 * bench job that never finishes does not eat a shift that had other work after it. */
const WAIT_CEILING_MS=10*60_000;
const DONE=new Set(['done','complete','completed','finished']);

const sleep=(ms:number)=>new Promise<void>(resolve=>{const timer=setTimeout(resolve,ms);timer.unref?.();});
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const held=(rows:{item_id:string;quantity:number}[],item:string)=>
  rows.find(row=>row.item_id===item)?.quantity??0;
const rows=(value:unknown):MineYieldRow[]=>(Array.isArray(value)?value:[])
  .map((row:any)=>({item_id:String(row.item_id),quantity:Number(row.quantity)}));
const say=(made:MineYieldRow[])=>made.map(row=>`${row.quantity} ${row.item_id}`).join(', ');

/** The pilot's own bench jobs. `craft` with no recipe named is the queue read. */
async function queue(ctx:Ctx):Promise<Record<string,any>[]> {
  const reply=details(await ctx.command('spacemolt/craft',{}));
  return (Array.isArray(reply.jobs)?reply.jobs:[]) as Record<string,any>[];
}

export async function craft(ctx:Ctx,params:CraftParams):Promise<JobOutcome> {
  await ctx.check('craft');
  const resuming=ctx.resuming();
  const recipe_id=String(params.recipe_id??'');
  if(!recipe_id)throw new Error('craft requires a recipe_id: the recipe to run');
  const asked=Number(params.quantity);
  if(!Number.isInteger(asked)||asked<1)
    throw new Error('craft requires a quantity: a whole number of output units, at least one');
  const end=(outcome:JobOutcome['outcome'],reason:string,extra:Partial<JobOutcome>={}):JobOutcome=>{
    const row:JobOutcome={job:'craft',outcome,reason,...extra};
    ctx.jobs.push(row);
    return row;
  };

  ctx.progress({last_job:'craft',last_step:'bench'});
  await ctx.account.refresh();
  const base_id=String(ctx.account.state.location?.docked_at??'');
  if(!base_id)return end('failed','a craft happens at a bench and the ship is not docked');
  let services:string[];
  try {
    const base=details(await ctx.command('spacemolt/get_base',{}));
    services=(Array.isArray(base.services)?base.services:[]).map(String);
  } catch(error){return end('failed',`${base_id} would not say what it offers: ${message(error)}`);}
  if(!services.includes('crafting'))
    return end('failed',`no crafting service at ${base_id}; the bench is at a base with a workshop`);

  const call={id:recipe_id,quantity:asked,source:'storage',deliver_to:'storage',
    ...params.facility_id?{facility_id:String(params.facility_id)}:{}};

  // A run re-run after a restart: the escrow it may already have made is the queued job.
  // ponytail: an empty queue is read as "nothing was committed", so a job that both started
  // and finished inside the gap would be crafted again. The queue is the only evidence the
  // server offers; a resumed run carrying its own job_id would close it.
  let job:Record<string,any>|undefined;
  if(resuming) {
    const mine=(await queue(ctx)).filter(row=>String(row.base_id??base_id)===base_id);
    job=mine.find(row=>String(row.recipe_id??row.recipe??'')===recipe_id)??(mine.length===1?mine[0]:undefined);
    if(!job&&mine.length>1)
      return end('blocked',
        `${mine.length} bench jobs are queued at ${base_id} and none names ${recipe_id}; which one this run committed cannot be told`);
  }

  const before=await storage(ctx,base_id);
  let name=recipe_id,runs=0,quoted=asked,cost=0;
  let produces:MineYieldRow[]=job?rows(job.produces):[];
  if(job) {
    runs=Number(job.runs_total??job.runs??0);
    name=String(job.recipe??recipe_id);
  } else {
    ctx.progress({last_job:'craft',last_step:'quote'});
    let quote:Record<string,any>;
    try {quote=details(await ctx.command('spacemolt/craft',{...call,dry_run:true}));}
    // A recipe this bench cannot run comes back as an error whose text already names the
    // facility it wants and the nearest one that has it. That text IS the answer.
    catch(error){return end('failed',message(error));}
    name=String(quote.recipe??recipe_id);
    cost=Number(quote.credits_total??0);
    runs=Number(quote.runs??0);
    quoted=Number(quote.quantity??asked);
    if(quote.have_inputs===false) {
      const short=rows(quote.cost?.inputs)
        .filter(row=>held(before.items,row.item_id)<row.quantity)
        .map(row=>`${row.item_id} ${held(before.items,row.item_id)} of ${row.quantity}`);
      return end('failed',`${name} is short at ${base_id}: ${short.join(', ')||'the inputs it escrows'}`);
    }
    const credits=Number(ctx.account.state.player?.credits??0);
    const reserve=Number(ctx.permissions.credit_reserve??0);
    if(quote.have_credits===false||credits-cost<reserve)
      return end('blocked',
        `${name} costs ${cost} credits; ${credits} less the operator's ${reserve} credit reserve cannot cover it`);

    ctx.progress({last_job:'craft',last_step:'commit'});
    let committed:Record<string,any>;
    try {committed=details(await ctx.command('spacemolt/craft',call));}
    catch(error){return end('failed',`${name} was not queued at ${base_id}: ${message(error)}`);}
    job=committed;
    name=String(committed.recipe??name);
    runs=Number(committed.runs??runs);
    produces=rows(committed.produces);
  }

  // The escrow is made: what this job has left to do is wait and confirm, and the record says
  // so, so a restart from here re-enters at the wait rather than at the commit.
  const job_id=String(job?.job_id??'');
  const escrowed=job?.escrowed as unknown;
  ctx.progress({last_job:'craft',
    last_step:`wait ${JSON.stringify({job_id,name,runs,produces,...escrowed?{escrowed}:{}})}`});

  const eta=Number(job?.eta_ticks);
  const ticks=Number.isFinite(eta)?Math.max(eta,0):1;
  const pause=Math.min(60_000,Math.max(250,ticks*TICK_MS));
  const deadline=Date.now()+Math.min(WAIT_CEILING_MS,Math.max(2,ticks+6)*TICK_MS);
  for(;;) {
    const mine=(await queue(ctx)).find(row=>String(row.job_id)===job_id);
    if(!mine||DONE.has(String(mine.status??'').toLowerCase()))break;
    if(Date.now()>=deadline)
      return end('failed',
        `${name} is still ${mine.status??'queued'} at ${base_id} after the wait this job allows`,
        {result:{recipe_id,name,runs,job_id,cost,produced:[],base_id}});
    await sleep(pause);
  }

  // The store is where the output was delivered, so the store is what says it arrived. The
  // reply's claim is never the evidence: the delta across the two reads is.
  ctx.progress({last_job:'craft',last_step:'confirm'});
  const after=await storage(ctx,base_id);
  const made:MineYieldRow[]=produces
    .map(row=>({item_id:row.item_id,
      quantity:held(after.items,row.item_id)-held(before.items,row.item_id)}))
    .filter(row=>row.quantity>0);
  const result={recipe_id,name,runs,job_id,cost,produced:made,base_id};
  if(!made.length)
    return end('failed',
      `${name} left the queue but ${base_id}'s store shows none of ${produces.map(row=>row.item_id).join(', ')||'the output'}`,
      {result});
  return end('done',
    `${name}: ${runs} run${runs===1?'':'s'}, ${say(made)}, ${cost>0?`cost ${cost}`:'already escrowed'} at ${base_id}`
      +(quoted<asked?`; the bench quoted ${quoted} of the ${asked} asked, in ${runs} run${runs===1?'':'s'}`:''),
    {yield:made,result});
}
