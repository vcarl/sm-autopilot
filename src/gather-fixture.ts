import {executionFixture} from './execution-fixture.ts';
import {resolveContext} from './execution-policy.ts';

export function gatherFixture(t:any) {
  const f=executionFixture(t);
  f.execution.context=resolveContext({stance:'Industry',mood:'Focused',objective:'Gather local ore and preserve it for later use'},f.execution.context);
  f.state.ship.utility_slots=1;
  f.state.modules.push({module_id:'miner',type_id:'mining_laser_i',slot:'utility',stats:{mining_power:5}});
  f.state.cargo=[{item_id:'ore',quantity:4,size:1},{item_id:'ore',quantity:6,size:1},{item_id:'original',quantity:1,size:1}];
  f.state.ship.cargo_used=11;
  f.state.skills={mining:{level:1,xp:0}};
  let cycles=0;
  const send=f.account.send.bind(f.account);
  f.account.send=async(tool,action,params):Promise<any>=>{
    const result=await send(tool,action,params);
    if(action==='get_system')return {structuredContent:{system:{id:'system',pois:[{id:'belt',name:'Local Belt',type:'asteroid_belt'}]}}};
    if(action==='get_poi')return {structuredContent:{kind:'normal',poi:{id:f.state.location.poi_id,system_id:'system'},resources:[{resource_id:'ore',remaining:100,richness:1},{resource_id:'carbon',remaining:100,richness:1}]}};
    if(action==='mine') {
      const item=cycles++%2===0?{item_id:'ore',quantity:2,size:1}:{item_id:'carbon',quantity:1,size:1};
      f.state.cargo.push(item);
      f.state.ship.cargo_used+=item.quantity;f.state.ship.fuel--;f.state.skills.mining.xp+=5;
      return {structuredContent:{kind:'yield',resource_id:item.item_id,quantity:item.quantity,remaining:100-cycles}};
    }
    return result;
  };
  return f;
}
