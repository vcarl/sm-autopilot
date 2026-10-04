import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {clearDockRefused,learnNames,markDockRefused,nameIds,readDockRefusals,readNames} from './places.ts';

const BASE='b495c6003fc83e18f6d8cecbe6929133',POI='98eba8b1a7ad0520d6a7c8ea44b2d6aa';

// Live 2026-10-02 (kvothe): player bases and POIs have hex ids, and the pilot's replies carried
// them raw ("between nova_terra_central and b495c6003fc83e18f6d8cecbe6929133").
test('opaque ids are named from the replies already read, and a base its own name beats its POI', () => {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-names-'));
  // find_route names only the POI the base sits at: the base borrows it until it is named itself.
  learnNames(runtime,'spacemolt/find_route',{id:BASE},{structuredContent:{found:true,target_poi:POI,target_poi_name:'Hex Star'}});
  assert.deepEqual(readNames(runtime),{[BASE]:'Hex Star',[POI]:'Hex Star'});
  learnNames(runtime,'spacemolt/get_system',{},{structuredContent:{system:{id:'dheneb',pois:[
    {id:POI,name:'Hex Star',base_id:BASE,base_name:'Kestrel Yard'},
    {id:'dheneb_star',name:'Dheneb',base_id:'dheneb_station',base_name:'Dheneb Station'}]}}});
  assert.deepEqual(readNames(runtime),{[BASE]:'Kestrel Yard',[POI]:'Hex Star'},'readable ids are their own names');
  // A later route quote does not take the base's own name back.
  learnNames(runtime,'spacemolt/find_route',{id:BASE},{structuredContent:{found:true,target_poi:POI,target_poi_name:'Hex Star'}});
  assert.equal(readNames(runtime)[BASE],'Kestrel Yard');
  // A base whose id is its POI's (report 02) is named by its base_name, not the POI row's name.
  const same='2d7100e399b54b0e5c4af16db0ad8565';
  learnNames(runtime,'spacemolt/get_system',{},{structuredContent:{system:{pois:[{id:same,name:'Pollux Rim',base_id:same,base_name:'Proxima Den'}]}}});
  learnNames(runtime,'spacemolt/get_base',{},{structuredContent:{base:{id:'c0ffee00c0ffee00c0ffee00',name:'Deep Cache'}}});
  assert.equal(readNames(runtime)[same],'Proxima Den');
  assert.equal(readNames(runtime)['c0ffee00c0ffee00c0ffee00'],'Deep Cache');
});

test('nameIds names a bare opaque id once and leaves code and readable ids alone', () => {
  const names={[BASE]:'Kestrel Yard'};
  assert.equal(nameIds(`best: ${BASE} buy 2 circuit_board → nova_terra_central`,names),
    `best: Kestrel Yard (${BASE}) buy 2 circuit_board → nova_terra_central`);
  assert.equal(nameIds(`tradeRun({stops:[{at:'${BASE}'}]})`,names),`tradeRun({stops:[{at:'${BASE}'}]})`);
  assert.equal(nameIds(`Kestrel Yard (${BASE}) and ${BASE} (base Kestrel Yard)`,names),`Kestrel Yard (${BASE}) and ${BASE} (base Kestrel Yard)`);
  assert.equal(nameIds(`at ${POI}`,names),`at ${POI}`,'an id with no name is itself');
});

test('docking.json and names.json read leniently: a row that is not one is dropped, the rest kept',()=>{
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-docking-'));
  writeFileSync(join(runtime,'docking.json'),JSON.stringify({good:{message:'Access denied',at:'2026-10-02T16:36:00Z'},bad:{message:7},worse:'no'}));
  writeFileSync(join(runtime,'names.json'),JSON.stringify({[BASE]:'Kestrel Yard',[POI]:42}));
  assert.deepEqual(readDockRefusals(runtime),{good:{message:'Access denied',at:'2026-10-02T16:36:00Z'}});
  assert.deepEqual(readNames(runtime),{[BASE]:'Kestrel Yard'});
  markDockRefused(runtime,'other',{system_id:'sol',message:'Access denied',at:'2026-10-02T17:00:00Z'});
  clearDockRefused(runtime,'good');
  assert.deepEqual(Object.keys(readDockRefusals(runtime)),['other']);
  writeFileSync(join(runtime,'docking.json'),'not json');
  assert.deepEqual(readDockRefusals(runtime),{});
});
