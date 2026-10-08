/** The recipe catalog, read without a bench: what makes an item, what an item goes into, and the whole tree a craft
 * takes down to what is mined or bought. Reads the public catalog and what this pilot remembers (`world.db`'s books and
 * stores) and sends no game command, so each works undocked, with no workshop, and in a query.
 *
 * Both print what they found as text, the way a player's crafting tool lays it out; the rows stay in `detail` for a
 * program. Live 2026-10-06 (kvothe): with only `recipes()`, which lists what hold + this store already cover, the pilot
 * gathered at random and then checked what it could make. */
import type {Recipe} from '@spacemolt/lib';
import {Effect,Result} from 'effect';
import {miningInventory} from '../../mining-inventory.ts';
import type {RecipeGraph} from '../../recipe-graph.ts';
import {cheapestAsk,knownBooks,tickNow,ticksOld,type CheapAsk,type RememberedBook} from '../market.ts';
import {field} from '../game.ts';
import {readNames} from '../places.ts';
import {acct,edge,jobEffect,line,runtimeDir} from '../runtime.ts';
import {readFacilities,readStores,type FacilitySeen} from '../world.ts';
import type {Outcome} from '../types.ts';
import {baseValues,facilityNames,graphOf} from './crafting.ts';

const CAP=20,TREE_LINES=60,ALTERNATES=8;
type Rows=readonly {item_id:string;quantity:number}[]|undefined;
const listed=(rows:Rows)=>(rows??[]).map(row=>`${row.item_id} x${row.quantity}`).join(', ')||'nothing';
const plural=(n:number,word:string)=>`${n} ${word}${n===1?'':'s'}`;
/** A recipe some bench runs: not hidden, not a package operation, not a ship's own passive. */
const usable=(recipe:Recipe)=>!recipe.hidden&&!recipe.package_operation&&recipe.category!=='Ship Passive';

export interface Browsed {
  /** Every matching recipe, in catalog order; only the first 20 are printed. */
  recipes:Recipe[];
  total:number;
}
export interface CatalogFilter {
  /** Matches a recipe's id, name, category or an output item, ignoring case. */
  search?:string;
  /** A category, as the catalog names it (`Refining`, `Components`, …), ignoring case. */
  category?:string;
  /** Recipes whose outputs include this item id. */
  makes?:string;
  /** Recipes whose inputs include this item id. */
  uses?:string;
}

/** Where a facility-only recipe is rented, from the facility book: its facility's name, then up to three stations known
 * to have one, cheapest fee first (an unknown fee last), each with its age in ticks. */
export interface Rentals {name:string;known:FacilitySeen[]}
const RENTALS=3;
function rentalsFor(recipe:Recipe,book:readonly FacilitySeen[],defs:ReadonlyMap<string,string>):Rentals {
  // The catalog dump carries it; the lib's `Recipe` type does not yet.
  const listed=field(recipe,'produced_by_facility_ids'),ids=(Array.isArray(listed)?listed:[]).filter((id):id is string=>typeof id==='string');
  // A definition's name from the catalog copy, else as a station listed it.
  const names=ids.flatMap(id=>defs.get(id)??book.find(row=>row.type===id)?.name??[]);
  const known=book.filter(row=>row.recipe_id===recipe.id||ids.includes(row.type)||names.includes(row.name))
    .sort((a,b)=>(a.fee_per_run??Infinity)-(b.fee_per_run??Infinity)||(b.tick??-1)-(a.tick??-1));
  return {name:names[0]??known[0]?.name??ids[0]??'a facility',known};
}
/** The facility book as `trace()` and `catalog()` print it: read once per call. */
function facilityBook(dir:string|undefined) {
  const book=readFacilities(dir),defs=facilityNames(dir),names=readNames(dir),now=tickNow(dir);
  const at=(row:FacilitySeen)=>`${names[row.base_id]??row.base_id}${row.system_id?` (${names[row.system_id]??row.system_id})`:''} `
    +`${row.fee_per_run===undefined?'fee unknown':`${row.fee_per_run} cr/run`}${row.tick===undefined?'':`, ${ticksOld(row.tick,now)}t old`}`;
  /** `Hull Press: Far Depot (sol) 40 cr/run, 5t old; …`, or that none is known yet. */
  return (recipe:Recipe)=>{const {name,known}=rentalsFor(recipe,book,defs);
    return `${name}: ${known.length?known.slice(0,RENTALS).map(at).join('; ')+(known.length>RENTALS?`; +${known.length-RENTALS} more`:'')
      :'no station known yet (a craft() dry run names the nearest)'}`;};
}

/** One recipe as printed: name, id, category, then what goes in and what comes out. */
const card=(graph:RecipeGraph,recipe:Recipe,rent:(recipe:Recipe)=>string)=>[
  `  ${recipe.name}  (${recipe.id})  [${recipe.category}]`+(recipe.crafting_time?`  ${recipe.crafting_time} ticks`:'')
    +(graph.isCraftable(recipe)||recipe.category==='Ship Passive'?'':`  facility only — ${rent(recipe)}`),
  `    In: ${listed(recipe.inputs)}`,`    Out: ${listed(recipe.outputs)}`].join('\n');

/** The catalog's recipes, filtered: `makes` an item, `uses` an item, in a `category`, or matching `search`; the filters
 * combine. Prints the first 20 as text; `did` says how many matched and how to narrow. Reads only the catalog. */
export const catalogEffect=(filter:CatalogFilter={})=>
  jobEffect<Browsed>('catalog',JSON.stringify(filter),Effect.gen(function*() {
    const loaded=yield* graphOf();
    if(Result.isFailure(loaded))return {status:'failed',did:'read no catalog',why:`catalog unavailable: ${loaded.failure.message}`,detail:{recipes:[],total:0}};
    const graph=loaded.success,low=(text?:string)=>text?.trim().toLowerCase()??'';
    const needle=low(filter.search),category=low(filter.category),makes=filter.makes?.trim(),uses=filter.uses?.trim();
    const recipes=graph.recipes.filter(recipe=>!recipe.hidden
      &&(!makes||(recipe.outputs??[]).some(out=>out.item_id===makes))
      &&(!uses||(recipe.inputs??[]).some(inp=>inp.item_id===uses))
      &&(!category||low(recipe.category)===category)
      &&(!needle||[recipe.id,recipe.name,recipe.category,...(recipe.outputs??[]).map(out=>out.item_id)].some(text=>low(text).includes(needle))));
    const shown=recipes.slice(0,CAP);
    const rent=facilityBook(runtimeDir());
    if(shown.length)line(shown.map(recipe=>card(graph,recipe,rent)).join('\n'));
    const asked=Object.entries(filter).filter(([,value])=>value).map(([key,value])=>`${key} ${JSON.stringify(value)}`).join(', ');
    const counts=new Map<string,number>();
    for(const recipe of recipes.length?recipes:graph.recipes.filter(row=>!row.hidden))counts.set(recipe.category,(counts.get(recipe.category)??0)+1);
    const categories=[...counts].sort((a,b)=>b[1]-a[1]).slice(0,10).map(([name,n])=>`${name} (${n})`).join(', ');
    return {status:'done',
      did:`${plural(recipes.length,'recipe')} ${asked?`match ${asked}`:'in the catalog'}`
        +(recipes.length>CAP?`; showing ${CAP}, ${recipes.length-CAP} more: narrow with search, category, makes or uses`:''),
      detail:{recipes,total:recipes.length},
      next:[...recipes.length>CAP||!recipes.length?[`categories${recipes.length?' among these':''}: ${categories}`]:[],
        ...shown.length&&shown.length<=3?shown.map(recipe=>`trace('${recipe.id}') — the whole tree, what you hold of it, and what is mined or bought`):[]]};
  }));
export function catalog(filter:CatalogFilter={}):Promise<Outcome<Browsed>> {return edge(catalogEffect(filter));}

/** One item in a traced tree. */
export interface TraceNode {
  item_id:string;
  /** Units this branch takes. */
  need:number;
  /** An intermediate: units already held (hold + every store) taken against `need`. A leaf: all you hold of it. */
  have:number;
  /** How the item enters the economy: the catalog's `extracted_by` (`mining`, `gas`, …), `crafted`, or `unknown`. */
  source:string;
  /** The recipe that makes it here, its runs, and whether it needs a facility. Absent on a leaf. */
  recipe?:string;runs?:number;facility_only?:boolean;
  /** A crafted item left as a leaf because it is made from itself further up this branch. */
  cycle?:true;
  /** A leaf's cheapest remembered ask for `need`, at any base, with its age in ticks. */
  ask?:CheapAsk;
  inputs:TraceNode[];
}
/** One item's market value as an estimate: the median of every remembered book's best ask, else of their best bids,
 * else the catalog's `base_value`. Median, so one stale 1-cr ask or a 2,000-cr outlier does not set it; no age is
 * discounted. `markets` is how many books gave a price (0 for `base value`). */
export interface UnitValue {unit:number;source:'median ask'|'median bid'|'base value';markets:number}
const median=(xs:number[])=>{const s=[...xs].sort((a,b)=>a-b),m=Math.floor(s.length/2);return s.length%2?s[m]??0:((s[m-1]??0)+(s[m]??0))/2;};
export function unitValue(books:readonly RememberedBook[],item_id:string,baseValue?:number):UnitValue|null {
  const rows=books.flatMap(book=>book.items.filter(row=>row.item_id===item_id));
  const asks=rows.map(row=>row.best_sell).filter(price=>price>0),bids=rows.map(row=>row.best_buy).filter(price=>price>0);
  if(asks.length)return {unit:median(asks),source:'median ask',markets:asks.length};
  if(bids.length)return {unit:median(bids),source:'median bid',markets:bids.length};
  return baseValue?{unit:baseValue,source:'base value',markets:0}:null;
}
/** What the root recipe's direct inputs and its outputs are worth at market, side by side: an estimate, not the cost to
 * produce. A total is over the valued rows only; `valued` of `of` says how many those are. */
export interface TraceValue {
  components:{total:number;valued:number;of:number};
  output:{total:number;valued:number;of:number};
  inputs:{item_id:string;quantity:number;unit:number|null;source:UnitValue['source']|null;markets:number}[];
  outputs:{item_id:string;quantity:number;unit:number|null;source:UnitValue['source']|null;markets:number}[];
}

/** What one craft comes to, from the catalog and what you remember. */
export interface Traced {
  /** The recipes to run, in the order to run them (deepest first), each with its runs. */
  steps:{recipe:string;runs:number;facility_only:boolean}[];
  /** The raw items at the bottom, all of each the tree consumes, beside what the hold and every store hold of it
   * (`aboard`, `stored` by base, as last seen) and the cheapest ask remembered for it, when one is. */
  leaves:{item_id:string;need:number;have:number;source:string;aboard:number;stored:{base_id:string;quantity:number}[];ask:CheapAsk|null}[];
  tree:TraceNode|null;
  /** Each other recipe for an item in the tree, one level: what it takes instead. */
  alternates:{item_id:string;recipe:string;facility_only:boolean;inputs:{item_id:string;quantity:number}[];makes:number}[];
  /** Runs × each recipe's `crafting_time`: base ticks, before the workshop's skill factor or a facility's throughput. */
  crafting_ticks:number;
  /** The root recipe's inputs and outputs at market value, for the whole order; null when the root is not crafted. */
  value:TraceValue|null;
}
const noTraced=():Traced=>({steps:[],leaves:[],tree:null,alternates:[],crafting_ticks:0,value:null});

/** How a leaf is got, as a verb. An extraction the catalog names that is not here reads as itself. */
const HOW:Record<string,string>={mining:'mine',ice:'mine',gas:'harvest',unknown:'buy'};
const how=(node:Pick<TraceNode,'source'|'cycle'>)=>node.cycle?'made from itself':node.source==='crafted'?'no bench recipe':HOW[node.source]??node.source;
/** Leaves gathered before leaves bought before anything only crafted: a route's rank is its worst leaf's. */
const RANK=(source:string)=>source==='crafted'?2:source==='unknown'?1:0;

/** `arg` as an item, a recipe, or the one item (else the one recipe) whose id or name contains it. */
function resolve(graph:RecipeGraph,arg:string):{item:string;recipe?:Recipe}|{candidates:string[]} {
  const exact=graph.recipe(arg),made=exact?.outputs?.[0];
  if(exact&&made)return {item:made.item_id,recipe:exact};
  const items=new Set([...graph.items.map(item=>item.id),...graph.recipes.flatMap(recipe=>[...recipe.outputs??[],...recipe.inputs??[]].map(row=>row.item_id))]);
  if(items.has(arg))return {item:arg};
  const needle=arg.trim().toLowerCase();
  const hits=[...items].filter(id=>id.toLowerCase().includes(needle));
  const [hit]=hits;
  if(hit&&hits.length===1)return {item:hit};
  const named=graph.recipes.filter(recipe=>!recipe.hidden&&(recipe.id.toLowerCase().includes(needle)||recipe.name.toLowerCase().includes(needle)));
  const [one]=named;
  if(one&&!hits.length&&named.length===1)return resolve(graph,one.id);
  return {candidates:[...hits,...named.map(recipe=>recipe.id)].slice(0,10)};
}

/** The tree `quantity` of an item takes — named by item id, recipe id, or a unique part of either — down to what is
 * mined, harvested or bought, net of what the hold and every store already hold of each intermediate. Each item's
 * route prefers recipes whose leaves are gathered over bought over only crafted, hand-craftable over facility-only,
 * and, when remembered asks price every leaf of both, the cheaper; the others are listed one level deep. Prints the
 * tree as text. Reads only: the catalog, the hold, and `world.db`. */
export const traceEffect=(itemOrRecipe:string,quantity=1)=>
  jobEffect<Traced>('trace',`${quantity} ${itemOrRecipe}`,Effect.gen(function*() {
    const none=noTraced(),fail=(why:string,next:string[]=[])=>({status:'refused' as const,did:`traced no ${itemOrRecipe}`,why,detail:none,next});
    if(!Number.isInteger(quantity)||quantity<1)return fail('quantity must be a whole number of output units, at least one');
    const loaded=yield* graphOf();
    if(Result.isFailure(loaded))return {status:'failed',did:`traced no ${itemOrRecipe}`,why:`catalog unavailable: ${loaded.failure.message}`,detail:none};
    const graph=loaded.success,found=resolve(graph,itemOrRecipe);
    if('candidates' in found)return fail(found.candidates.length?`'${itemOrRecipe}' names more than one: ${found.candidates.join(', ')}`
      :`no item or recipe in the catalog matches '${itemOrRecipe}'`,[`catalog({search:'${itemOrRecipe}'})`]);

    const dir=runtimeDir(),books=knownBooks(dir),now=tickNow(dir),names=readNames(dir),stores=readStores(dir);
    const aboard=miningInventory(acct().state),named=(base:string)=>names[base]??base;
    const storedOf=(item:string)=>stores.filter(row=>row.item_id===item).map(({base_id,quantity:n})=>({base_id,quantity:n}));
    const haveOf=(item:string)=>(aboard[item]??0)+storedOf(item).reduce((sum,row)=>sum+row.quantity,0);
    const options=(item:string)=>graph.recipesFor(item).filter(usable);
    const makes=(recipe:Recipe,item:string)=>recipe.outputs?.find(out=>out.item_id===item)?.quantity||1;

    // ponytail: memoised per item whatever path first reached it, so a cycle cut deep in one branch can price or rank
    // the item a shade worse elsewhere. Exact would key the memo by path; nothing live has needed it.
    const ranks=new Map<string,number>(),costs=new Map<string,number|undefined>();
    const rankOf=(item:string,path:ReadonlySet<string>):number=>{
      const source=graph.source(item);
      if(source!=='crafted')return RANK(source);
      if(path.has(item))return 2;
      if(!ranks.has(item)){const deeper=new Set([...path,item]);ranks.set(item,Math.min(2,...options(item).map(recipe=>routeRank(recipe,deeper))));}
      return ranks.get(item)??2;
    };
    const routeRank=(recipe:Recipe,path:ReadonlySet<string>)=>Math.max(0,...(recipe.inputs??[]).map(inp=>rankOf(inp.item_id,path)));
    const unitCost=(item:string,path:ReadonlySet<string>):number|undefined=>{
      if(graph.source(item)!=='crafted')return cheapestAsk(books,item,1,undefined,now)?.price;
      if(path.has(item))return undefined;
      if(!costs.has(item)) {
        const deeper=new Set([...path,item]);
        const each=options(item).map(recipe=>routeCost(recipe,deeper)/makes(recipe,item)).filter(Number.isFinite);
        costs.set(item,each.length?Math.min(...each):undefined);
      }
      return costs.get(item);
    };
    const routeCost=(recipe:Recipe,path:ReadonlySet<string>)=>(recipe.inputs??[]).reduce((sum,inp)=>sum+(unitCost(inp.item_id,path)??NaN)*inp.quantity,0);
    const pick=(item:string,path:ReadonlySet<string>)=>options(item).map(recipe=>({recipe,rank:routeRank(recipe,path),hand:graph.isCraftable(recipe),cost:routeCost(recipe,path)/makes(recipe,item)}))
      .sort((a,b)=>a.rank-b.rank||Number(b.hand)-Number(a.hand)||(Number.isFinite(a.cost)&&Number.isFinite(b.cost)?a.cost-b.cost:0))[0]?.recipe;

    const pool:Record<string,number>={};
    const steps=new Map<string,Traced['steps'][number]>(),depth=new Map<string,number>(),leaves=new Map<string,Traced['leaves'][number]>(),chosen=new Map<string,string>();
    const walk=(item:string,need:number,path:ReadonlySet<string>,forced?:Recipe):TraceNode=>{
      const source=graph.source(item);
      const recipe=forced??(source==='crafted'&&!path.has(item)?pick(item,path):undefined);
      if(!recipe) {
        const leaf=leaves.get(item)??{item_id:item,need:0,have:haveOf(item),source,aboard:aboard[item]??0,stored:storedOf(item),ask:null};
        leaf.need+=need;leaf.ask=cheapestAsk(books,item,leaf.need,undefined,now)??null;leaves.set(item,leaf);
        const ask=cheapestAsk(books,item,need,undefined,now);
        return {item_id:item,need,have:leaf.have,source,...path.has(item)?{cycle:true as const}:{},...ask?{ask}:{},inputs:[]};
      }
      chosen.set(item,recipe.id);
      pool[item]??=haveOf(item);
      const used=Math.min(pool[item],need);
      pool[item]-=used;
      const node:TraceNode={item_id:item,need,have:used,source,recipe:recipe.id,facility_only:!graph.isCraftable(recipe),inputs:[]};
      if(need-used<=0)return node;
      const runs=Math.ceil((need-used)/makes(recipe,item));
      const row=steps.get(recipe.id)??{recipe:recipe.id,runs:0,facility_only:!graph.isCraftable(recipe)};
      row.runs+=runs;steps.set(recipe.id,row);depth.set(recipe.id,Math.max(depth.get(recipe.id)??0,path.size));
      const deeper=new Set([...path,item]);
      return {...node,runs,inputs:(recipe.inputs??[]).map(inp=>walk(inp.item_id,inp.quantity*runs,deeper))};
    };
    const tree=walk(found.item,quantity,new Set(),found.recipe);
    const alternates=[...chosen].flatMap(([item,id])=>options(item).filter(recipe=>recipe.id!==id).map(recipe=>({item_id:item,recipe:recipe.id,
      facility_only:!graph.isCraftable(recipe),inputs:(recipe.inputs??[]).map(({item_id,quantity:n})=>({item_id,quantity:n})),makes:makes(recipe,item)})));
    const root=found.recipe??(tree.recipe===undefined?undefined:graph.recipe(tree.recipe)),values=baseValues(dir);
    const valued=(rows:Rows,runs:number)=>(rows??[]).map(({item_id,quantity:n})=>{const est=unitValue(books,item_id,values.get(item_id));
      return {item_id,quantity:n*runs,unit:est?.unit??null,source:est?.source??null,markets:est?.markets??0};});
    const summed=(rows:TraceValue['inputs'])=>({total:Math.round(rows.reduce((sum,row)=>sum+(row.unit??0)*row.quantity,0)),valued:rows.filter(row=>row.unit!==null).length,of:rows.length});
    const value=root?(()=>{const runs=Math.ceil(quantity/makes(root,found.item)),inputs=valued(root.inputs,runs),outputs=valued(root.outputs,runs);
      return {components:summed(inputs),output:summed(outputs),inputs,outputs};})():null;
    const detail:Traced={steps:[...steps.values()].sort((a,b)=>(depth.get(b.recipe)??0)-(depth.get(a.recipe)??0)),leaves:[...leaves.values()],tree,alternates,
      crafting_ticks:Math.round([...steps.values()].reduce((sum,row)=>sum+row.runs*(graph.recipe(row.recipe)?.crafting_time??0),0)*100)/100,value};
    const cr=(n:number)=>`${n.toLocaleString('en-US')} cr`;
    /** `≈ 1,240 cr (median ask, 11–18 markets)`, and how many rows had no value at all. */
    const worth=(sum:TraceValue['components'],rows:TraceValue['inputs'],noun:string)=>{
      if(!sum.valued)return `no value known`;
      const kinds=[...new Set(rows.flatMap(row=>row.source?[row.source]:[]))],counts=rows.filter(row=>row.markets).map(row=>row.markets);
      const spread=counts.length?`, ${Math.min(...counts)===Math.max(...counts)?Math.min(...counts):`${Math.min(...counts)}–${Math.max(...counts)}`} markets`:'';
      return `≈ ${cr(sum.total)} (${kinds.join(' + ')}${spread})${sum.valued<sum.of?`, ${sum.valued} of ${sum.of} ${noun} valued`:''}`;
    };
    const valueLine=value&&`    components ${worth(value.components,value.inputs,'inputs')} · output ${worth(value.output,value.outputs,'outputs')}`;

    const asked=(ask:CheapAsk|null|undefined)=>ask?` · cheapest ask ${ask.price} at ${named(ask.base_id)}${ask.age===null?'':` (${ask.age} ticks old)`}`:'';
    const rent=facilityBook(dir),rentals=detail.steps.flatMap(row=>{const recipe=row.facility_only?graph.recipe(row.recipe):undefined;
      return recipe?[`  ${row.recipe} → ${rent(recipe)}`]:[];});
    const label=(node:TraceNode)=>node.recipe!==undefined
      ?`${node.need}x ${node.item_id}  (${node.recipe})${node.facility_only?' [facility: rent below]':''}${node.have?`  have ${node.have}`:''}`
      :`${node.need}x ${node.item_id}  [${how(node)}]${node.have?`  have ${node.have}`:''}${asked(node.ask)}`;
    const drawn=[label(tree),...valueLine?[valueLine]:[]];
    const draw=(nodes:TraceNode[],prefix:string)=>nodes.forEach((node,i)=>{const last=i===nodes.length-1;
      drawn.push(`${prefix}${last?'└── ':'├── '}${label(node)}`);draw(node.inputs,prefix+(last?'    ':'│   '));});
    draw(tree.inputs,'    ');
    const where=(leaf:Traced['leaves'][number])=>[...leaf.aboard?[`${leaf.aboard} aboard`]:[],...leaf.stored.map(row=>`${row.quantity} at ${named(row.base_id)}`)].join(', ');
    const groups=new Map<string,string[]>();
    for(const leaf of detail.leaves) {
      const group=leaf.have>=leaf.need?'Have':(how({source:leaf.source})).replace(/^./,c=>c.toUpperCase());
      groups.set(group,[...groups.get(group)??[],`${leaf.need}x ${leaf.item_id}${leaf.have?` (have ${leaf.have}: ${where(leaf)})`:''}${asked(leaf.ask)}`]);
    }
    const raw=[...groups].flatMap(([group,rows])=>rows.map((row,i)=>`  ${i?' '.repeat(group.length+1):`${group}:`}  ${row}`));
    const alt=detail.alternates.slice(0,ALTERNATES).map(row=>`  ${row.item_id}: ${row.recipe}${row.facility_only?' [facility]':''} (${listed(row.inputs)} → ${row.makes})`);
    line([...drawn.length>TREE_LINES?[...drawn.slice(0,TREE_LINES),`    … ${drawn.length-TREE_LINES} more lines: trace an input on its own`]:drawn,
      '─'.repeat(40),'Raw materials:',...raw,
      ...rentals.length?['Facilities to rent (inputs from that station\'s store, output lands there):',...rentals]:[],
      ...alt.length?['Alternates:',...alt,...detail.alternates.length>ALTERNATES?[`  … ${detail.alternates.length-ALTERNATES} more in detail.alternates`]:[]]:[],
      ...detail.crafting_ticks?[`Crafting time: ${detail.crafting_ticks} ticks at the base rate (workshop skill shortens it)`]:[]].join('\n'));

    const lacking=detail.leaves.filter(row=>row.have<row.need);
    return {status:'done',
      did:`${quantity} ${found.item}: ${plural(detail.steps.length,'recipe')}`
        +(detail.steps.length?` (${detail.steps.map(row=>`${row.runs} × ${row.recipe}`).join(', ')})`:'')
        +`, raw ${detail.leaves.map(row=>`${row.item_id} ${row.have}/${row.need}`).join(', ')||'nothing'}`
        +(value?`; components ≈ ${value.components.valued?cr(value.components.total):'?'}${value.components.valued<value.components.of?` (${value.components.valued} of ${value.components.of} valued)`:''}`
          +`, output ≈ ${value.output.valued?cr(value.output.total):'?'} at market`:''),
      detail,
      next:lacking.slice(0,3).map(row=>`${row.item_id}: ${row.need-row.have} more to get (${how({source:row.source})}${row.ask?`, or buy at ${named(row.ask.base_id)} for ${row.ask.price}`:''})`)};
  }));
export function trace(itemOrRecipe:string,quantity=1):Promise<Outcome<Traced>> {return edge(traceEffect(itemOrRecipe,quantity));}
