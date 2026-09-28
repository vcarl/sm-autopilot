/** The workshop counter: recipes, quotes, and crafts at the base you are docked at.
 *
 * Every call here uses the one convention the live game answered to: `source:'storage'`,
 * `deliver_to:'storage'`. The bench escrows the inputs out of THIS base's store and delivers
 * the output back into it, so the store — not the hold — is what has to be stocked, and the
 * store's own delta before and after is the only evidence the output arrived.
 */
import {fetchCatalog,type Catalog,type CraftJobResponse,type CraftQuoteResponse,type ItemQuantity,
  type JobView,type MarketListingItem,type Recipe,type RecipeInput,type ViewStorageResponse} from '@spacemolt/lib';
import {miningInventory} from '../../mining-inventory.ts';
import {RecipeGraph} from '../../recipe-graph.ts';
import {details} from '../../response-details.ts';
import {book} from '../market.ts';
import {acct,admit,command,job,pilot,step} from '../runtime.ts';
import {stow} from '../storage.ts';
import type {Outcome,Row} from '../types.ts';

/** The catalog recipe beside what it is worth here and what you already hold. */
export type Craftable=Recipe&{
  /** Value of outputs minus inputs at this base's live `best_buy`/`best_sell`, when quoted.
   * `null` when this base has no buyer for an output: unknown, not zero. `spreads()` says
   * which base does buy it. */
  margin?:number|null;
  /** Each input against what you hold here (hold + store). */
  have:(RecipeInput&{have:number})[];
};

/** The public catalog (`GET /api/catalog.json`), which carries the recipes; this lib version
 * publishes no `get_recipes` command, so it is an HTTP read, fetched once per process. */
const CATALOG_URL='https://game.spacemolt.com';
let source:()=>Promise<Catalog>=()=>fetchCatalog(CATALOG_URL);
let cached:Promise<Catalog>|undefined;
/** Where the recipe catalog comes from. The tests pass a fixture; nothing else calls it. */
export function useCatalog(load:()=>Promise<Catalog>):void {source=load;cached=undefined;}
const catalog=()=>(cached??=source().catch(error=>{cached=undefined;throw error;}));

const CAP=20,TICK_MS=10_000,WAIT_CEILING_MS=10*60_000,WAIT_LINE_MS=90_000;
const DONE=new Set(['done','complete','completed','finished','delivered']);
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const held=(rows:{item_id:string;quantity:number}[],item:string)=>
  rows.filter(row=>row.item_id===item).reduce((sum,row)=>sum+row.quantity,0);
// Ref'd: the awaited sleep IS the work in flight (see hunting.ts).
const sleep=(ms:number)=>new Promise<void>(resolve=>{setTimeout(resolve,ms);});

/** Docked, at a base whose services include crafting. Both halves are the pilot's answer:
 * "there is no bench here" is what it needs to hear, not a failure. */
async function bench(fn:string):Promise<{base:string}|{refused:string}> {
  const docked=acct().state.location?.docked_at;
  if(!docked)return {refused:`${fn} happens at a bench and the ship is not docked`};
  const base=details(await command('spacemolt/get_base',{}));
  const services=(Array.isArray(base.services)?base.services:[]).map(String);
  if(!services.includes('crafting'))
    return {refused:`no workshop at ${docked}: its services are ${services.join(', ')||'none'}`};
  return {base:docked};
}

/** This base's store, item rows only. */
async function storeRows():Promise<{item_id:string;quantity:number}[]> {
  return ((details(await command('spacemolt_storage/view',{})) as ViewStorageResponse).items??[])
    .map(row=>({item_id:row.item_id,quantity:row.quantity}));
}

const call=(recipeId:string,quantity:number,preset?:string)=>
  ({id:recipeId,quantity,source:'storage',deliver_to:'storage',...preset?{preset}:{}});

/** The server's own dry run: consumes nothing, queues nothing. A bench that cannot run the
 * recipe answers with an error whose text already names the facility it wants — that text IS
 * the answer, so it comes back as a refusal rather than a throw. */
async function dryRun(recipeId:string,quantity:number,preset?:string):Promise<CraftQuoteResponse|{refused:string}> {
  try {return details(await command('spacemolt/craft',{...call(recipeId,quantity,preset),dry_run:true})) as CraftQuoteResponse;}
  catch(error){return {refused:message(error)};}
}

/** The pilot's queued bench jobs: `craft` with no recipe named is the queue read. */
async function queue():Promise<JobView[]> {
  const reply=details(await command('spacemolt/craft',{}));
  return (Array.isArray(reply.jobs)?reply.jobs:[]) as JobView[];
}

/** What the outputs fetch at this base's top buy level, or `null` when one of them has no
 * buyer here at all. A missing buyer is not a price of zero: read as zero it says "crafting
 * is worthless" when what it means is "not here" (session-sonnet-3).
 * ponytail: the top level only (`best_buy × best_buy_qty`), as `prices()` values a hold. A
 * run big enough to eat past it fetches less; `walkBook(row.buy_orders, qty)` is the exact
 * answer the day a margin has to be trusted to the credit. */
const worth=(outputs:ItemQuantity[]|undefined,listed:Map<string,MarketListingItem>):number|null=>{
  let sum=0;
  for(const out of outputs??[]) {
    const row=listed.get(out.item_id);
    if(!row||!(row.best_buy>0))return null;
    sum+=row.best_buy*Math.min(out.quantity,row.best_buy_qty);
  }
  return sum;
};
/** The output items a set of recipes makes, for a `next` that names what to go price. */
const outputsOf=(made:{outputs?:{item_id:string}[]}[])=>
  [...new Set(made.flatMap(row=>(row.outputs??[]).map(out=>out.item_id)))];

/** What can be made here, right now, out of what this base's store and the hold hold between
 * them: every catalog recipe whose inputs are all covered, each one dry-run for its real fee
 * and labour and priced against this base's book (one market read), sorted by margin in
 * credits. Reads only — nothing is escrowed, bought or queued.
 *
 * `search` filters on recipe id, name, category or output item. Capped at 20 quoted rows;
 * `did` says how many covered recipes were cut. Refused when there is no bench here, which is
 * itself the answer: the ore is in the wrong place. */
export function recipes(search?:string):Promise<Outcome<{recipes:Craftable[]}>> {
  return job<{recipes:Craftable[]}>('recipes',search??'',async()=>{
    const none={recipes:[] as Craftable[]};
    const at=await bench('recipes');
    if('refused' in at)return {status:'refused',did:'read no recipes',why:at.refused,detail:none,
      next:['goTo a base whose services include crafting, then recipes() again']};
    let cat:Catalog;
    try {cat=await catalog();}
    catch(error){return {status:'failed',did:'read no recipes',why:`catalog unavailable: ${message(error)}`,detail:none};}

    const stock:Record<string,number>={...miningInventory(acct().state)};
    for(const row of await storeRows())stock[row.item_id]=(stock[row.item_id]??0)+row.quantity;
    const graph=RecipeGraph.from(cat);
    const needle=(search??'').trim().toLowerCase();
    const covered=graph.craftableWith(stock).filter(cov=>cov.complete)
      .filter(cov=>!needle||[cov.recipe.id,cov.recipe.name,cov.recipe.category,
        ...(cov.recipe.outputs??[]).map(out=>out.item_id)]
        .some(text=>String(text).toLowerCase().includes(needle)));

    const listed=await book();
    const made:Craftable[]=[];
    for(const cov of covered.slice(0,CAP)) {
      const have=(cov.recipe.inputs??[]).map(inp=>({...inp,have:stock[inp.item_id]??0}));
      const quote=await dryRun(cov.recipe.id,1);
      if('refused' in quote){made.push({...cov.recipe,have});continue;}
      const value=worth(quote.produces,listed);
      made.push({...cov.recipe,have,margin:value===null?null:Math.round(value-Number(quote.credits_total??0))});
    }
    made.sort((a,b)=>(b.margin??-Infinity)-(a.margin??-Infinity));
    const cut=covered.length-made.length;
    const best=made[0];
    // A margin of null everywhere is the honest headline: the bench works, the counter here
    // does not buy what it makes. Saying "margin 0" sent a pilot away from crafting entirely.
    const unpriced=made.filter(row=>row.margin===null||row.margin===undefined);
    const noBuyer=made.length>0&&unpriced.length===made.length;
    return {status:'done',
      did:`${made.length} recipe${made.length===1?'':'s'} can be made at ${at.base} from what is held and stored here`
        +(cut>0?`; ${cut} more covered recipe${cut===1?'':'s'} not quoted`:'')
        +(noBuyer?`, no buyer here for their outputs; see spreads()`
          :best&&best.margin!=null?`; best margin ${best.name} ${best.margin} cr`
          :best?`; best margin ${best.name} unquoted`:''),
      detail:{recipes:made},
      next:noBuyer?[`spreads(${JSON.stringify(outputsOf(made).slice(0,5))}) — which base buys what this bench makes`,
        `craft anyway and carry it: the margin is unknown here, not zero`]
        :best&&(best.margin??0)>0?[`quote('${best.id}', 10) then craft('${best.id}', 10)`]:[]};
  });
}

/** One recipe's full cost against what it is worth here. */
export type Quoted=CraftQuoteResponse&{
  /** The quoted outputs at this base's top buy level, or `null` when this base has no buyer
   * for one of them. */
  output_value:number|null;
  /** `output_value` less `credits_total`. Positive is worth crafting here; `null` means
   * unknown here, not zero — `spreads()` says which base buys the output. */
  margin:number|null;
  /** Inputs this base's store is short of, with the local ask (`best_sell`) when it lists one. */
  missing:(RecipeInput&{have:number;ask:number})[];
};

/** A dry-run quote for one recipe at this bench: the escrow (inputs, labour, fee),
 * `credits_total`, `est_completion_tick`, `have_inputs`/`have_credits`/`have_capacity`, plus
 * what the outputs fetch here and the inputs the store is short of, priced at the local ask.
 * Nothing is committed. `next` names the `buy`/`stow` calls that would close the gap. */
export function quote(recipeId:string,quantity=1):Promise<Outcome<Quoted>> {
  return job<Quoted>('quote',`${quantity} × ${recipeId}`,async()=>{
    const none={} as Quoted;
    if(!Number.isInteger(quantity)||quantity<1)
      return {status:'refused',did:`did not quote ${recipeId}`,why:'quantity must be a whole number of output units, at least one',detail:none};
    const at=await bench('quote');
    if('refused' in at)return {status:'refused',did:`did not quote ${recipeId}`,why:at.refused,detail:none};
    const quoted=await dryRun(recipeId,quantity);
    if('refused' in quoted)return {status:'refused',did:`did not quote ${recipeId}`,why:quoted.refused,detail:none};

    const store=await storeRows();
    const listed=await book();
    const missing=(quoted.cost?.inputs??[]).map(inp=>{
      const have=held(store,inp.item_id);
      return {item_id:inp.item_id,quantity:inp.quantity,have,ask:listed.get(inp.item_id)?.best_sell??0};
    }).filter(row=>row.have<row.quantity);
    const valued=worth(quoted.produces,listed);
    const output_value=valued===null?null:Math.round(valued);
    const detail:Quoted={...quoted,output_value,
      margin:output_value===null?null:output_value-Number(quoted.credits_total??0),missing};
    const made=(quoted.produces??[]).map(row=>`${row.quantity} ${row.item_id}`).join(', ')||'nothing';
    const outs=outputsOf([{outputs:quoted.produces}]);
    return {status:'done',
      did:`${quoted.recipe}: ${quoted.runs} run${quoted.runs===1?'':'s'} for ${quoted.credits_total} cr makes ${made}`
        +(output_value===null?`, no buyer here for their outputs; see spreads()`
          :`, worth ${output_value} cr here — margin ${detail.margin} cr`),
      detail,
      next:[...output_value===null?[`spreads(${JSON.stringify(outs)}) — which base buys it`]:[],
      ...missing.map(row=>`${row.item_id}: store has ${row.have} of ${row.quantity}`
        +(row.ask>0?`; buy('${row.item_id}', ${row.quantity-row.have}, {deliverTo:'storage'}) at ${row.ask} cr each`:'; not listed here, stow() or mine it')),
      ...(detail.margin??0)>0&&!missing.length?[`craft('${recipeId}', ${quantity})`]:[]].slice(0,3)};
  });
}

export interface Crafted {
  /** The commit, or the queue row this run re-entered on. */
  job:CraftJobResponse|JobView;
  /** What landed in the store, measured from `storage/view` before and after. */
  made:Row[];
}

/** Quote, stock the store, commit the escrow, wait out the queue, confirm the outputs landed
 * in this base's store.
 *
 * Preconditions, all before anything is committed: docked at a base with a workshop; the
 * inputs in this base's store, with anything the hold carries stowed into it by name first;
 * the fee inside `credits − permissions.credit_reserve`. Refused, naming the shortfall, when
 * any of them does not hold.
 *
 * A job already queued here for this recipe IS this job: the run re-enters at the wait and
 * escrows nothing twice, so a re-run after a restart is safe. The wait streams a line at
 * least every 90 seconds and gives up after 10 minutes with `partial` and the job. Tired
 * mid-wait keeps waiting — the ship is docked — but `craft` will not start while Tired.
 *
 * Trains crafting, and engineering for components and modules. */
export function craft(recipeId:string,quantity=1,opts:{preset?:'fast'|'cheap'|'prefer_own'|'workshop'}={}):Promise<Outcome<Crafted>> {
  return job<Crafted>('craft',`${quantity} × ${recipeId}${opts.preset?` ${opts.preset}`:''}`,async()=>{
    const none={job:{} as CraftJobResponse,made:[]};
    const refuse=(why:string,next:string[]=[])=>({status:'refused' as const,did:`crafted no ${recipeId}`,why,detail:none,next});
    const blocked=await admit('craft');
    if(blocked)return refuse(blocked);
    if(!Number.isInteger(quantity)||quantity<1)
      return refuse('quantity must be a whole number of output units, at least one');
    const at=await bench('craft');
    if('refused' in at)return refuse(at.refused,['goTo a base whose services include crafting']);

    let quoted=await dryRun(recipeId,quantity,opts.preset);
    if('refused' in quoted)return refuse(quoted.refused);
    const name=quoted.recipe||recipeId;

    // The escrow this run may already have made is the job sitting in the queue.
    const mine=(await queue()).filter(row=>String(row.base_id??at.base)===at.base);
    let running=mine.find(row=>row.recipe===name);
    let before=await storeRows();

    if(!running) {
      // The bench escrows from the store; what the hold carries has to be stowed first.
      if(quoted.have_inputs===false) {
        const short=(quoted.cost?.inputs??[]).filter(inp=>held(before,inp.item_id)<inp.quantity);
        const aboard=miningInventory(acct().state);
        const bring=short.filter(inp=>(aboard[inp.item_id]??0)>0)
          .map(inp=>({item_id:inp.item_id,quantity:Math.min(aboard[inp.item_id]!,inp.quantity-held(before,inp.item_id))}));
        if(bring.length) {
          step(`stowing the inputs the bench escrows from the store: ${bring.map(row=>`${row.quantity} ${row.item_id}`).join(', ')}`);
          await stow(bring);
          before=await storeRows();
          const again=await dryRun(recipeId,quantity,opts.preset);
          if('refused' in again)return refuse(again.refused);
          quoted=again;
        }
      }
      if(quoted.have_inputs===false) {
        const short=(quoted.cost?.inputs??[]).map(inp=>({...inp,have:held(before,inp.item_id)}))
          .filter(inp=>inp.have<inp.quantity);
        return refuse(`${name} is short at ${at.base}: ${short.map(row=>`${row.item_id} ${row.have} of ${row.quantity}`).join(', ')||'the inputs it escrows'}`,
          [`quote('${recipeId}', ${quantity}) names what to buy or mine`]);
      }
      const cost=Number(quoted.credits_total??0);
      const credits=acct().state.player?.credits??0;
      const reserve=pilot().permissions?.credit_reserve??0;
      if(quoted.have_credits===false||credits-cost<reserve)
        return refuse(`${name} costs ${cost} cr; ${credits} less the ${reserve} credit reserve cannot cover it`);
      if(quoted.have_capacity===false)
        return refuse(`${at.base}'s store has no room for ${name}'s output`);
      step(`quote ${name}: ${quoted.runs} run(s), ${cost} cr, done by tick ${quoted.est_completion_tick}`);

      try {running=details(await command('spacemolt/craft',call(recipeId,quantity,opts.preset))) as unknown as JobView;}
      catch(error){return {status:'failed',did:`crafted no ${recipeId}`,why:`${name} was not queued at ${at.base}: ${message(error)}`,detail:none};}
      step(`committed ${name} as job ${running.job_id}`);
    } else step(`job ${running.job_id} for ${name} is already queued here; re-entering at the wait`);

    const job_id=String(running.job_id??'');
    const produces=(running.produces??quoted.produces??[]) as ItemQuantity[];
    // ponytail: the queue is polled. This lib version publishes no crafting event to listen
    // for; drop the poll for `onCraftingUpdate` the day the lib exposes one.
    const eta=Number(running.eta_ticks);
    const pause=Math.min(60_000,Math.max(250,(Number.isFinite(eta)?Math.max(eta,0):1)*TICK_MS));
    const deadline=Date.now()+WAIT_CEILING_MS;
    let lastLine=Date.now(),status='queued';
    for(;;) {
      const row=(await queue()).find(current=>String(current.job_id)===job_id);
      if(!row||DONE.has(String(row.status??'').toLowerCase()))break;
      status=String(row.status??'queued');
      if(Date.now()>=deadline) {
        return {status:'partial',did:`${name} is still ${status} at ${at.base} as job ${job_id}`,
          why:`the bench did not deliver inside ${WAIT_CEILING_MS/60_000} minutes`,detail:{job:running,made:[]},
          next:[`craft('${recipeId}', ${quantity}) again re-enters at the wait for job ${job_id}`]};
      }
      if(Date.now()-lastLine>=WAIT_LINE_MS) {
        lastLine=Date.now();
        step(`waiting on job ${job_id}: ${status}, ${row.runs_done ?? 0} of ${row.runs_total ?? '?'} runs`);
      }
      await sleep(pause);
    }

    // The store is where the output was delivered, so the store's delta says it arrived. The
    // reply's claim is never the evidence.
    const after=await storeRows();
    const made:Row[]=produces.map(row=>({item_id:row.item_id,quantity:held(after,row.item_id)-held(before,row.item_id)}))
      .filter(row=>row.quantity>0);
    if(!made.length)
      return {status:'failed',did:`crafted no ${recipeId}`,
        why:`${name} left the queue but ${at.base}'s store shows none of ${produces.map(row=>row.item_id).join(', ')||'the output'}`,
        detail:{job:running,made:[]}};
    return {status:'done',
      did:`${name}: ${made.map(row=>`${row.quantity} ${row.item_id}`).join(', ')} in ${at.base}'s store`,
      detail:{job:running,made},
      next:[`prices([${made.map(row=>`'${row.item_id}'`).join(', ')}]) then sell(made, {from:'store'})`]};
  });
}
