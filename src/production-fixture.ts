import {CatalogCache} from '@spacemolt/lib';
import {executionFixture} from './execution-fixture.ts';
import {resolveContext} from './execution-policy.ts';
import {normalizeIndustryCatalog} from './persistent-catalog.ts';

/** Offline game only; real shared Execution, Industry and command journal. */
export function productionFixture(t:any,options:{buyInputs?:boolean;queued?:boolean;partialSale?:boolean;missingCraftCost?:boolean;missingSaleProceeds?:boolean;noDemand?:boolean;buyTax?:number}={}) {
  const f=executionFixture(t);
  f.execution.context=resolveContext({stance:'Industry',mood:'Focused',objective:'Complete one profitable local production run and return serviced'},f.execution.context);
  const recipe={id:'refine',name:'Refine metal',category:'refining',description:'',crafting_time:1,inputs:[{item_id:'ore',quantity:2}],outputs:[{item_id:'metal',quantity:2}]};
  const cache=new CatalogCache(normalizeIndustryCatalog({version:'production-fixture',items:[],recipes:[recipe]}));
  f.execution.deps.industry={catalog:Promise.resolve({cache,freshness:'fresh',fetchedAt:0,retryAt:null})};
  f.state.skills={crafting:{level:1,xp:0},trading:{level:1,xp:0}};
  let ore=options.buyInputs?0:2,metal=0,queued=false,firstSale=true,now=0;
  const sleeps:number[]=[];
  let onSleep:(()=>void)|undefined;
  f.execution.deps.combat={now:()=>now,sleep:async(ms)=>{sleeps.push(ms);now+=ms;onSleep?.();}};
  const finish=()=>{if(queued){queued=false;metal+=2;f.state.skills.crafting.xp+=10;}};
  const market={items:[{item_id:'ore',sell_orders:[{price_each:2,quantity:100}],buy_orders:[{price_each:1,quantity:100}]},{item_id:'metal',sell_orders:[],buy_orders:options.noDemand?[]:[{price_each:20,quantity:100}]}]};
  const send=f.account.send.bind(f.account);
  f.account.send=async(tool,action,params:any={}):Promise<any>=>{
    const reply=await send(tool,action,params);
    const key=tool+'/'+action;
    let result:any;
    if(key==='spacemolt/get_system')result={system:{id:'system',pois:[{id:'station',type:'station'}]}};
    if(key==='spacemolt_market/view_market')result=market;
    if(key==='spacemolt_facility/list')result={facilities:[]};
    if(key==='spacemolt_market/estimate_purchase')result={quantity_requested:params.quantity,available:params.quantity,total_cost:params.quantity*2+(options.buyTax??0),subtotal:params.quantity*2,sales_tax:options.buyTax??0,unfilled:0,fills:[{price_each:2,quantity:params.quantity}]};
    if(key==='spacemolt_storage/view')result={items:[{item_id:'ore',quantity:ore,size:1},{item_id:'metal',quantity:metal,size:1}]};
    if(key==='spacemolt/buy'){ore+=params.quantity;f.state.player.credits+=100-params.quantity*2-(options.buyTax??0);f.state.player.stats.credits_spent+=params.quantity*2+(options.buyTax??0);return {command:'buy',delta:{player:{stats:{credits_spent:f.state.player.stats.credits_spent}},details:{total_cost:params.quantity*2,unfilled:0,delivered_to_storage:params.quantity}}};}
    if(key==='spacemolt/craft') {
      if(params.dry_run)result={kind:'quote',runs:1,credits_total:3,effective_time_per_run:1,have_inputs:ore>=2,have_credits:true,have_capacity:true,cost:{inputs:recipe.inputs,labor:2,fee:1},produces:recipe.outputs,venue_type:'facility',facility_id:'factory',venue:'Fixture factory'};
      else if(params.id){ore-=2;queued=true;f.state.player.credits+=100-3;f.state.player.stats.credits_spent+=3;result={kind:'job',job_id:'craft-job',escrowed:options.missingCraftCost?{labor:2}:{labor:2,fee:1}};if(!options.queued)finish();}
      else result={kind:'queue',total_jobs:queued?1:0,jobs:queued?[{job_id:'craft-job',base_id:'base',recipe:'refine',runs_remaining:1}]:[]};
    }
    if(key==='spacemolt_storage/withdraw') {
      metal-=params.quantity;f.state.cargo.push({item_id:'metal',quantity:params.quantity,size:1});f.state.ship.cargo_used+=params.quantity;result={};
    }
    if(key==='spacemolt/sell') {
      const quantity=options.partialSale&&firstSale?1:params.quantity;firstSale=false;
      let remaining=quantity;
      for(const item of f.state.cargo.filter((item:any)=>item.item_id===params.id)){const sold=Math.min(remaining,item.quantity);item.quantity-=sold;remaining-=sold;}
      f.state.cargo=f.state.cargo.filter((item:any)=>item.quantity>0);f.state.ship.cargo_used-=quantity;
      f.state.player.credits+=quantity*20+100;f.state.skills.trading.xp+=quantity;
      result={item_id:params.id,quantity_sold:quantity,unsold:params.quantity-quantity,...(options.missingSaleProceeds?{}:{total_earned:quantity*20})};
    }
    return result===undefined?reply:{structuredContent:result};
  };
  return {...f,finish,sleeps,onSleep:(callback:()=>void)=>{onSleep=callback;},stock:()=>({ore,metal})};
}
