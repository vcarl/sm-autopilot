import test from 'node:test';
import assert from 'node:assert/strict';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {HomeBlocked,registerHome} from './home-location.ts';

function fixture(opts:{home?:string;docked?:string|null;moves?:boolean}={}) {
  const server={location:{system_id:'a',poi_id:'dock',docked_at:opts.docked===undefined?'base':opts.docked,in_transit:false},
    player:{credits:100,home_base:opts.home??'old-base'}};
  const account:ReadinessAccount={state:structuredClone(server) as ReadinessAccount['state'],
    async refresh(){account.state=structuredClone(server) as ReadinessAccount['state'];}};
  const calls:{action:string;params:Record<string,unknown>}[]=[];
  const command:ReadinessCommand=async(action,params)=>{
    calls.push({action,params});
    assert.equal(action,'spacemolt_salvage/set_home');
    // The reply always claims success; only the post-read decides.
    if(opts.moves!==false)server.player.home_base=String(params.id);
    return {delta:{details:{action:'set_home',home_base:String(params.id),message:'ok'}}};
  };
  return {server,account,calls,command};
}

test('choosing home issues set_home at the dock and is confirmed by an authoritative read',async()=>{
  const home={base_id:'base',rationale:'services, one jump from the belt'};
  // The game's home moves to the chosen base, and the confirmation comes from the read.
  const chosen=fixture();
  assert.deepEqual(await registerHome(chosen.account,chosen.command,home),{home_base:'base',issued:true});
  assert.deepEqual(chosen.calls,[{action:'spacemolt_salvage/set_home',params:{id:'base'}}]);
  assert.equal(chosen.server.player.home_base,'base');

  // Already the game's home: the counter is not visited again.
  const settled=fixture({home:'base'});
  assert.deepEqual(await registerHome(settled.account,settled.command,home),{home_base:'base',issued:false});
  assert.deepEqual(settled.calls,[]);

  // An accepted reply whose post-state never moved is not a registration.
  const unmoved=fixture({moves:false});
  await assert.rejects(registerHome(unmoved.account,unmoved.command,home),error=>
    error instanceof HomeBlocked&&error.message.includes('still reports home old-base'));
  assert.equal(unmoved.calls.length,1);

  // Home is registered where the pilot is standing: no dock, no command.
  for(const docked of [null,'elsewhere']) {
    const adrift=fixture({docked});
    await assert.rejects(registerHome(adrift.account,adrift.command,home),error=>
      error instanceof HomeBlocked&&error.message.includes('Dock at base'));
    assert.deepEqual(adrift.calls,[]);
  }
});
