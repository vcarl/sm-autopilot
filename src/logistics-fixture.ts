import {SpacemoltError} from '@spacemolt/lib';
import {executionFixture} from './execution-fixture.ts';
import {resolveContext,type Home} from './execution-policy.ts';
import {sendAndRefresh} from './execute.ts';
import type {FreightPolicy} from './logistics.ts';

export function freightFixture(t:any,options:{hiddenSize?:boolean;failedWithdrawal?:boolean;missingPayout?:boolean;lostAccept?:boolean}={}) {
  const f=executionFixture(t);
  f.execution.context=resolveContext({stance:'Logistics',mood:'Focused',objective:'Deliver one freight contract and return serviced'},f.execution.context);
  const stations:Home[]=[{base_id:'base',poi_id:'station',system_id:'system',rationale:'fixture',observed_at:'fixture'},{base_id:'other',poi_id:'other',system_id:'system',rationale:'fixture',observed_at:'fixture'}];
  const policy:FreightPolicy={stations,credit_reserve:150000,max_route_jumps:2,max_liability:1000};
  const contract:any={id:'freight',package_id:'box',status:'posted',origin_base_id:'base',destination_base_id:'other',failure_debt:100,reserved_exposure:100,base_reward:80};
  let stored=false;
  const send=f.account.send.bind(f.account);
  f.account.send=async(tool,action,params:any={}):Promise<any>=>{
    const base=await send(tool,action,params);const key=tool+'/'+action;
    let result:any;
    const aboard=()=>f.state.cargo.some((row:any)=>row.item_id==='package:box'&&row.quantity===1);
    if(key==='spacemolt_shipping/profile')result={action:'profile',debt_blocks_acceptance:false,debts:[],capacity:{active_contracts:contract.status==='in_transit'?1:0,active_contracts_unlimited:false,active_contract_limit:2,liability_unlimited:false,remaining_aggregate_liability:10000,single_package_liability_limit:10000},profile:{successful_deliveries:contract.status==='delivered'?1:0,outstanding_debt:0}};
    if(key==='spacemolt_shipping/list')result={action:'list',shipments:contract.status==='posted'?[{contract:structuredClone(contract),eligible:true,deadline_ticks:100}]:[]};
    if(key==='spacemolt_shipping/get')result={action:'get',contract:structuredClone(contract)};
    if(key==='spacemolt_shipping/active')result={action:'active',tick:1,shipments:contract.status==='in_transit'?[{contract:structuredClone(contract),role:'carrier',package_in_your_cargo:aboard(),ticks_to_deadline:100,late:false}]:[]};
    if(key==='spacemolt/inspect'&&params.id==='package:box') {
      if(options.hiddenSize)throw new SpacemoltError('not_found','Package not visible before acceptance');
      result={kind:'package',package:{package_id:'box',size:10}};
    }
    if(key==='spacemolt_shipping/accept') {
      contract.status='in_transit';contract.contractor={kind:'player',id:'pilot'};stored=true;
      if(options.lostAccept)throw new Error('Connection lost after acceptance');
      result={action:'accept',contract:structuredClone(contract)};
    }
    if(key==='spacemolt_storage/view')result={items:stored?[{item_id:'package:box',quantity:1,size:10}]:[]};
    if(key==='spacemolt_storage/withdraw') {
      if(!options.failedWithdrawal){stored=false;f.state.cargo.push({item_id:'package:box',quantity:1,size:10});f.state.ship.cargo_used+=10;}
      result={item_id:'package:box',quantity:1};
    }
    if(key==='spacemolt_shipping/deliver') {
      contract.status='delivered';f.state.cargo=f.state.cargo.filter((row:any)=>row.item_id!=='package:box');f.state.ship.cargo_used-=10;f.state.player.credits+=180;
      if(!options.missingPayout)contract.carrier_payout=80;
      result={action:'deliver',contract:structuredClone(contract),...(options.missingPayout?{}:{carrier_payout:80})};
    }
    return result===undefined?base:{structuredContent:result};
  };
  const command=(action:string,params:Record<string,unknown>={})=>sendAndRefresh(f.account,action,params,()=>{});
  return {...f,policy,contract,command};
}
