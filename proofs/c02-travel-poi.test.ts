import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionClosedError,SpacemoltError} from '@spacemolt/lib';
import type {ReadinessAccount,ReadinessCommand} from '../src/readiness.ts';
import {ArrivalUnresolved,travelTo} from '../src/travel.ts';

// Adapted from ported/setpoint/tests/dispatcher/lib-primitives/go-to-poi.test.ts.
// C2 requires authoritative confirmation, overriding the port's cache-only shortcut.
function fixture() {
  let time=0,arrivalAt=Infinity,arrivalPoi='belt';
  const server={location:{system_id:'sol',poi_id:'station',docked_at:null,in_transit:false},
    ship:{id:'ship',fuel:100,max_fuel:120,cargo_used:0}};
  const reads:{at:number;state:typeof server}[]=[],calls:{at:number;action:string;params:Record<string,unknown>;state:typeof server}[]=[];
  const checkpoints:{at:number;settled:boolean}[]=[],sleeps:number[]=[];
  const account:ReadinessAccount={state:structuredClone(server) as ReadinessAccount['state'],
    async refresh(){reads.push({at:time,state:structuredClone(server)});account.state=structuredClone(server) as ReadinessAccount['state'];}};
  const schedule=(poi:string,delay=2_000)=>{server.location.in_transit=true;arrivalPoi=poi;arrivalAt=time+delay;};
  const handlers:Record<string,(params:Record<string,unknown>)=>unknown>={
    'spacemolt/find_route':params=>{
      assert.equal(params.id,'sol');assert.equal(server.location.in_transit,false);
      return {found:true,target_system:'sol',total_jumps:0,estimated_fuel:7,fuel_per_jump:0,
        fuel_available:server.ship.fuel,cargo_used:server.ship.cargo_used,route:[{system_id:'sol',jumps:0}]};
    },
    'spacemolt/travel':params=>{
      assert.equal(params.id,'belt');assert.equal(server.location.in_transit,false);
      server.ship.fuel-=7;schedule('belt');return {};
    },
  };
  const command:ReadinessCommand=async(action,params)=>{
    calls.push({at:time,action,params:structuredClone(params),state:structuredClone(server)});
    assert.ok(Object.hasOwn(handlers,action),`Unexpected command: ${action}`);
    return handlers[action](params);
  };
  const hooks={poll:()=>{},checkpoint:(_settled:boolean)=>{}};
  const options={mood:'Cautious' as const,now:()=>time,
    sleep:async(ms:number)=>{
      assert.ok(ms>0);sleeps.push(ms);time+=ms;
      if(time>=arrivalAt){server.location.poi_id=arrivalPoi;server.location.in_transit=false;arrivalAt=Infinity;}
      // Unrelated pushes never refresh location or certify an arrival.
      account.state.ship!.cargo_used=++server.ship.cargo_used;
      hooks.poll();
    },
    checkpoint:async(settled=false)=>{
      checkpoints.push({at:time,settled});
      if(settled)assert.equal(account.state.location!.in_transit,false);
      hooks.checkpoint(settled);
    },
  };
  return {server,account,reads,calls,checkpoints,sleeps,handlers,hooks,options,schedule,
    run:()=>travelTo(account,command,{system_id:'sol',poi_id:'belt'},options),now:()=>time};
}

test('C2 local travel reconciles initial transit and certifies arrival from authoritative state',async()=>{
  for(const mode of ['ordinary','arrived','cached-arrived','transit-target','transit-elsewhere','cache-push']) {
    const f=fixture();
    if(mode==='arrived')f.server.location.poi_id='belt';
    if(mode==='cached-arrived')f.account.state.location!.poi_id='belt';
    if(mode.startsWith('transit-')) {
      f.schedule(mode==='transit-target'?'belt':'other');
      f.account.state.location!.poi_id='belt'; // stale target must not skip reconciliation
    }
    if(mode==='cache-push')f.hooks.poll=()=>{
      // A premature arrival push must be verified, even with transit cleared in cache.
      f.account.state.location!.poi_id='belt';f.account.state.location!.in_transit=false;
    };
    if(mode==='cache-push')f.handlers['spacemolt/travel']=()=>{f.schedule('belt',32_000);return {};};
    const result=await f.run();
    assert.deepEqual(result.location,f.server.location,mode);
    assert.equal(result.location!.poi_id,'belt');assert.equal(result.location!.in_transit,false);
    const confirmation=f.reads.find(read=>read.state.location.poi_id==='belt'&&!read.state.location.in_transit);
    assert.ok(confirmation,`${mode}: an authoritative read must establish arrival`);
    assert.ok(f.checkpoints.filter(c=>c.settled&&c.at>0).every(c=>f.reads.some(r=>r.at===c.at&&!r.state.location.in_transit)));
    const noMove=mode==='arrived'||mode==='transit-target';
    assert.deepEqual(f.calls.map(c=>c.action),noMove?[]:['spacemolt/find_route','spacemolt/travel'],mode);
    if(mode==='transit-target'||mode==='transit-elsewhere') {
      assert.equal(f.checkpoints.find(c=>c.settled)!.at,30_000);
      assert.ok(f.sleeps.every(ms=>ms===2_000));
    }
    if(mode==='transit-elsewhere') {
      const quote=f.calls[0];assert.equal(quote.at,30_000);
      assert.equal(quote.state.location.poi_id,'other');
      assert.equal(quote.state.ship.cargo_used,15);
      assert.deepEqual(f.account.state.ship,f.server.ship);
    }
    if(mode==='cache-push')assert.ok(confirmation.at>=32_000);
    assert.equal(result.jumps,0);
  }
});

test('C2 waiting is bounded and interruptible, and only definitive rejection permits one reconciled retry',async()=>{
  for(const mode of ['timeout','ship','stop','reject-target','reject-elsewhere','reject-twice','pending','transport','uncertain']) {
    const f=fixture();
    if(['timeout','ship','stop'].includes(mode)) {
      f.schedule('belt',Infinity);f.server.location.poi_id='belt';
      if(mode==='ship')f.hooks.poll=()=>{f.server.ship.id='replacement';};
      if(mode==='stop')f.hooks.checkpoint=()=>{if(f.now()>=2_000)throw new Error('operator stop');};
    }
    const normal=f.handlers['spacemolt/travel'];let attempts=0;
    const rejection=new SpacemoltError('in_transit','definitive rejection');
    const uncertain=mode==='transport'?new ConnectionClosedError('closed'):new SpacemoltError('mutation_timeout','unknown');
    const pending=new SpacemoltError('in_transit','pending');Object.assign(pending,{pendingCommand:{}});
    f.handlers['spacemolt/travel']=params=>{
      attempts++;
      if(mode.startsWith('reject')&&(attempts===1||mode==='reject-twice')) {
        f.schedule(mode==='reject-target'?'belt':'other');throw rejection;
      }
      if(['pending','transport','uncertain'].includes(mode)) {
        f.server.location.poi_id='belt';f.server.location.in_transit=false;
        throw mode==='pending'?pending:uncertain;
      }
      return normal(params);
    };
    const trip=f.run();
    if(mode==='reject-target'||mode==='reject-elsewhere') {
      const result=await trip;assert.equal(result.location!.poi_id,'belt');
      assert.equal(attempts,mode==='reject-target'?1:2);
      if(attempts===2){assert.equal(f.calls[2].at,30_000);assert.equal(f.calls[2].state.location.poi_id,'other');}
    } else {
      await assert.rejects(trip,mode==='timeout'?ArrivalUnresolved:mode==='ship'?/Ship changed/:mode==='stop'?/operator stop/:
        error=>error===(mode==='reject-twice'?rejection:mode==='pending'?pending:uncertain));
      if(mode==='timeout') {
        assert.equal(f.now(),600_000);assert.equal(f.reads.at(-1)!.at,600_000);
        assert.deepEqual(f.checkpoints.filter(c=>c.settled),[]);
      }
      if(['timeout','ship','stop'].includes(mode)) {
        assert.deepEqual(f.calls,[]);assert.deepEqual(f.checkpoints.filter(c=>c.settled),[]);
        if(mode==='ship')assert.equal(f.now(),30_000);
        if(mode==='stop')assert.equal(f.now(),2_000);
      } else assert.equal(attempts,mode==='reject-twice'?2:1);
    }
    if(mode.startsWith('reject'))assert.ok(f.calls.filter(c=>c.action==='spacemolt/travel').slice(1).every(c=>c.at>=30_000&&!c.state.location.in_transit));
  }
});
