/** Rank the catalog's recipes by what the pilot already holds — in the hold, and in storage
 * at every base it has used. Read-only: nothing here buys, crafts or queues.
 *
 * The inventory is one map, and every quantity remembers where it sits, because "you can
 * craft this" is only true if the pilot can also say which base to fetch the inputs from. */
import type {Catalog} from '@spacemolt/lib';
import {details} from './response-details.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {RecipeGraph,type Coverage} from './recipe-graph.ts';
import {viewStorage} from './storage.ts';

/** Where the ship's own hold shows up in an `at` list: not a base, and never a fetch. */
export const HOLD='hold';
const NEARLY_CAP=12,FACILITY_CAP=6,CRAFTABLE_CAP=20,STORAGE_BASE_CAP=6,SIZE_BUDGET=6000;

interface Placed {total:number;at:{base_id:string;quantity:number}[]}

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
  const add=(item_id:string,quantity:number,where:string)=>{
    if(!(quantity>0))return;
    const placed=inventory.get(item_id)??{total:0,at:[]};
    placed.total+=quantity;
    placed.at.push({base_id:where,quantity});
    inventory.set(item_id,placed);
  };
  for(const row of account.state.cargo??[])add(String(row.item_id),Number(row.quantity),HOLD);
  let storage_error:string|undefined;
  try {
    const here=await viewStorage(command);
    for(const row of here.items)add(row.item_id,row.quantity,here.base_id);
    // Every base that holds anything, bounded: the locations index says which do, so the
    // empty ones cost no read at all.
    const elsewhere=here.locations.filter(row=>row.item_count>0&&row.base_id!==here.base_id)
      .slice(0,STORAGE_BASE_CAP-1);
    for(const row of elsewhere) {
      const view=await viewStorage(command,row.base_id);
      for(const item of view.items)add(item.item_id,item.quantity,view.base_id||row.base_id);
    }
  } catch(error) {
    // A half-read inventory would call a recipe craftable on ore the pilot cannot reach;
    // say so instead.
    storage_error=error instanceof Error?error.message:String(error);
  }

  let catalog:Catalog;
  try {catalog=await loadCatalog();}
  catch(error) {
    return {base_id,workshop,fetched_at,
      error:`catalog unavailable: ${error instanceof Error?error.message:String(error)}`};
  }

  const graph=RecipeGraph.from(catalog);
  const needle=String(params.search??'').trim().toLowerCase();
  const held=new Map([...inventory].map(([id,placed])=>[id,placed.total]));
  const entry=(cov:Coverage)=>({
    recipe_id:cov.recipe.id,name:cov.recipe.name,category:cov.recipe.category,
    produces:(cov.recipe.outputs??[]).map(out=>({item_id:out.item_id,quantity:out.quantity})),
    inputs:(cov.recipe.inputs??[]).map(inp=>{
      const placed=inventory.get(inp.item_id);
      return {item_id:inp.item_id,quantity:inp.quantity,held:placed?.total??0,at:placed?.at??[]};
    }),
    missing:cov.missing,covered:Math.round(cov.covered*100)/100,
  });
  const covered=graph.craftableWith(held,{includeFacilityOnly:true}).filter(cov=>!needle||
    [cov.recipe.id,cov.recipe.name,cov.recipe.category,...(cov.recipe.outputs??[]).map(out=>out.item_id)]
      .some(text=>String(text).toLowerCase().includes(needle)));
  const hand=(cov:Coverage)=>graph.isCraftable(cov.recipe);
  const complete=covered.filter(cov=>cov.complete);
  const ranked={craftable_now:complete.filter(hand),
    nearly:covered.filter(cov=>!cov.complete&&hand(cov)),
    facility_only:complete.filter(cov=>!hand(cov))};
  const craftable_now=ranked.craftable_now.slice(0,CRAFTABLE_CAP).map(entry);
  const nearly=ranked.nearly.slice(0,NEARLY_CAP).map(entry);
  const facility_only=ranked.facility_only.slice(0,FACILITY_CAP).map(entry);
  const result={
    base_id,workshop,craftable_now,nearly,facility_only,
    // How many each list would hold uncut, so a shown list is never mistaken for the whole
    // of what the pilot can make.
    counts:{craftable_now:ranked.craftable_now.length,nearly:ranked.nearly.length,
      facility_only:ranked.facility_only.length},
    fetched_at,catalog_version:catalog.version,
    ...storage_error?{storage_error}:{},
  };
  // A juncture reads the whole result, so it is bounded. The near misses go first; then the
  // craftable tail down to a handful, so a rich inventory does not crowd out the facility
  // bucket; the best craftable line is never the one dropped.
  // ponytail: re-stringifies per drop; the caps above keep that to a few dozen passes.
  const order:{rows:unknown[];floor:number}[]=[{rows:nearly,floor:0},{rows:craftable_now,floor:6},
    {rows:facility_only,floor:0},{rows:craftable_now,floor:1}];
  while(JSON.stringify(result).length>SIZE_BUDGET) {
    const next=order.find(list=>list.rows.length>list.floor);
    if(!next)break;
    next.rows.pop();
  }
  return result;
}
