/** The bench at the base you are docked at — its workshop, or a facility there named by id:
 * recipes, quotes, stocking the store, crafts, the queue, and what a recipe tree comes to.
 *
 * Every call here uses the one convention the live game answered to: `source:'storage'`,
 * `deliver_to:'storage'`. The bench escrows the inputs out of THIS base's store and delivers
 * the output back into it, so the store — not the hold — is what has to be stocked, and the
 * store's own delta before and after is the only evidence the output arrived.
 */
import {fetchCatalogConditional,type Catalog,type CraftJobResponse,type CraftQuoteResponse,type EstimatePurchaseResponse,
  type ItemQuantity,type JobView,type MarketListingItem,type Recipe,type RecipeInput,type ViewStorageResponse} from '@spacemolt/lib';
import {mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {miningInventory} from '../../mining-inventory.ts';
import {RecipeGraph} from '../../recipe-graph.ts';
import {details} from '../../response-details.ts';
import {journalRun} from '../../run-record.ts';
import {book,buy} from '../market.ts';
import {acct,admit,command,job,pilot,runtimeDir,step} from '../runtime.ts';
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
 * publishes no `get_recipes` command, so it is an HTTP read, revalidated once per process. */
const CATALOG_URL='https://game.spacemolt.com',CATALOG_FILE='catalog.json';
let source:()=>Promise<Catalog>=()=>revalidated(runtimeDir());
let cached:Promise<Catalog>|undefined;
/** Where the recipe catalog comes from. The tests pass a fixture; nothing else calls it. */
export function useCatalog(load:()=>Promise<Catalog>):void {source=load;cached=undefined;}
const catalog=()=>(cached??=source().catch(error=>{cached=undefined;throw error;}));

/** The catalog kept in `dir` beside its ETag, so a fresh process pays a ~0-byte 304 rather than
 * the multi-MB body when nothing changed, and a failed fetch falls back to the copy on disk.
 * One `fetch` line each time: status, ms, bytes stored, whether the disk copy answered. */
export async function revalidated(dir:string|undefined,
  load:typeof fetchCatalogConditional=fetchCatalogConditional):Promise<Catalog> {
  const path=dir?join(dir,CATALOG_FILE):undefined,since=Date.now();
  let kept:{etag?:string;catalog?:Catalog}={};
  try {if(path)kept=JSON.parse(readFileSync(path,'utf8'));} catch {/* no copy yet, or a torn one: fetch whole */}
  const note=(entry:Record<string,unknown>)=>{if(dir)journalRun(dir,{url:'/api/catalog.json',ms:Date.now()-since,...entry},'fetch');};
  let got:Awaited<ReturnType<typeof fetchCatalogConditional>>;
  try {got=await load(CATALOG_URL,kept.catalog?kept.etag:undefined);}
  catch(error) {
    note({ok:false,error:message(error).slice(0,200),...kept.catalog?{from_disk:true}:{}});
    if(kept.catalog)return kept.catalog;
    throw error;
  }
  if(got.notModified&&kept.catalog) {note({ok:true,status:304,from_disk:true});return kept.catalog;}
  if(!got.catalog)throw new Error('catalog fetch returned no catalog');
  const body=JSON.stringify({etag:got.etag,catalog:got.catalog});
  if(path)try {
    mkdirSync(dir!,{recursive:true});
    const temp=`${path}.${process.pid}.tmp`;
    writeFileSync(temp,body,{mode:0o600});
    renameSync(temp,path);
  } catch {/* unwritten: the next process fetches whole again */}
  note({ok:true,status:200,bytes:body.length,etag:got.etag??null});
  return got.catalog;
}

const CAP=20,TICK_MS=10_000,WAIT_CEILING_MS=10*60_000,WAIT_LINE_MS=90_000;
const DONE=new Set(['done','complete','completed','finished','delivered']);
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const held=(rows:{item_id:string;quantity:number}[],item:string)=>
  rows.filter(row=>row.item_id===item).reduce((sum,row)=>sum+row.quantity,0);
// Ref'd: the awaited sleep IS the work in flight (see hunting.ts).
const sleep=(ms:number)=>new Promise<void>(resolve=>{setTimeout(resolve,ms);});
const list=(rows:{item_id:string;quantity:number}[])=>rows.map(row=>`${row.quantity} ${row.item_id}`).join(', ');

/** Docked, and — unless a facility is named — at a base whose services include crafting. Both
 * halves are the pilot's answer: "there is no bench here" is what it needs to hear, not a
 * failure. A named facility is the server's to accept or refuse in the dry run. */
async function bench(fn:string,at?:string):Promise<{base:string}|{refused:string}> {
  const docked=acct().state.location?.docked_at;
  if(!docked)return {refused:`${fn} happens at a bench and the ship is not docked`};
  if(at&&at!=='workshop')return {base:docked};
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

/** Where a craft runs: `'workshop'` is the workshop's preset (a facility id for it is
 * refused), any other string is a facility id here, and nothing leaves it to the server. */
const call=(recipeId:string,quantity:number,at?:string)=>
  ({id:recipeId,quantity,source:'storage',deliver_to:'storage',
    ...at===undefined?{}:at==='workshop'?{preset:'workshop'}:{facility_id:at}});

/** The server's own dry run: consumes nothing, queues nothing. A bench that cannot run the
 * recipe answers with an error whose text already names the facility it wants — that text IS
 * the answer, so it comes back as a refusal rather than a throw. */
async function dryRun(recipeId:string,quantity:number,at?:string):Promise<CraftQuoteResponse|{refused:string}> {
  try {return details(await command('spacemolt/craft',{...call(recipeId,quantity,at),dry_run:true})) as CraftQuoteResponse;}
  catch(error){return {refused:message(error)};}
}

/** The pilot's queued bench jobs: `craft` with no recipe named is the queue read. */
async function queue():Promise<JobView[]> {
  const reply=details(await command('spacemolt/craft',{}));
  return (Array.isArray(reply.jobs)?reply.jobs:[]) as JobView[];
}

/** A quote's `produces` is per run; `cost` and `credits_total` are for all of them. */
const allRuns=(q:{produces?:ItemQuantity[];runs?:number}):ItemQuantity[]=>
  (q.produces??[]).map(row=>({...row,quantity:row.quantity*(Number(q.runs)||1)}));

/** Where the quote says it runs and what it charges beyond the inputs. No fee at your own
 * facility and nothing at all at the workshop, so absent reads as 0. */
export interface Venue {venue:string;venue_type:string;facility_id?:string;labor:number;fee:number}
const venueOf=(q:CraftQuoteResponse):Venue=>({venue:String(q.venue??''),venue_type:String(q.venue_type??''),
  ...q.facility_id?{facility_id:q.facility_id}:{},labor:Number(q.cost?.labor??0),fee:Number(q.cost?.fee??0)});
const where=(v:Venue)=>`${v.venue||v.venue_type||'the bench'} (labour ${v.labor} + fee ${v.fee} cr)`;

/** The market's own estimate for `quantity` of an item, the buy fee included — `null` when
 * nothing is on offer or the command throws. Reads only. */
async function estimate(item:string,quantity:number):Promise<EstimatePurchaseResponse|null> {
  try {
    const est=details(await command('spacemolt_market/estimate_purchase',{item_id:item,quantity})) as EstimatePurchaseResponse;
    return est.available>0?est:null;
  } catch {return null;}
}
/** How each item enters the economy, from the catalog; `'unknown'` for every item when the
 * catalog cannot be read, which is no reason to fail a quote. */
async function sources():Promise<(item:string)=>string> {
  try {const graph=RecipeGraph.from(await catalog());return item=>graph.source(item);}
  catch {return ()=>'unknown';}
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
      const value=worth(allRuns(quote),listed);
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

/** An input the store is short of, with both sides of mine-or-buy. */
export interface Missing {
  item_id:string;need:number;have:number;
  /** What one costs on this market for the `need − have` you lack, the buy fee included;
   * `null` when this market does not sell it — mine it. */
  buy_each:number|null;
  /** This book's `best_buy`: what one of your own would fetch sold here instead of used;
   * `null` when nobody here buys it. */
  sell_each:number|null;
  /** How it enters the economy: `mining`, `gas`, …, `crafted`, or `unknown`. */
  source:string;
}

/** One recipe's full cost against what it is worth here. */
export type Quoted=CraftQuoteResponse&Venue&{
  /** `produces` is per run; this is per run × `runs`, what the whole order makes. */
  produces_total:ItemQuantity[];
  /** `produces_total` at this base's top buy level, or `null` when this base has no buyer
   * for one of them. */
  output_value:number|null;
  /** `output_value` less `credits_total`. Positive is worth crafting here; `null` means
   * unknown here, not zero — `spreads()` says which base buys the output. */
  margin:number|null;
  /** Inputs this base's store is short of, each priced to buy and to sell here. */
  missing:Missing[];
};

/** A dry-run quote for one recipe at this base's workshop, or wherever `at` names: the venue,
 * the escrow (inputs, labour, fee), `credits_total`, `est_completion_tick`,
 * `have_inputs`/`have_credits`/`have_capacity`, plus what the whole order fetches here and
 * the inputs the store is short of, each priced to buy and to sell. Nothing is committed.
 * `next` names the buy or the mining that would close the gap. */
export function quote(recipeId:string,quantity=1,opts:{at?:'workshop'|string}={}):Promise<Outcome<Quoted>> {
  return job<Quoted>('quote',`${quantity} × ${recipeId}${opts.at?` at ${opts.at}`:''}`,async()=>{
    const none={} as Quoted;
    if(!Number.isInteger(quantity)||quantity<1)
      return {status:'refused',did:`did not quote ${recipeId}`,why:'quantity must be a whole number of output units, at least one',detail:none};
    const bay=await bench('quote',opts.at);
    if('refused' in bay)return {status:'refused',did:`did not quote ${recipeId}`,why:bay.refused,detail:none};
    const quoted=await dryRun(recipeId,quantity,opts.at);
    if('refused' in quoted)return {status:'refused',did:`did not quote ${recipeId}`,why:quoted.refused,detail:none};

    const store=await storeRows();
    const listed=await book();
    const short=(quoted.cost?.inputs??[]).map(inp=>({item_id:inp.item_id,need:inp.quantity,have:held(store,inp.item_id)}))
      .filter(row=>row.have<row.need);
    const sourceOf=short.length?await sources():()=>'unknown';
    const missing:Missing[]=[];
    for(const row of short) {
      const est=await estimate(row.item_id,row.need-row.have);
      const filled=est?Math.max(1,row.need-row.have-Number(est.unfilled??0)):1;
      const bid=listed.get(row.item_id)?.best_buy;
      missing.push({...row,buy_each:est?Math.round(Number(est.total_cost)/filled*100)/100:null,
        sell_each:bid&&bid>0?bid:null,source:sourceOf(row.item_id)});
    }
    const produces_total=allRuns(quoted);
    const valued=worth(produces_total,listed);
    const output_value=valued===null?null:Math.round(valued);
    const venue=venueOf(quoted);
    const detail:Quoted={...quoted,...venue,produces_total,output_value,
      margin:output_value===null?null:output_value-Number(quoted.credits_total??0),missing};
    const atArg=opts.at?`, {at:'${opts.at}'}`:'';
    return {status:'done',
      did:`${quoted.recipe}: ${quoted.runs} run${quoted.runs===1?'':'s'} at ${where(venue)}, ${quoted.credits_total} cr in all, makes ${list(produces_total)||'nothing'}`
        +(output_value===null?`, no buyer here for their outputs; see spreads()`
          :`, worth ${output_value} cr here — margin ${detail.margin} cr`),
      detail,
      next:[...output_value===null?[`spreads(${JSON.stringify(outputsOf([{outputs:produces_total}]))}) — which base buys it`]:[],
      ...missing.map(row=>`${row.item_id}: store has ${row.have} of ${row.need}; `
        +(row.buy_each===null?`not sold here — materials('${row.item_id}', ${row.need-row.have}) names what to mine (${row.source})`
          :`buys at ${row.buy_each} cr each${row.sell_each===null?'':`, sells at ${row.sell_each}`}; supply('${recipeId}', ${quantity}${atArg}) buys it`)),
      ...(detail.margin??0)>0&&!missing.length?[`craft('${recipeId}', ${quantity}${atArg})`]:[]].slice(0,3)};
  });
}

export interface Supplied {
  /** Moved from the hold into this base's store, measured from the hold. */
  stowed:Row[];
  /** Bought into this base's store, as each buy reported it. */
  bought:Row[];
  /** Inputs the store is still short of after all that, read from the store. */
  short:{item_id:string;have:number;need:number;source:string}[];
  /** Credits the buys actually cost, wallet before vs after (fee-inclusive; `total_cost` alone
   * is the pre-tax subtotal). */
  spent:number;
}

/** This base's store holds every input `quantity` of a recipe escrows — at the workshop or
 * wherever `at` names, since that decides the inputs.
 *
 * Reads the dry run and the store; an input already stocked is left alone, so a stocked store
 * is `done` with nothing sent. The rest is stowed from the hold first, then bought into the
 * store at this market. The whole bill is estimated (buy fee included) before anything moves:
 * over `maxSpend`, it is refused with nothing stowed or bought. An input this market does not
 * sell comes back in `short` with its `source`, and the status is `partial`. Each buy keeps
 * `credits − permissions.credit_reserve`. */
export function supply(recipeId:string,quantity=1,opts:{at?:'workshop'|string;maxSpend?:number}={}):Promise<Outcome<Supplied>> {
  return job<Supplied>('supply',`${quantity} × ${recipeId}${opts.at?` at ${opts.at}`:''}`,async()=>{
    const none:Supplied={stowed:[],bought:[],short:[],spent:0};
    const refuse=(why:string,next:string[]=[])=>({status:'refused' as const,did:`supplied no ${recipeId}`,why,detail:none,next});
    const blocked=await admit('supply');
    if(blocked)return refuse(blocked);
    if(!Number.isInteger(quantity)||quantity<1)
      return refuse('quantity must be a whole number of output units, at least one');
    const bay=await bench('supply',opts.at);
    if('refused' in bay)return refuse(bay.refused);
    const quoted=await dryRun(recipeId,quantity,opts.at);
    if('refused' in quoted)return refuse(quoted.refused);
    const name=quoted.recipe||recipeId;
    const needs=quoted.cost?.inputs??[];
    const gap=(store:Row[])=>needs.map(inp=>({item_id:inp.item_id,need:inp.quantity,have:held(store,inp.item_id)}))
      .filter(row=>row.have<row.need);

    const open=gap(await storeRows());
    if(!open.length)return {status:'done',did:`${bay.base}'s store already holds every input for ${quoted.runs} run(s) of ${name}`,detail:none};

    // The plan before any move: the hold covers what it can, the market is asked for the rest.
    const aboard=miningInventory(acct().state);
    const bring=open.map(row=>({item_id:row.item_id,quantity:Math.min(aboard[row.item_id]??0,row.need-row.have)}))
      .filter(row=>row.quantity>0);
    const rest=open.map(row=>({item_id:row.item_id,
      quantity:row.need-row.have-(bring.find(b=>b.item_id===row.item_id)?.quantity??0)})).filter(row=>row.quantity>0);
    const offers:{item_id:string;quantity:number;cost:number}[]=[];
    for(const row of rest) {
      const est=await estimate(row.item_id,row.quantity);
      if(est)offers.push({...row,cost:Number(est.total_cost??0)});
    }
    const bill=offers.reduce((sum,row)=>sum+row.cost,0);
    if(opts.maxSpend!==undefined&&bill>opts.maxSpend)
      return refuse(`buying ${list(offers)} for ${name} costs ${bill} cr, over maxSpend ${opts.maxSpend}`,
        [`quote('${recipeId}', ${quantity}) prices each input to buy and to sell`]);

    let stowed:Row[]=[];
    if(bring.length) {
      step(`stowing what the hold carries: ${list(bring)}`);
      stowed=(await stow(bring)).detail.moved??[];
    }
    const bought:Row[]=[],whys:string[]=[];
    let spent=0;
    for(const row of offers) {
      const got=await buy(row.item_id,row.quantity,{deliverTo:'storage'});
      if(got.detail.bought) {
        bought.push({item_id:row.item_id,quantity:Number(got.detail.bought.quantity??row.quantity)});
        // The wallet, not `total_cost`: the reply's cost is the subtotal, and the tax is on top
        // (see market.ts's `buy`); `cost.credits` is what the runtime measured actually left.
        spent+=got.cost.credits;
      }
      if(got.status!=='done')whys.push(`${row.item_id}: ${got.why}`);
    }

    const sourceOf=await sources();
    const short=gap(await storeRows()).map(row=>({...row,source:sourceOf(row.item_id)}));
    const detail={stowed,bought,short,spent};
    const did=`${name}: `+[stowed.length?`stowed ${list(stowed)}`:'',bought.length?`bought ${list(bought)} for ${spent} cr`:'']
      .filter(Boolean).join(', ')+(short.length?'':`; ${bay.base}'s store holds every input`);
    if(!short.length)return {status:'done',did,detail,next:[`craft('${recipeId}', ${quantity}${opts.at?`, {at:'${opts.at}'}`:''})`]};
    return {status:'partial',did:did.replace(/: $/,': nothing moved'),
      why:[`still short ${short.map(row=>`${row.item_id} ${row.have} of ${row.need} (${row.source})`).join(', ')}`,...whys].join('; '),
      detail,next:short.slice(0,3).map(row=>`materials('${row.item_id}', ${row.need-row.have}) names what to mine for it`)};
  });
}

export interface Crafted extends Venue {
  /** The commit, or the queue row this run re-entered on. */
  job:CraftJobResponse|JobView;
  /** What landed in the store, measured from `storage/view` before and after. */
  made:Row[];
}

/** Quote, stock the store, commit the escrow, wait out the queue, confirm the outputs landed
 * in this base's store. `at` is where it runs: `'workshop'`, a facility id from
 * `facilities().here`, or omitted for the server's choice.
 *
 * Preconditions, all before anything is committed: docked at a base with a workshop (or at
 * the named facility's base); the inputs in this base's store, with anything the hold carries
 * stowed into it by name first; the escrow inside `credits − permissions.credit_reserve`.
 * Refused, naming the shortfall, when any of them does not hold.
 *
 * A job already queued here for this recipe and this many runs IS this job: the run re-enters
 * at the wait and escrows nothing twice, so a re-run after a restart is safe. The wait streams
 * a line at least every 90 seconds and gives up after 10 minutes with `partial` and the job.
 * Tired mid-wait keeps waiting — the ship is docked — but `craft` will not start while Tired.
 *
 * At the workshop it trains crafting, and engineering for components and modules; a facility
 * trains nothing. */
export function craft(recipeId:string,quantity=1,opts:{at?:'workshop'|string}={}):Promise<Outcome<Crafted>> {
  return job<Crafted>('craft',`${quantity} × ${recipeId}${opts.at?` at ${opts.at}`:''}`,async()=>{
    const none:Crafted={job:{} as CraftJobResponse,made:[],venue:'',venue_type:'',labor:0,fee:0};
    const refuse=(why:string,next:string[]=[])=>({status:'refused' as const,did:`crafted no ${recipeId}`,why,detail:none,next});
    const blocked=await admit('craft');
    if(blocked)return refuse(blocked);
    if(!Number.isInteger(quantity)||quantity<1)
      return refuse('quantity must be a whole number of output units, at least one');
    const at=await bench('craft',opts.at);
    if('refused' in at)return refuse(at.refused,['goTo a base whose services include crafting']);

    let quoted=await dryRun(recipeId,quantity,opts.at);
    if('refused' in quoted)return refuse(quoted.refused);
    const name=quoted.recipe||recipeId;

    // The escrow this run may already have made is the job sitting in the queue: same recipe,
    // same runs, this base. A different run count is a different order.
    const mine=(await queue()).filter(row=>String(row.base_id??at.base)===at.base),runs=Number(quoted.runs);
    let running=mine.find(row=>row.recipe===name&&Number(row.runs_total)===runs);
    let before=await storeRows();

    if(!running) {
      // The bench escrows from the store; what the hold carries has to be stowed first.
      if(quoted.have_inputs===false) {
        const short=(quoted.cost?.inputs??[]).filter(inp=>held(before,inp.item_id)<inp.quantity);
        const aboard=miningInventory(acct().state);
        const bring=short.filter(inp=>(aboard[inp.item_id]??0)>0)
          .map(inp=>({item_id:inp.item_id,quantity:Math.min(aboard[inp.item_id]!,inp.quantity-held(before,inp.item_id))}));
        if(bring.length) {
          step(`stowing the inputs the bench escrows from the store: ${list(bring)}`);
          await stow(bring);
          before=await storeRows();
          const again=await dryRun(recipeId,quantity,opts.at);
          if('refused' in again)return refuse(again.refused);
          quoted=again;
        }
      }
      if(quoted.have_inputs===false) {
        const short=(quoted.cost?.inputs??[]).map(inp=>({...inp,have:held(before,inp.item_id)}))
          .filter(inp=>inp.have<inp.quantity);
        return refuse(`${name} is short at ${at.base}: ${short.map(row=>`${row.item_id} ${row.have} of ${row.quantity}`).join(', ')||'the inputs it escrows'}`,
          [`supply('${recipeId}', ${quantity}) buys what this market sells; quote() prices each input`]);
      }
      const cost=Number(quoted.credits_total??0);
      const credits=acct().state.player?.credits??0;
      const reserve=pilot().permissions?.credit_reserve??0;
      if(quoted.have_credits===false||credits-cost<reserve)
        return refuse(`${name} costs ${cost} cr; ${credits} less the ${reserve} credit reserve cannot cover it`);
      if(quoted.have_capacity===false)
        return refuse(`${at.base}'s store has no room for ${name}'s output`);
      step(`quote ${name}: ${quoted.runs} run(s) at ${where(venueOf(quoted))}, ${cost} cr, done by tick ${quoted.est_completion_tick}`);

      try {running=details(await command('spacemolt/craft',call(recipeId,quantity,opts.at))) as unknown as JobView;}
      catch(error){return {status:'failed',did:`crafted no ${recipeId}`,why:`${name} was not queued at ${at.base}: ${message(error)}`,detail:none};}
      step(`committed ${name} as job ${running.job_id}`);
    } else step(`job ${running.job_id} for ${name} is already queued here; re-entering at the wait`);

    const venue=venueOf(quoted);
    const job_id=String(running.job_id??'');
    const produces=allRuns(quoted);
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
          why:`the bench did not deliver inside ${WAIT_CEILING_MS/60_000} minutes`,detail:{...venue,job:running,made:[]},
          next:[`craft('${recipeId}', ${quantity}${opts.at?`, {at:'${opts.at}'}`:''}) again re-enters at the wait for job ${job_id}`]};
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
        detail:{...venue,job:running,made:[]}};
    return {status:'done',
      did:`${name}: ${list(made)} in ${at.base}'s store, made at ${where(venue)}`,
      detail:{...venue,job:running,made},
      next:[`prices([${made.map(row=>`'${row.item_id}'`).join(', ')}]) then sell(made, {from:'store'})`]};
  });
}

/** A queued job as `jobs()` reports it. */
export interface Queued {
  job_id:string;
  /** The recipe's display name, as the queue names it. */
  recipe:string;
  base_id?:string;
  venue_type?:string;
  /** `queued` or `active`; a finished job leaves the queue rather than changing status. */
  status:string;
  runs_done:number;
  runs_total:number;
  /** A workshop job at a base the ship is not docked at: it does not advance until you dock
   * there again. Facility jobs run while you fly. */
  paused:boolean;
}

/** Every job this pilot has queued, at every base, and which of them are paused because the
 * ship is not docked there. Works undocked. Reads only. */
export function jobs():Promise<Outcome<{jobs:Queued[]}>> {
  return job<{jobs:Queued[]}>('jobs','',async()=>{
    const docked=acct().state.location?.docked_at??null;
    const rows:Queued[]=(await queue()).map(row=>{
      const venue_type=(row as JobView&{venue_type?:string}).venue_type;
      // `JobView` types `venue`, not `venue_type`; a live queue row may carry either (or
      // neither, if it's stale). Try both spellings before falling back to `facility_id`.
      const workshop=venue_type?venue_type==='workshop':row.venue?/workshop/i.test(row.venue):!row.facility_id;
      return {job_id:String(row.job_id),recipe:String(row.recipe),...row.base_id?{base_id:row.base_id}:{},
        ...venue_type?{venue_type}:{},status:String(row.status),runs_done:Number(row.runs_done??0),
        runs_total:Number(row.runs_total??0),paused:workshop&&(row.base_id?row.base_id!==docked:!docked)};
    });
    const paused=rows.filter(row=>row.paused);
    return {status:'done',
      did:`${rows.length} job${rows.length===1?'':'s'} queued`
        +(rows.length?`: ${rows.map(row=>`${row.recipe} ${row.runs_done}/${row.runs_total} ${row.status}`).join(', ')}`:'')
        +(paused.length?`; ${paused.length} paused until you dock at ${[...new Set(paused.map(row=>row.base_id??'its base'))].join(', ')}`:''),
      detail:{jobs:rows},
      next:paused.slice(0,3).map(row=>`${row.recipe} is a workshop job at ${row.base_id??'its base'}: goTo there and stay docked to finish it`)};
  });
}

/** What one recipe tree comes to, from the catalog. */
export interface Materials {
  /** The recipes to run, in the order to run them (deepest first), each with its runs. */
  steps:{recipe:string;runs:number;facility_only:boolean}[];
  /** The raw items at the bottom, all of each the tree consumes, beside what the hold and this
   * base's store hold of it. */
  leaves:{item_id:string;need:number;have:number;source:string}[];
}

/** Everything `quantity` of `itemId` takes, down to raw leaves, net of what the hold and — when
 * docked — this base's store already hold of each intermediate. From the catalog: reads only,
 * works undocked, needs no bench. `failed` when the catalog cannot be read. */
export function materials(itemId:string,quantity:number):Promise<Outcome<Materials>> {
  return job<Materials>('materials',`${quantity} ${itemId}`,async()=>{
    const none:Materials={steps:[],leaves:[]};
    if(!Number.isInteger(quantity)||quantity<1)
      return {status:'refused',did:`walked no tree for ${itemId}`,why:'quantity must be a whole number of output units, at least one',detail:none};
    let graph:RecipeGraph;
    try {graph=RecipeGraph.from(await catalog());}
    catch(error){return {status:'failed',did:`walked no tree for ${itemId}`,why:`catalog unavailable: ${message(error)}`,detail:none};}

    const have:Record<string,number>={...miningInventory(acct().state)};
    if(acct().state.location?.docked_at)for(const row of await storeRows())have[row.item_id]=(have[row.item_id]??0)+row.quantity;
    const pool={...have};
    const steps=new Map<string,Materials['steps'][number]>(),leaves=new Map<string,Materials['leaves'][number]>();
    // ponytail: the first hand-craftable recipe per item (else the first facility one), no
    // cost optimisation; a recipe reached twice rounds its runs up twice. Choose by margin
    // the day a pilot has two real routes to one item.
    const walk=(item:string,need:number,path:Set<string>)=>{
      const usable=graph.recipesFor(item).filter(r=>!r.hidden&&!r.package_operation&&r.category!=='Ship Passive');
      const recipe=graph.source(item)==='crafted'&&!path.has(item)?usable.find(r=>graph.isCraftable(r))??usable[0]:undefined;
      if(!recipe) {
        const leaf=leaves.get(item)??{item_id:item,need:0,have:have[item]??0,source:graph.source(item)};
        leaf.need+=need;leaves.set(item,leaf);return;
      }
      const used=Math.min(pool[item]??0,need);
      pool[item]=(pool[item]??0)-used;
      if(need-used<=0)return;
      const runs=Math.ceil((need-used)/(recipe.outputs?.find(out=>out.item_id===item)?.quantity||1));
      const row=steps.get(recipe.id)??{recipe:recipe.id,runs:0,facility_only:!graph.isCraftable(recipe)};
      row.runs+=runs;steps.set(recipe.id,row);
      const deeper=new Set([...path,item]);
      for(const inp of recipe.inputs??[])walk(inp.item_id,(inp.quantity??1)*runs,deeper);
    };
    walk(itemId,quantity,new Set());
    const detail={steps:[...steps.values()].reverse(),leaves:[...leaves.values()]};
    const lacking=detail.leaves.filter(row=>row.have<row.need);
    return {status:'done',
      did:`${quantity} ${itemId}: ${detail.steps.length} recipe${detail.steps.length===1?'':'s'}`
        +(detail.steps.length?` (${detail.steps.map(row=>`${row.runs} × ${row.recipe}`).join(', ')})`:'')
        +`, raw ${detail.leaves.map(row=>`${row.item_id} ${row.have}/${row.need}`).join(', ')||'nothing'}`,
      detail,
      next:lacking.slice(0,3).map(row=>`${row.item_id}: ${row.need-row.have} more to get (${row.source})`)};
  });
}
