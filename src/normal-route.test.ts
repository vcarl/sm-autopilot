import test from 'node:test';
import assert from 'node:assert/strict';
import {routeSteps} from './normal-route.ts';

const quote=(systems:string[])=>({found:true,target_system:systems.at(-1),total_jumps:systems.length-1,
  estimated_fuel:(systems.length-1)*10,fuel_per_jump:10,route:systems.map((system_id,jumps)=>({system_id,jumps}))});

test('normal route validation obeys explicit caller allocation without imposing a hidden two-jump cap',()=>{
  const route=quote(['origin','one','two','destination']);
  assert.deepEqual(routeSteps(route,'origin','destination',3),['one','two','destination']);
  assert.throws(()=>routeSteps(route,'origin','destination',2),/normal jumps/);
  assert.deepEqual(routeSteps(quote(['origin']),'origin','origin',0),[]);
  for(const allocation of [undefined,-1,1.5,Infinity,NaN])assert.throws(()=>routeSteps(route,'origin','destination',allocation as number),/allocation/);
});

test('normal route validation requires consistent endpoints and steps, ordinary connections and finite fuel evidence',()=>{
  const invalid=[
    (r:any)=>{r.found=false;},(r:any)=>{r.target_system='elsewhere';},
    (r:any)=>{r.total_jumps++;},(r:any)=>{r.route[0].system_id='elsewhere';},
    (r:any)=>{r.route[1].system_id='elsewhere';},(r:any)=>{r.route[1].jumps=0;},
    (r:any)=>{r.route[1].via_wormhole=true;},
    (r:any)=>{r.estimated_fuel=undefined;},(r:any)=>{r.estimated_fuel=-1;},
    (r:any)=>{r.fuel_per_jump=NaN;},(r:any)=>{r.fuel_per_jump=Infinity;},
  ];
  for(const change of invalid){const route=quote(['origin','destination']);change(route);assert.throws(()=>routeSteps(route,'origin','destination',2));}
  assert.deepEqual(routeSteps(quote(['origin','destination']),'origin','destination',2),['destination']);
});
