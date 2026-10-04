/** The bench at the base you are docked at — its workshop, or a facility there named by id:
 * recipes, quotes, stocking the store, crafts, the queue, and what a recipe tree comes to.
 *
 * Every call here uses the one convention the live game answered to: `source:'storage'`,
 * `deliver_to:'storage'`. The bench escrows the inputs out of THIS base's store and delivers
 * the output back into it, so the store — not the hold — is what has to be stocked, and the
 * store's own delta before and after is the only evidence the output arrived.
 */
import {fetchCatalogConditional,type Catalog,type CraftJobResponse,type CraftQuoteResponse,type ItemQuantity,type JobView,
  type MarketListingItem,type Recipe,type RecipeInput} from '@spacemolt/lib';
import {Clock,Data,Effect,Option,Result,Schema,Struct} from 'effect';
import {mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {miningInventory} from '../../mining-inventory.ts';
import {RecipeGraph,type SourcedItem} from '../../recipe-graph.ts';
import {journalRun} from '../../run-record.ts';
import {words} from '../../servicing.ts';
import {replyBody} from '../../storage.ts';
import * as Wire from '../../wire.gen.ts';
import {Game,field,message,type GameError} from '../game.ts';
import {bookEffect,buyEffect} from '../market.ts';
import {kept,offSpec,told} from '../rows.ts';
import {Stopped,acct,admit,edge,jobEffect,pilot,reached,runtimeDir,step,stopped} from '../runtime.ts';
import {OffSpec,folded,stowEffect} from '../storage.ts';
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
/** What this file reads of the catalog: its version, the recipes (handed to the pilot whole, as `Craftable`), and each item's source. */
type Recipes=Pick<Catalog,'version'|'recipes'>&{items:readonly SourcedItem[]};
let source:()=>Promise<Recipes>=()=>revalidated(runtimeDir());
let cached:Promise<Recipes>|undefined;
/** Where the recipe catalog comes from. The tests pass a fixture; nothing else calls it. */
export function useCatalog(load:()=>Promise<Recipes>):void {source=load;cached=undefined;}
const catalog=()=>(cached??=source().catch(error=>{cached=undefined;throw error;}));

/** The catalog could not be read: no network and no copy on disk. A named value, said in the Outcome, never a defect. */
class CatalogUnavailable extends Data.TaggedError('CatalogUnavailable')<{readonly message:string}> {}
/** The recipe graph, or why there is none. The promise never rejects: a failed fetch is the typed failure. */
const graphOf=()=>Effect.promise(()=>catalog().then(
  loaded=>Result.succeed(RecipeGraph.from(loaded)),
  error=>Result.fail(new CatalogUnavailable({message:message(error)}))));

/** The disk copy is a file, so it is decoded: the ETag, and the catalog's version, recipes and item sources from the spec's schemas. */
const Copy=Schema.fromJsonString(Schema.Struct({etag:Schema.optionalKey(Schema.String),
  catalog:Schema.Struct({version:Wire.CatalogDump.fields.version,recipes:Schema.Array(Wire.Recipe),
    items:Schema.Array(Wire.Item.mapFields(Struct.pick(['id','extracted_by'])))})}));
const decodeCopy=Schema.decodeUnknownOption(Copy);
/** What a previous process kept at `path`: the ETag and the catalog beside it, or nothing when there is no copy. A copy that
 * does not decode reads as none, so the catalog is fetched whole, and the `fetch` line says `disk_unread` (plumbing, not the pilot's). */
function keptCopy(path:string|undefined):{etag?:string;catalog?:Recipes;unread?:true} {
  let text:string;
  try {text=readFileSync(path??'','utf8');} catch {return {};} // edge: no copy yet: fetch whole
  const copy=decodeCopy(text);
  if(Option.isNone(copy))return {unread:true};
  const {etag,catalog:{version,recipes,items}}=copy.value;
  return {...etag===undefined?{}:{etag},catalog:{version,items,
    recipes:recipes.map(row=>({...row,inputs:[...row.inputs],outputs:[...row.outputs]}))}};
}

/** The catalog kept in `dir` beside its ETag, so a fresh process pays a ~0-byte 304 rather than
 * the multi-MB body when nothing changed, and a failed fetch falls back to the copy on disk.
 * One `fetch` line each time: status, ms, bytes stored, whether the disk copy answered. */
export async function revalidated(dir:string|undefined,
  load:typeof fetchCatalogConditional=fetchCatalogConditional):Promise<Recipes> {
  const path=dir?join(dir,CATALOG_FILE):undefined,since=Date.now();
  const copy=path?keptCopy(path):{};
  const note=(entry:Record<string,unknown>)=>{if(dir)journalRun(dir,{url:'/api/catalog.json',ms:Date.now()-since,
    ...copy.unread?{disk_unread:true}:{},...entry},'fetch');};
  let got:Awaited<ReturnType<typeof fetchCatalogConditional>>;
  try {got=await load(CATALOG_URL,copy.catalog?copy.etag:undefined);}
  catch(error) { // edge: the fetch is HTTP, not the game; a failed one answers from the disk copy, else rethrows
    note({ok:false,error:message(error).slice(0,200),...copy.catalog?{from_disk:true}:{}});
    if(copy.catalog)return copy.catalog;
    throw error;
  }
  if(got.notModified&&copy.catalog) {note({ok:true,status:304,from_disk:true});return copy.catalog;}
  if(!got.catalog)throw new Error('catalog fetch returned no catalog');
  const body=JSON.stringify({etag:got.etag,catalog:got.catalog});
  if(path&&dir)try {
    mkdirSync(dir,{recursive:true});
    const temp=`${path}.${process.pid}.tmp`;
    writeFileSync(temp,body,{mode:0o600});
    renameSync(temp,path);
  } catch {/* unwritten: the next process fetches whole again */} // edge: the copy is a convenience; the file may be unwritable
  note({ok:true,status:200,bytes:body.length,etag:got.etag??null});
  return got.catalog;
}

const CAP=20,TICK_MS=10_000,WAIT_CEILING_MS=10*60_000,WAIT_LINE_MS=90_000;
const DONE=new Set(['done','complete','completed','finished','delivered']);
const held=(rows:readonly {item_id:string;quantity:number}[],item:string)=>
  rows.filter(row=>row.item_id===item).reduce((sum,row)=>sum+row.quantity,0);
const list=(rows:readonly {item_id:string;quantity:number}[])=>rows.map(row=>`${row.quantity} ${row.item_id}`).join(', ');
/** A failure of a read in its own words: the game's, or a reply that did not read. */
const said=(error:GameError|OffSpec)=>error instanceof OffSpec?`${error.action}: reply off spec — ${error.message}`:words(error);

// The frozen surface promises the lib's reply types; the live body is decoded only for the fields read below, because the server omits spec fields.
// oxlint-disable-next-line typescript/consistent-type-assertions
const asQuote=(body:unknown)=>body as CraftQuoteResponse; // cast: frozen surface (CraftQuoteResponse)
// oxlint-disable-next-line typescript/consistent-type-assertions
const asCommit=(body:unknown)=>body as CraftJobResponse; // cast: frozen surface (CraftJobResponse)
// oxlint-disable-next-line typescript/consistent-type-assertions
const asJob=(body:unknown)=>body as JobView; // cast: frozen surface (JobView)

/** Only what this file reads of a reply, picked from the spec's own schema: the live server is looser than its spec. A collection
 * it sends as `null` when empty reads as none. */
const Rows=Wire.ItemQuantity_3.mapFields(Struct.pick(['item_id','quantity']));
const Quote=Wire.CraftQuoteResponse.mapFields(fields=>({
  recipe:Schema.optionalKey(fields.recipe),runs:Schema.optionalKey(fields.runs),credits_total:Schema.optionalKey(fields.credits_total),
  est_completion_tick:Schema.optionalKey(fields.est_completion_tick),venue:Schema.optionalKey(fields.venue),
  venue_type:Schema.optionalKey(fields.venue_type),facility_id:Schema.optionalKey(fields.facility_id),
  have_inputs:Schema.optionalKey(fields.have_inputs),have_credits:Schema.optionalKey(fields.have_credits),have_capacity:fields.have_capacity,
  produces:Schema.optionalKey(Schema.NullOr(Schema.Array(Wire.ItemQuantity_3.mapFields(row=>({item_id:row.item_id,quantity:row.quantity,
    name:Schema.optionalKey(row.name)}))))),
  cost:Schema.optionalKey(Schema.Struct({inputs:Schema.optionalKey(Schema.NullOr(Schema.Array(Rows))),
    labor:fields.cost.fields.labor,fee:fields.cost.fields.fee}))}));
const decodeQuote=Schema.decodeUnknownEffect(Quote);
type Quoting=typeof Quote.Type;
/** A queue row (`craft` with no recipe): the id, recipe and status are what makes it a job at all. */
const Job=Wire.JobView.mapFields(fields=>({job_id:fields.job_id,recipe:fields.recipe,status:fields.status,base_id:fields.base_id,
  venue:fields.venue,facility_id:Schema.optionalKey(fields.facility_id),venue_type:Schema.optionalKey(Schema.String),
  eta_ticks:Schema.optionalKey(fields.eta_ticks),runs_done:Schema.optionalKey(fields.runs_done),runs_total:Schema.optionalKey(fields.runs_total)}));
const decodeJob=Schema.decodeUnknownOption(Job);
const Committed=Wire.JobView.mapFields(fields=>({job_id:Schema.optionalKey(fields.job_id),eta_ticks:Schema.optionalKey(fields.eta_ticks)}));
const decodeCommitted=Schema.decodeUnknownOption(Committed);
const Estimate=Wire.EstimatePurchaseResponse.mapFields(fields=>({available:fields.available,
  total_cost:Schema.optionalKey(fields.total_cost),unfilled:Schema.optionalKey(fields.unfilled)}));
const decodeEstimate=Schema.decodeUnknownOption(Estimate);
const decodeStored=Schema.decodeUnknownOption(Wire.CargoItem_14.schema.mapFields(Struct.pick(['item_id','quantity'])));

/** The rows of a reply's list whose read fields decode, typed; a row that does not is left out and said (`kept`). */
const read=<A>(action:string,key:string,rows:unknown,decode:(row:unknown)=>Option.Option<A>,name:(row:unknown)=>unknown):A[]=>
  kept(action,key,rows,decode,name).flatMap(row=>Option.toArray(decode(row)));

/** Docked, and — unless a facility is named — at a base whose services include crafting. Both
 * halves are the pilot's answer: "there is no bench here" is what it needs to hear, not a
 * failure. A named facility is the server's to accept or refuse in the dry run. */
const bench=(fn:string,at?:string)=>Effect.gen(function*() {
  const docked=acct().state.location?.docked_at;
  if(!docked)return {refused:`${fn} happens at a bench and the ship is not docked`};
  if(at&&at!=='workshop')return {base:docked};
  const listed=field(replyBody(yield* (yield* Game).command('spacemolt/get_base',{})),'services');
  const services=(Array.isArray(listed)?listed:[]).map(String);
  if(!services.includes('crafting'))
    return {refused:`no workshop at ${docked}: its services are ${services.join(', ')||'none'}`};
  return {base:docked};
});

/** This base's store, item rows only. */
const storeRows=()=>Effect.gen(function*() {
  const body=replyBody(yield* (yield* Game).command('spacemolt_storage/view',{}));
  return read('spacemolt_storage/view','items',field(body,'items'),decodeStored,row=>field(row,'item_id'));
});

/** Where a craft runs: `'workshop'` is the workshop's preset (a facility id for it is
 * refused), any other string is a facility id here, and nothing leaves it to the server. */
const call=(recipeId:string,quantity:number,at?:string)=>
  ({id:recipeId,quantity,source:'storage',deliver_to:'storage',
    ...at===undefined?{}:at==='workshop'?{preset:'workshop'}:{facility_id:at}});

/** The server's own dry run: consumes nothing, queues nothing. A bench that cannot run the
 * recipe answers with an error whose text already names the facility it wants — that text IS
 * the answer, so it comes back as a refusal, with the server's code. A lost reply is the caller's: a read, but not reissued. */
const dryRun=(recipeId:string,quantity:number,at?:string)=>Effect.gen(function*() {
  const sent=yield* Effect.result((yield* Game).command('spacemolt/craft',{...call(recipeId,quantity,at),dry_run:true}));
  if(Result.isFailure(sent))return sent.failure._tag==='ReplyLost'?yield* sent.failure:{refused:told(sent.failure)};
  const body=replyBody(sent.success);
  return {quote:yield* decodeQuote(body).pipe(Effect.mapError(offSpec('spacemolt/craft'))),raw:asQuote(body)};
});

/** The pilot's queued bench jobs: `craft` with no recipe named is the queue read. Each row beside the body the game sent. */
const queue=()=>Effect.gen(function*() {
  const body=replyBody(yield* (yield* Game).command('spacemolt/craft',{}));
  return read('spacemolt/craft','jobs',field(body,'jobs'),
    raw=>Option.map(decodeJob(raw),row=>({row,raw:asJob(raw)})),row=>field(row,'job_id'));
});

/** A quote's `produces` is per run; `cost` and `credits_total` are for all of them. */
const allRuns=(q:Pick<Quoting,'produces'|'runs'>):ItemQuantity[]=>
  (q.produces??[]).map(row=>({item_id:row.item_id,name:row.name??row.item_id,quantity:row.quantity*(q.runs||1)}));

/** Where the quote says it runs and what it charges beyond the inputs. No fee at your own
 * facility and nothing at all at the workshop, so absent reads as 0. */
export interface Venue {venue:string;venue_type:string;facility_id?:string;labor:number;fee:number}
const venueOf=(q:Quoting):Venue=>({venue:q.venue??'',venue_type:q.venue_type??'',
  ...q.facility_id?{facility_id:q.facility_id}:{},labor:q.cost?.labor??0,fee:q.cost?.fee??0});
const where=(v:Venue)=>`${v.venue||v.venue_type||'the bench'} (labour ${v.labor} + fee ${v.fee} cr)`;

/** The market's own estimate for `quantity` of an item, the buy fee included — `null` when
 * nothing is on offer, the game refuses, or the reply does not read; each is said, none is a failed job. Reads only. */
const estimate=(item:string,quantity:number)=>Effect.gen(function*() {
  const sent=yield* Effect.result((yield* Game).command('spacemolt_market/estimate_purchase',{item_id:item,quantity}));
  if(Result.isFailure(sent)){step(`no estimate for ${item}: ${words(sent.failure)}`);return null;}
  const est=decodeEstimate(replyBody(sent.success));
  if(Option.isNone(est)){step(`no estimate for ${item}: the reply did not read`);return null;}
  return est.value.available>0?est.value:null;
});
/** How each item enters the economy, from the catalog; `'unknown'` for every item when the
 * catalog cannot be read, which is no reason to fail a quote. */
const sources=()=>Effect.gen(function*() {
  const graph=yield* graphOf();
  return Result.isSuccess(graph)?(item:string)=>graph.success.source(item):()=>'unknown';
});

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

const noRecipes=():{recipes:Craftable[]}=>({recipes:[]});
/** What can be made here, right now, out of what this base's store and the hold hold between
 * them: every catalog recipe whose inputs are all covered, each one dry-run for its real fee
 * and labour and priced against this base's book (one market read), sorted by margin in
 * credits. Reads only — nothing is escrowed, bought or queued.
 *
 * `search` filters on recipe id, name, category or output item. Capped at 20 quoted rows;
 * `did` says how many covered recipes were cut. Refused when there is no bench here, which is
 * itself the answer: the ore is in the wrong place. */
export const recipesEffect=(search?:string)=>
  jobEffect<{recipes:Craftable[]}>('recipes',search??'',folded<{recipes:Craftable[]}>('recipes',noRecipes,Effect.gen(function*() {
    const at=yield* bench('recipes');
    if('refused' in at)return {status:'refused',did:'read no recipes',why:at.refused,detail:noRecipes(),
      next:['goTo a base whose services include crafting, then recipes() again']};
    const loaded=yield* graphOf();
    if(Result.isFailure(loaded))return {status:'failed',did:'read no recipes',why:`catalog unavailable: ${loaded.failure.message}`,detail:noRecipes()};

    const stock:Record<string,number>={...miningInventory(acct().state)};
    for(const row of yield* storeRows())stock[row.item_id]=(stock[row.item_id]??0)+row.quantity;
    const needle=(search??'').trim().toLowerCase();
    const covered=loaded.success.craftableWith(stock).filter(cov=>cov.complete)
      .filter(cov=>!needle||[cov.recipe.id,cov.recipe.name,cov.recipe.category,
        ...(cov.recipe.outputs??[]).map(out=>out.item_id)]
        .some(text=>String(text).toLowerCase().includes(needle)));

    const listed=yield* bookEffect();
    const made:Craftable[]=[];
    for(const cov of covered.slice(0,CAP)) {
      if(stopped())return yield* Effect.fail(new Stopped());
      const have=(cov.recipe.inputs??[]).map(inp=>({...inp,have:stock[inp.item_id]??0}));
      // A quote that is refused, lost or off spec leaves the row unpriced and says so: the listing is still the answer.
      const quoted=yield* Effect.result(dryRun(cov.recipe.id,1));
      if(Result.isFailure(quoted)||'refused' in quoted.success) {
        step(`recipes: no quote for ${cov.recipe.id}: ${Result.isFailure(quoted)?said(quoted.failure):quoted.success.refused}`);
        made.push({...cov.recipe,have});continue;
      }
      const {quote:priced}=quoted.success;
      const value=worth(allRuns(priced),listed);
      made.push({...cov.recipe,have,margin:value===null?null:Math.round(value-(priced.credits_total??0))});
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
  })));
export function recipes(search?:string):Promise<Outcome<{recipes:Craftable[]}>> {return edge(recipesEffect(search));}

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

const noQuoted=():Quoted=>({...asQuote({}),venue:'',venue_type:'',labor:0,fee:0,produces_total:[],output_value:null,margin:null,missing:[]});
/** A dry-run quote for one recipe at this base's workshop, or wherever `at` names: the venue,
 * the escrow (inputs, labour, fee), `credits_total`, `est_completion_tick`,
 * `have_inputs`/`have_credits`/`have_capacity`, plus what the whole order fetches here and
 * the inputs the store is short of, each priced to buy and to sell. Nothing is committed.
 * `next` names the buy or the mining that would close the gap. */
export const quoteEffect=(recipeId:string,quantity=1,opts:{at?:'workshop'|string}={})=>
  jobEffect<Quoted>('quote',`${quantity} × ${recipeId}${opts.at?` at ${opts.at}`:''}`,folded<Quoted>('quote',noQuoted,Effect.gen(function*() {
    const none=noQuoted();
    if(!Number.isInteger(quantity)||quantity<1)
      return {status:'refused',did:`did not quote ${recipeId}`,why:'quantity must be a whole number of output units, at least one',detail:none};
    const bay=yield* bench('quote',opts.at);
    if('refused' in bay)return {status:'refused',did:`did not quote ${recipeId}`,why:bay.refused,detail:none};
    const dry=yield* dryRun(recipeId,quantity,opts.at);
    if('refused' in dry)return {status:'refused',did:`did not quote ${recipeId}`,why:dry.refused,detail:none};
    const {quote:quoted,raw}=dry;

    const store=yield* storeRows();
    const listed=yield* bookEffect();
    const short=(quoted.cost?.inputs??[]).map(inp=>({item_id:inp.item_id,need:inp.quantity,have:held(store,inp.item_id)}))
      .filter(row=>row.have<row.need);
    const sourceOf=short.length?yield* sources():()=>'unknown';
    const missing:Missing[]=[];
    for(const row of short) {
      const est=yield* estimate(row.item_id,row.need-row.have);
      const filled=est?Math.max(1,row.need-row.have-(est.unfilled??0)):1;
      const bid=listed.get(row.item_id)?.best_buy;
      missing.push({...row,buy_each:est?Math.round((est.total_cost??0)/filled*100)/100:null,
        sell_each:bid&&bid>0?bid:null,source:sourceOf(row.item_id)});
    }
    const produces_total=allRuns(quoted);
    const valued=worth(produces_total,listed);
    const output_value=valued===null?null:Math.round(valued);
    const venue=venueOf(quoted);
    const detail:Quoted={...raw,...venue,produces_total,output_value,
      margin:output_value===null?null:output_value-(quoted.credits_total??0),missing};
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
  })));
export function quote(recipeId:string,quantity=1,opts:{at?:'workshop'|string}={}):Promise<Outcome<Quoted>> {return edge(quoteEffect(recipeId,quantity,opts));}

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

const noSupplied=():Supplied=>({stowed:[],bought:[],short:[],spent:0});
/** This base's store holds every input `quantity` of a recipe escrows — at the workshop or
 * wherever `at` names, since that decides the inputs.
 *
 * Reads the dry run and the store; an input already stocked is left alone, so a stocked store
 * is `done` with nothing sent. The rest is stowed from the hold first, then bought into the
 * store at this market. The whole bill is estimated (buy fee included) before anything moves:
 * over `maxSpend`, it is refused with nothing stowed or bought. An input this market does not
 * sell comes back in `short` with its `source`, and the status is `partial`. Each buy keeps
 * `credits − permissions.credit_reserve`. A buy or a stow whose reply is lost is never re-sent:
 * the store is re-read, and what it still lacks is `short`. */
export const supplyEffect=(recipeId:string,quantity=1,opts:{at?:'workshop'|string;maxSpend?:number}={})=>
  jobEffect<Supplied>('supply',`${quantity} × ${recipeId}${opts.at?` at ${opts.at}`:''}`,folded<Supplied>('supply',noSupplied,Effect.gen(function*() {
    const none=noSupplied();
    const refuse=(why:string,next:string[]=[])=>({status:'refused' as const,did:`supplied no ${recipeId}`,why,detail:none,next});
    const blocked=yield* admit('supply');
    if(blocked)return refuse(blocked);
    if(!Number.isInteger(quantity)||quantity<1)
      return refuse('quantity must be a whole number of output units, at least one');
    const bay=yield* bench('supply',opts.at);
    if('refused' in bay)return refuse(bay.refused);
    const dry=yield* dryRun(recipeId,quantity,opts.at);
    if('refused' in dry)return refuse(dry.refused);
    const quoted=dry.quote;
    const name=quoted.recipe||recipeId;
    const needs=quoted.cost?.inputs??[];
    const gap=(store:readonly Row[])=>needs.map(inp=>({item_id:inp.item_id,need:inp.quantity,have:held(store,inp.item_id)}))
      .filter(row=>row.have<row.need);

    const open=gap(yield* storeRows());
    if(!open.length)return {status:'done',did:`${bay.base}'s store already holds every input for ${quoted.runs} run(s) of ${name}`,detail:none};

    // The plan before any move: the hold covers what it can, the market is asked for the rest.
    const aboard=miningInventory(acct().state);
    const bring=open.map(row=>({item_id:row.item_id,quantity:Math.min(aboard[row.item_id]??0,row.need-row.have)}))
      .filter(row=>row.quantity>0);
    const rest=open.map(row=>({item_id:row.item_id,
      quantity:row.need-row.have-(bring.find(b=>b.item_id===row.item_id)?.quantity??0)})).filter(row=>row.quantity>0);
    const offers:{item_id:string;quantity:number;cost:number}[]=[];
    for(const row of rest) {
      const est=yield* estimate(row.item_id,row.quantity);
      if(est)offers.push({...row,cost:est.total_cost??0});
    }
    const bill=offers.reduce((sum,row)=>sum+row.cost,0);
    if(opts.maxSpend!==undefined&&bill>opts.maxSpend)
      return refuse(`buying ${list(offers)} for ${name} costs ${bill} cr, over maxSpend ${opts.maxSpend}`,
        [`quote('${recipeId}', ${quantity}${opts.at?`, {at:'${opts.at}'}`:''}) prices each input to buy and to sell`]);

    let stowed:Row[]=[];
    if(bring.length) {
      step(`stowing what the hold carries: ${list(bring)}`);
      stowed=reached(yield* stowEffect(bring))?.moved??[];
    }
    const bought:Row[]=[],whys:string[]=[];
    let spent=0;
    for(const row of offers) {
      if(stopped())return yield* Effect.fail(new Stopped());
      const got=yield* buyEffect(row.item_id,row.quantity,{deliverTo:'storage'});
      // The wallet, not `total_cost`: the reply's cost is the subtotal, and the tax is on top
      // (see market.ts's `buy`); `cost.credits` is what the runtime measured actually left, a lost reply's too.
      spent+=got.cost.credits;
      const filled=reached(got)?.bought;
      if(filled)bought.push({item_id:row.item_id,quantity:filled.quantity??row.quantity});
      if(got.status!=='done')whys.push(`${row.item_id}: ${got.why}`);
    }

    const sourceOf=yield* sources();
    const short=gap(yield* storeRows()).map(row=>({...row,source:sourceOf(row.item_id)}));
    const detail={stowed,bought,short,spent};
    const did=`${name}: `+[stowed.length?`stowed ${list(stowed)}`:'',bought.length?`bought ${list(bought)} for ${spent} cr`:'']
      .filter(Boolean).join(', ')+(short.length?'':`; ${bay.base}'s store holds every input`);
    if(!short.length)return {status:'done',did,detail,next:[`craft('${recipeId}', ${quantity}${opts.at?`, {at:'${opts.at}'}`:''})`]};
    return {status:'partial',did:did.replace(/: $/,': nothing moved'),
      why:[`still short ${short.map(row=>`${row.item_id} ${row.have} of ${row.need} (${row.source})`).join(', ')}`,...whys].join('; '),
      detail,next:short.slice(0,3).map(row=>`materials('${row.item_id}', ${row.need-row.have}) names what to mine for it`)};
  })));
export function supply(recipeId:string,quantity=1,opts:{at?:'workshop'|string;maxSpend?:number}={}):Promise<Outcome<Supplied>> {return edge(supplyEffect(recipeId,quantity,opts));}

export interface Crafted extends Venue {
  /** The commit, or the queue row this run re-entered on. */
  job:CraftJobResponse|JobView;
  /** What landed in the store, measured from `storage/view` before and after. */
  made:Row[];
}

const sellNext=(made:Row[])=>`prices([${made.map(row=>`'${row.item_id}'`).join(', ')}]) then sell(made, {from:'store'})`;
const noCrafted=():Crafted=>({job:asCommit({}),made:[],venue:'',venue_type:'',labor:0,fee:0});
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
 * A commit whose reply is lost is never re-sent: the queue and the store are re-read, and a craft
 * that may have landed is `partial`, never claimed `done`.
 *
 * At the workshop it trains crafting, and engineering for components and modules; a facility
 * trains nothing. */
export const craftEffect=(recipeId:string,quantity=1,opts:{at?:'workshop'|string}={})=>
  jobEffect<Crafted>('craft',`${quantity} × ${recipeId}${opts.at?` at ${opts.at}`:''}`,folded<Crafted>('craft',noCrafted,Effect.gen(function*() {
    const game=yield* Game;
    const none=noCrafted();
    const refuse=(why:string,next:string[]=[])=>({status:'refused' as const,did:`crafted no ${recipeId}`,why,detail:none,next});
    const blocked=yield* admit('craft');
    if(blocked)return refuse(blocked);
    if(!Number.isInteger(quantity)||quantity<1)
      return refuse('quantity must be a whole number of output units, at least one');
    const at=yield* bench('craft',opts.at);
    if('refused' in at)return refuse(at.refused,['goTo a base whose services include crafting']);

    let dry=yield* dryRun(recipeId,quantity,opts.at);
    if('refused' in dry)return refuse(dry.refused);
    let quoted=dry.quote;
    const name=quoted.recipe||recipeId;
    const again=`craft('${recipeId}', ${quantity}${opts.at?`, {at:'${opts.at}'}`:''})`;

    // The escrow this run may already have made is the job sitting in the queue: same recipe,
    // same runs, this base. A different run count is a different order.
    const sameOrder=<T extends {row:{base_id?:string;recipe:string;runs_total?:number}}>(rows:T[],runs:number|undefined):T|undefined=>
      rows.filter(({row})=>(row.base_id??at.base)===at.base)
        .find(({row})=>row.recipe===name&&(row.runs_total===undefined||row.runs_total===runs));
    let running:{job_id:string;eta?:number;raw:CraftJobResponse|JobView}|undefined;
    const queued=sameOrder(yield* queue(),quoted.runs);
    if(queued)running={job_id:queued.row.job_id,...queued.row.eta_ticks===undefined?{}:{eta:queued.row.eta_ticks},raw:queued.raw};
    let before=yield* storeRows();

    if(!running) {
      // The bench escrows from the store; what the hold carries has to be stowed first.
      if(quoted.have_inputs===false) {
        const short=(quoted.cost?.inputs??[]).filter(inp=>held(before,inp.item_id)<inp.quantity);
        const aboard=miningInventory(acct().state);
        const bring=short.filter(inp=>(aboard[inp.item_id]??0)>0)
          .map(inp=>({item_id:inp.item_id,quantity:Math.min(aboard[inp.item_id]??0,inp.quantity-held(before,inp.item_id))}));
        if(bring.length) {
          step(`stowing the inputs the bench escrows from the store: ${list(bring)}`);
          yield* stowEffect(bring);
          before=yield* storeRows();
          dry=yield* dryRun(recipeId,quantity,opts.at);
          if('refused' in dry)return refuse(dry.refused);
          quoted=dry.quote;
        }
      }
      if(quoted.have_inputs===false) {
        const short=(quoted.cost?.inputs??[]).map(inp=>({...inp,have:held(before,inp.item_id)}))
          .filter(inp=>inp.have<inp.quantity);
        return refuse(`${name} is short at ${at.base}: ${short.map(row=>`${row.item_id} ${row.have} of ${row.quantity}`).join(', ')||'the inputs it escrows'}`,
          [`supply('${recipeId}', ${quantity}) buys what this market sells; quote() prices each input`]);
      }
      const cost=quoted.credits_total??0;
      const credits=acct().state.player?.credits??0;
      const reserve=pilot().permissions?.credit_reserve??0;
      if(quoted.have_credits===false||credits-cost<reserve)
        return refuse(`${name} costs ${cost} cr; ${credits} less the ${reserve} credit reserve cannot cover it`);
      if(quoted.have_capacity===false)
        return refuse(`${at.base}'s store has no room for ${name}'s output`);
      step(`quote ${name}: ${quoted.runs} run(s) at ${where(venueOf(quoted))}, ${cost} cr, done by tick ${quoted.est_completion_tick}`);

      const sent=yield* Effect.result(game.command('spacemolt/craft',call(recipeId,quantity,opts.at)));
      if(Result.isFailure(sent)) {
        const error=sent.failure;
        // A refusal means nothing was queued, and says its code.
        if(error._tag!=='ReplyLost')return {status:'refused' as const,did:`crafted no ${recipeId}`,
          why:`${name} was not queued at ${at.base}: ${told(error)}`,detail:none};
        // The commit may have landed: never re-sent. The queue and the store say what is there, and what they cannot say is said as unknown.
        const seen=yield* Effect.result(queue());
        const landed=Result.isSuccess(seen)?sameOrder(seen.success,quoted.runs):undefined;
        if(!landed) {
          const stored=yield* Effect.result(storeRows());
          const arrived=Result.isSuccess(stored)?allRuns(quoted).map(row=>({item_id:row.item_id,quantity:held(stored.success,row.item_id)-held(before,row.item_id)})).filter(row=>row.quantity>0):[];
          // The output is in the store: the same evidence a finished wait trusts, so it is said as done.
          if(arrived.length)return {status:'done' as const,
            did:`${name}: ${list(arrived)} in ${at.base}'s store, made at ${where(venueOf(quoted))}; the commit's reply was lost and the store shows it landed`,
            detail:{...venueOf(quoted),job:asCommit({}),made:arrived},next:[sellNext(arrived)]};
          return {status:'partial' as const,did:`${name}: the craft's reply was lost at ${at.base}`,
            why:`reply lost on ${error.action}; ${Result.isFailure(seen)?'the queue could not be re-read':'the queue does not show the job'}`
              +`${Result.isFailure(stored)?', the store could not be re-read':', the store shows no output'}, so it may have landed`,
            detail:{...venueOf(quoted),job:asCommit({}),made:[]},
            next:[`jobs() lists the queue; ${again} re-enters at the wait for a job already queued, and escrows nothing twice`]};
        }
        step(`reply lost on ${error.action}, but the queue has job ${landed.row.job_id}; it landed`);
        running={job_id:landed.row.job_id,...landed.row.eta_ticks===undefined?{}:{eta:landed.row.eta_ticks},raw:landed.raw};
      } else {
        const body=replyBody(sent.success),commit=decodeCommitted(body);
        if(Option.isNone(commit))step(`spacemolt/craft: the commit's reply did not read; waiting on the queue for ${name}`);
        running={job_id:Option.isSome(commit)?commit.value.job_id??'':'',
          ...Option.isSome(commit)&&commit.value.eta_ticks!==undefined?{eta:commit.value.eta_ticks}:{},raw:asCommit(body)};
        step(`committed ${name} as job ${running.job_id}`);
      }
    } else step(`job ${running.job_id} for ${name} is already queued here; re-entering at the wait`);

    const venue=venueOf(quoted);
    const job=running;
    const produces=allRuns(quoted);
    // ponytail: the queue is polled. This lib version publishes no crafting event to listen
    // for; drop the poll for `onCraftingUpdate` the day the lib exposes one.
    const pause=Math.min(60_000,Math.max(250,(job.eta===undefined?1:Math.max(job.eta,0))*TICK_MS));
    const deadline=(yield* Clock.currentTimeMillis)+WAIT_CEILING_MS;
    let lastLine=yield* Clock.currentTimeMillis,status='queued';
    // The escrow is made: a queue or store that cannot be read from here on is said, and the craft is `partial`, never `failed`.
    const unseen=(did:string,why:string)=>({status:'partial' as const,did,why,detail:{...venue,job:job.raw,made:[]},
      next:[`${again} re-enters at the wait for job ${job.job_id}`]});
    for(;;) {
      if(stopped())return yield* Effect.fail(new Stopped());
      const seen=yield* Effect.result(queue());
      if(Result.isFailure(seen))
        return unseen(`${name} is queued at ${at.base} as job ${job.job_id}`,`the queue could not be read: ${words(seen.failure)}`);
      // A commit whose reply named no job is found as the same order, as a lost one is: a blank id matches no row.
      const row=(job.job_id?seen.success.find(current=>current.row.job_id===job.job_id):sameOrder(seen.success,quoted.runs))?.row;
      if(!row||DONE.has(row.status.toLowerCase()))break;
      status=row.status;
      const now=yield* Clock.currentTimeMillis;
      if(now>=deadline) {
        return {status:'partial',did:`${name} is still ${status} at ${at.base} as job ${job.job_id}`,
          why:`the bench did not deliver inside ${WAIT_CEILING_MS/60_000} minutes`,detail:{...venue,job:job.raw,made:[]},
          next:[`${again} again re-enters at the wait for job ${job.job_id}`]};
      }
      if(now-lastLine>=WAIT_LINE_MS) {
        lastLine=now;
        step(`waiting on job ${job.job_id}: ${status}, ${row.runs_done ?? 0} of ${row.runs_total ?? '?'} runs`);
      }
      yield* Effect.sleep(pause);
    }

    // The store is where the output was delivered, so the store's delta says it arrived. The
    // reply's claim is never the evidence.
    const stored=yield* Effect.result(storeRows());
    if(Result.isFailure(stored))
      return unseen(`${name} left the queue at ${at.base} as job ${job.job_id}`,`the store could not be read to see what arrived: ${words(stored.failure)}`);
    const after=stored.success;
    const made:Row[]=produces.map(row=>({item_id:row.item_id,quantity:held(after,row.item_id)-held(before,row.item_id)}))
      .filter(row=>row.quantity>0);
    if(!made.length)
      return {status:'failed',did:`crafted no ${recipeId}`,
        why:`${name} left the queue but ${at.base}'s store shows none of ${produces.map(row=>row.item_id).join(', ')||'the output'}`,
        detail:{...venue,job:job.raw,made:[]}};
    return {status:'done',
      did:`${name}: ${list(made)} in ${at.base}'s store, made at ${where(venue)}`,
      detail:{...venue,job:job.raw,made},
      next:[sellNext(made)]};
  })));
export function craft(recipeId:string,quantity=1,opts:{at?:'workshop'|string}={}):Promise<Outcome<Crafted>> {return edge(craftEffect(recipeId,quantity,opts));}

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
export const jobsEffect=()=>
  jobEffect<{jobs:Queued[]}>('jobs','',Effect.gen(function*() {
    const docked=acct().state.location?.docked_at??null;
    const rows:Queued[]=(yield* queue()).map(({row})=>{
      const venue_type=row.venue_type;
      // `JobView` types `venue`, not `venue_type`; a live queue row may carry either (or
      // neither, if it's stale). Try both spellings before falling back to `facility_id`.
      const workshop=venue_type?venue_type==='workshop':row.venue?/workshop/i.test(row.venue):!row.facility_id;
      return {job_id:row.job_id,recipe:row.recipe,...row.base_id?{base_id:row.base_id}:{},
        ...venue_type?{venue_type}:{},status:row.status,runs_done:row.runs_done??0,
        runs_total:row.runs_total??0,paused:workshop&&(row.base_id?row.base_id!==docked:!docked)};
    });
    const paused=rows.filter(row=>row.paused);
    return {status:'done',
      did:`${rows.length} job${rows.length===1?'':'s'} queued`
        +(rows.length?`: ${rows.map(row=>`${row.recipe} ${row.runs_done}/${row.runs_total} ${row.status}`).join(', ')}`:'')
        +(paused.length?`; ${paused.length} paused until you dock at ${[...new Set(paused.map(row=>row.base_id??'its base'))].join(', ')}`:''),
      detail:{jobs:rows},
      next:paused.slice(0,3).map(row=>`${row.recipe} is a workshop job at ${row.base_id??'its base'}: goTo there and stay docked to finish it`)};
  }));
export function jobs():Promise<Outcome<{jobs:Queued[]}>> {return edge(jobsEffect());}

/** What one recipe tree comes to, from the catalog. */
export interface Materials {
  /** The recipes to run, in the order to run them (deepest first), each with its runs. */
  steps:{recipe:string;runs:number;facility_only:boolean}[];
  /** The raw items at the bottom, all of each the tree consumes, beside what the hold and this
   * base's store hold of it. */
  leaves:{item_id:string;need:number;have:number;source:string}[];
}

const noMaterials=():Materials=>({steps:[],leaves:[]});
/** Everything `quantity` of `itemId` takes, down to raw leaves, net of what the hold and — when
 * docked — this base's store already hold of each intermediate. From the catalog: reads only,
 * works undocked, needs no bench. `failed` when the catalog cannot be read. */
export const materialsEffect=(itemId:string,quantity:number)=>
  jobEffect<Materials>('materials',`${quantity} ${itemId}`,folded<Materials>('materials',noMaterials,Effect.gen(function*() {
    const none=noMaterials();
    if(!Number.isInteger(quantity)||quantity<1)
      return {status:'refused',did:`walked no tree for ${itemId}`,why:'quantity must be a whole number of output units, at least one',detail:none};
    const loaded=yield* graphOf();
    if(Result.isFailure(loaded))return {status:'failed',did:`walked no tree for ${itemId}`,why:`catalog unavailable: ${loaded.failure.message}`,detail:none};
    const graph=loaded.success;

    const have:Record<string,number>={...miningInventory(acct().state)};
    if(acct().state.location?.docked_at)for(const row of yield* storeRows())have[row.item_id]=(have[row.item_id]??0)+row.quantity;
    const pool={...have};
    const steps=new Map<string,Materials['steps'][number]>(),depth=new Map<string,number>(),leaves=new Map<string,Materials['leaves'][number]>();
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
      row.runs+=runs;steps.set(recipe.id,row);depth.set(recipe.id,Math.max(depth.get(recipe.id)??0,path.size));
      const deeper=new Set([...path,item]);
      for(const inp of recipe.inputs??[])walk(inp.item_id,(inp.quantity??1)*runs,deeper);
    };
    walk(itemId,quantity,new Set());
    const detail={steps:[...steps.values()].sort((a,b)=>(depth.get(b.recipe)??0)-(depth.get(a.recipe)??0)),leaves:[...leaves.values()]};
    const lacking=detail.leaves.filter(row=>row.have<row.need);
    return {status:'done',
      did:`${quantity} ${itemId}: ${detail.steps.length} recipe${detail.steps.length===1?'':'s'}`
        +(detail.steps.length?` (${detail.steps.map(row=>`${row.runs} × ${row.recipe}`).join(', ')})`:'')
        +`, raw ${detail.leaves.map(row=>`${row.item_id} ${row.have}/${row.need}`).join(', ')||'nothing'}`,
      detail,
      next:lacking.slice(0,3).map(row=>`${row.item_id}: ${row.need-row.have} more to get (${row.source})`)};
  })));
export function materials(itemId:string,quantity:number):Promise<Outcome<Materials>> {return edge(materialsEffect(itemId,quantity));}
