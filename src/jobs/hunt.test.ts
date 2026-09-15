import assert from 'node:assert/strict';
import test from 'node:test';
import type {ReadinessAccount} from '../readiness.ts';
import {bridgeWorld,type WorldOptions} from '../test-support/bridge-world.ts';
import type {Ctx} from './ctx.ts';
import {hunt} from './hunt.ts';

const grazer={creature_id:'crt_1',species:'veil_ray',name:'Veil-Ray',speed:2};

/** A job is handed a ctx, not a runner: this is the smallest honest one. */
function fixture(options:WorldOptions={},over:Partial<Ctx>={}) {
  const world=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,store:[],
    wildlife:{creatures:[grazer]},...options});
  const ctx:Ctx={account:world.account as unknown as ReadinessAccount,command:world.command,
    mood:'Focused',home:'sol_base',permissions:{},runtime:undefined,
    keep:[],jobs:[],check:async()=>{},progress:()=>{},resuming:()=>false,...over};
  return {...world,ctx,
    fights:()=>world.count('spacemolt/hunt'),
    moves:()=>world.count('spacemolt/travel')+world.count('spacemolt/undock')};
}

test('a permission key the code does not know is carried, not obeyed', async () => {
  // The live pilot record still carries `wildlife:false` from when it was a permission.
  const f=fixture({},{permissions:{wildlife:false} as Ctx['permissions']});
  const outcome=await hunt(f.ctx,{poi_id:'belt'});
  assert.equal(outcome.outcome,'done',outcome.reason);
  assert.equal(f.fights(),1);
});

test('a ship with no weapon fails at the fit naming the check, before it moves', async () => {
  const f=fixture({wildlife:{creatures:[grazer],weapon:null}});
  const outcome=await hunt(f.ctx,{poi_id:'belt'});
  assert.equal(outcome.outcome,'failed');
  assert.match(String(outcome.reason),/no module of type weapon is fitted/);
  assert.equal(f.moves(),0,'nothing undocked for a fight it cannot take');
  assert.equal(f.fights(),0);
});

test('a weapon with an empty magazine fails naming the rounds and the ammo type, before it moves', async () => {
  const f=fixture({wildlife:{creatures:[grazer],
    weapon:{name:'Autocannon I',ammo_type:'autocannon',current_ammo:0}}});
  const outcome=await hunt(f.ctx,{poi_id:'belt'});
  assert.equal(outcome.outcome,'failed');
  assert.match(String(outcome.reason),/Autocannon I has 0 rounds of autocannon/);
  assert.equal(f.moves(),0);
});

test('one fight, dock to dock: the loot reaches the hold and then the store', async () => {
  const f=fixture();
  const outcome=await hunt(f.ctx,{poi_id:'belt'});
  assert.equal(outcome.outcome,'done',outcome.reason);
  assert.equal(f.fights(),1);
  // The store's delta is the yield, and the hold it came through is empty again.
  assert.deepEqual(outcome.yield,[{item_id:'creature_carapace',quantity:1}]);
  assert.deepEqual(f.store,[{item_id:'creature_carapace',quantity:1}]);
  assert.deepEqual(f.account.server.cargo,[]);
  const result=outcome.result as any;
  assert.deepEqual([result.poi_id,result.fights,result.base_id],['belt',1,'sol_base']);
  assert.deepEqual(result.targets,
    [{species:'veil_ray',outcome:'down',hull_before:96,hull_after:96}]);
  assert.deepEqual([result.hull_before,result.hull],[96,100],'serviced at the end of the trip');
  // Home is a dock, not a place it stopped short of.
  assert.equal(f.account.server.location.docked_at,'sol_base');
  assert.match(String(outcome.reason),/veil_ray|creature_carapace/);
});

test('a creature the scan will not say the speed of is declined, and the job says why', async () => {
  const f=fixture({wildlife:{creatures:[{creature_id:'crt_2',species:'phase_lurker'}]}});
  const outcome=await hunt(f.ctx,{poi_id:'belt'});
  assert.equal(outcome.outcome,'blocked');
  assert.match(String(outcome.reason),/speed/);
  assert.equal(f.fights(),0,'an unknown kind is declined, not fought');
  assert.equal((outcome.result as any).fights,0);
  assert.equal(f.account.server.location.docked_at,'sol_base','and it still came home');
});

test('a creature faster than the ship is declined outright', async () => {
  const f=fixture({wildlife:{creatures:[{creature_id:'crt_3',species:'bolt_eel',speed:9}]}});
  const outcome=await hunt(f.ctx,{poi_id:'belt'});
  assert.equal(outcome.outcome,'blocked');
  assert.match(String(outcome.reason),/faster than the ship/);
  assert.equal(f.fights(),0);
});

test('a hull under the mood\'s walk-away line ends the hunt rather than taking a second fight', async () => {
  // 96 of 100 with the Focused line at 90: one fight costs 8 and the next may not start.
  const f=fixture({wildlife:{polls:1,damage:4,
    creatures:[grazer,{creature_id:'crt_9',species:'veil_ray',speed:2}]}});
  const outcome=await hunt(f.ctx,{poi_id:'belt',fights:2});
  assert.equal(outcome.outcome,'blocked');
  assert.equal(f.fights(),1,'the second creature was there; the hull was not');
  assert.match(String(outcome.reason),/walk-away/);
  const result=outcome.result as any;
  assert.equal(result.targets.length,1);
  assert.deepEqual([result.targets[0].hull_before,result.targets[0].hull_after],[96,88]);
});

test('a ship the world takes out of the fight fails, carrying what moved it', async () => {
  const f=fixture({wildlife:{creatures:[grazer],polls:4,incapacitateOn:1}});
  const outcome=await hunt(f.ctx,{poi_id:'belt'});
  assert.equal(outcome.outcome,'failed');
  assert.equal(outcome.moved?.moved,true);
  assert.equal(outcome.moved?.cause,'captured');
  assert.match(String(outcome.reason),/unsolicited move/);
  assert.equal((outcome.result as any).targets[0].outcome,'unresolved');
});

test('a re-run whose fight already ended comes home instead of attacking again', async () => {
  const f=fixture();
  // The world a restart finds: at the habitat, undocked, the last kill's loot aboard.
  f.account.server.location={system_id:'sol',poi_id:'belt',docked_at:null,in_transit:false};
  f.account.server.cargo=[{item_id:'creature_carapace',quantity:1}];
  f.account.server.ship.cargo_used=1;
  f.ctx.resuming=()=>true;
  const outcome=await hunt(f.ctx,{poi_id:'belt'});
  assert.equal(outcome.outcome,'done',outcome.reason);
  assert.equal(f.fights(),0,'the fight this run already had is not fought twice');
  assert.deepEqual(outcome.yield,[{item_id:'creature_carapace',quantity:1}]);
  assert.deepEqual(f.store,[{item_id:'creature_carapace',quantity:1}]);
  assert.equal(f.account.server.location.docked_at,'sol_base');
});
