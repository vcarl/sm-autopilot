/** Rank the catalog's recipes by what the pilot already holds — in the hold, and in storage
 * at every base it has used. Read-only: nothing here buys, crafts or queues.
 *
 * A craft escrows its inputs from storage at the base the ship is docked at, so that storage
 * alone decides `craftable_now`; the hold on top of it decides `after_stowing`, which a
 * deposit here would unlock. Everything further out is a fetch, and stays in `nearly` with
 * the base named. */
import type {Catalog} from '@spacemolt/lib';
import {details} from './response-details.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {RecipeGraph,type Coverage} from './recipe-graph.ts';
import {viewStorage} from './storage.ts';

const NEARLY_CAP=12,FACILITY_CAP=6,CRAFTABLE_CAP=20,STOW_CAP=10,STORAGE_BASE_CAP=6,SIZE_BUDGET=6000;

/** One item, split by whether a craft here can reach it: this base's storage, the hold a
 * deposit would move into it, and the bases a trip away. */
interface Placed {here:number;hold:number;elsewhere:{base_id:string;quantity:number}[]}

export interface RecipesParams {search?:string;base_id?:string}

/** One ranked read of the catalog against the pilot's inventory. */
export async function recipesReport(account:ReadinessAccount,command:ReadinessCommand,
  loadCatalog:()=>Promise<Catalog>,params:RecipesParams={}):Promise<Record<string,unknown>> {
  await account.refresh();
  const docked=account.state.location?.docked_at??null;
  const base_id=String(params.base_id??docked??'');
  const fetched_at=new Date().toISOString();
  // The services read answers for the base the ship is at. Naming another base asks about
  // the recipes, not about that base's bench, so the workshop answer stays false.
  let workshop=false;
  if(docked&&base_id===docked) {
    const base=details(await command('spacemolt/get_base',{}));
    workshop=(Array.isArray(base.services)?base.services:[]).map(String).includes('crafting');
  }

  const inventory=new Map<string,Placed>();
  const slot=(item_id:string)=>{
    const placed=inventory.get(item_id)??{here:0,hold:0,elsewhere:[]};
    inventory.set(item_id,placed);
    return placed;
  };
  const stow=(item_id:string,quantity:number,where:string|null)=>{
    if(!(quantity>0))return;
    const placed=slot(item_id);
    if(where===null)placed.hold+=quantity;
    else if(where===docked)placed.here+=quantity;
    else placed.elsewhere.push({base_id:where,quantity});
  };
  for(const row of account.state.cargo??[])stow(String(row.item_id),Number(row.quantity),null);
  let storage_error:string|undefined;
  try {
    const here=await viewStorage(command);
    for(const row of here.items)stow(row.item_id,row.quantity,here.base_id);
    // Every base that holds anything, bounded: the locations index says which do, so the
    // empty ones cost no read at all.
    const elsewhere=here.locations.filter(row=>row.item_count>0&&row.base_id!==here.base_id)
      .slice(0,STORAGE_BASE_CAP-1);
    for(const row of elsewhere) {
      const view=await viewStorage(command,row.base_id);
      for(const item of view.items)stow(item.item_id,item.quantity,view.base_id||row.base_id);
    }
  } catch(error) {
    // A half-read inventory would call a recipe craftable on ore the pilot cannot reach;
    // say so instead.
    storage_error=error instanceof Error?error.message:String(error);
  }

  let catalog:Catalog;
  try {catalog=await loadCatalog();}
  catch(error) {
    return {base_id,docked_at:docked,workshop,fetched_at,
      error:`catalog unavailable: ${error instanceof Error?error.message:String(error)}`};
  }

  const graph=RecipeGraph.from(catalog);
  const needle=String(params.search??'').trim().toLowerCase();
  const tally=(pick:(placed:Placed)=>number)=>new Map([...inventory]
    .map(([id,placed])=>[id,pick(placed)] as [string,number]).filter(([,qty])=>qty>0));
  const sum=(placed:Placed)=>placed.elsewhere.reduce((total,row)=>total+row.quantity,0);
  // What a craft escrows from; what a deposit of the hold would add to that; and everything
  // the pilot owns anywhere, which is only a ranking aid once undocked.
  const hereStock=tally(placed=>placed.here);
  const stowStock=tally(placed=>placed.here+placed.hold);
  const anyStock=tally(placed=>placed.here+placed.hold+sum(placed));
  const entry=(cov:Coverage)=>({
    recipe_id:cov.recipe.id,name:cov.recipe.name,category:cov.recipe.category,
    produces:(cov.recipe.outputs??[]).map(out=>({item_id:out.item_id,quantity:out.quantity})),
    inputs:(cov.recipe.inputs??[]).map(inp=>{
      const placed=inventory.get(inp.item_id);
      return {item_id:inp.item_id,quantity:inp.quantity,held_here:placed?.here??0,
        in_hold:placed?.hold??0,elsewhere:placed?.elsewhere??[]};
    }),
    missing:cov.missing,covered:Math.round(cov.covered*100)/100,
  });
  // Docked, a recipe is ranked by what the bench can actually reach; undocked there is no
  // bench, so the ranking falls back to everything owned and every list of work is empty.
  const covered=graph.craftableWith(docked?stowStock:anyStock,{includeFacilityOnly:true})
    .filter(cov=>!needle||
      [cov.recipe.id,cov.recipe.name,cov.recipe.category,...(cov.recipe.outputs??[]).map(out=>out.item_id)]
        .some(text=>String(text).toLowerCase().includes(needle)));
  const hand=covered.filter(cov=>graph.isCraftable(cov.recipe));
  const escrowable=(cov:Coverage)=>graph.coverage(cov.recipe,hereStock).complete;
  const ranked={
    craftable_now:docked?hand.filter(escrowable):[],
    after_stowing:docked?hand.filter(cov=>cov.complete&&!escrowable(cov)):[],
    nearly:docked?hand.filter(cov=>!cov.complete):hand,
    facility_only:covered.filter(cov=>cov.complete&&!graph.isCraftable(cov.recipe)),
  };
  const craftable_now=ranked.craftable_now.slice(0,CRAFTABLE_CAP).map(entry);
  const after_stowing=ranked.after_stowing.slice(0,STOW_CAP).map(entry);
  const nearly=ranked.nearly.slice(0,NEARLY_CAP).map(entry);
  const facility_only=ranked.facility_only.slice(0,FACILITY_CAP).map(entry);
  const result={
    base_id,docked_at:docked,workshop,craftable_now,after_stowing,nearly,facility_only,
    // How many each list would hold uncut, so a shown list is never mistaken for the whole
    // of what the pilot can make.
    counts:{craftable_now:ranked.craftable_now.length,after_stowing:ranked.after_stowing.length,
      nearly:ranked.nearly.length,facility_only:ranked.facility_only.length},
    fetched_at,catalog_version:catalog.version,
    ...storage_error?{storage_error}:{},
  };
  // A juncture reads the whole result, so it is bounded. The near misses go first; then the
  // craftable tail down to a handful, so a rich inventory does not crowd out the facility
  // bucket; the best craftable line is never the one dropped.
  // ponytail: re-stringifies per drop; the caps above keep that to a few dozen passes.
  const order:{rows:unknown[];floor:number}[]=[{rows:nearly,floor:0},{rows:after_stowing,floor:4},
    {rows:craftable_now,floor:6},{rows:facility_only,floor:0},{rows:after_stowing,floor:1},
    {rows:craftable_now,floor:1}];
  while(JSON.stringify(result).length>SIZE_BUDGET) {
    const next=order.find(list=>list.rows.length>list.floor);
    if(!next)break;
    next.rows.pop();
  }
  return result;
}
