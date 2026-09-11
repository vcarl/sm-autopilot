import test from 'node:test';
import assert from 'node:assert/strict';
import {industryLocations} from './locations.ts';

test('return admission refreshes directed map edges instead of reusing cached reachability',async t=>{
  let connected=true;
  t.mock.method(globalThis,'fetch',async(input:any)=>{
    const path=new URL(String(input)).pathname;
    if(path==='/api/map')return Response.json({systems:[
      {id:'destination',connections:connected?['home']:[]},
      {id:'home',connections:['destination']},
    ],empires:{}});
    assert.equal(path,'/api/stations');
    return Response.json({stations:[
      {id:'home-base',base_id:'home-base',poi_id:'home-poi',system_id:'home',name:'Home',system_name:'Home',services:[],wrecked:false},
      {id:'dest-base',base_id:'dest-base',poi_id:'dest-poi',system_id:'destination',name:'Destination',system_name:'Destination',services:[],wrecked:false},
    ],empires:[]});
  });
  const params={max_jumps:2,observed_destination_ids:['home-base']};
  const initial=await industryLocations('destination',{...params,refresh_map:true});
  assert.equal(initial.destination_matches?.[0]?.status,'resolved');
  connected=false;
  const cached=await industryLocations('destination',params);
  assert.equal(cached.destination_matches?.[0]?.status,'resolved');
  const fresh=await industryLocations('destination',{...params,refresh_map:true});
  assert.equal(fresh.destination_matches?.[0]?.status,'outside_route_limit');
  const outward=await industryLocations('home',{max_jumps:2,refresh_map:true,observed_destination_ids:['dest-base']});
  assert.equal(outward.destination_matches?.[0]?.status,'resolved','A forward edge does not prove the reverse edge exists');
});
