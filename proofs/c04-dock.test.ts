import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionClosedError,SpacemoltError} from '@spacemolt/lib';
import type {ReadinessAccount,ReadinessCommand} from '../src/readiness.ts';
import {ArrivalUnresolved} from '../src/travel.ts';
import {DockBlocked,dockAt} from '../src/dock.ts';

// Adapted from ported/setpoint/tests/dispatcher/lib-primitives/dock-at.test.ts.
// C4 requires the dock to be established by an authoritative read, and a lost
// reply to be reconciled in either direction instead of retried blind.
function fixture() {
  let time=0,settleAt=Infinity;
  const server={location:{system_id:'sol',poi_id:'station',docked_at:null as string|null,in_transit:false},
    ship:{id:'ship',fuel:100,max_fuel:120,cargo_used:0}};
  // One ordered account of the primitives: every read and every send, in order.
  const trace:string[]=[];
  const reads:{at:number;docked:string|null}[]=[],calls:{at:number;action:string;params:Record<string,unknown>}[]=[];
  const checkpoints:{at:number;settled:boolean}[]=[],sleeps:number[]=[];
  const account:ReadinessAccount={state:structuredClone(server) as ReadinessAccount['state'],
    async refresh(){
      trace.push(`read:${server.location.docked_at??'undocked'}`);
      reads.push({at:time,docked:server.location.docked_at});
      account.state=structuredClone(server) as ReadinessAccount['state'];
    }};
  const handlers:Record<string,(params:Record<string,unknown>)=>unknown>={
    'spacemolt/dock':()=>{server.location.docked_at='sol_base';return {};},
  };
  const command:ReadinessCommand=async(action,params)=>{
    trace.push(`send:${action}`);
    calls.push({at:time,action,params:structuredClone(params)});
    assert.ok(Object.hasOwn(handlers,action),`Unexpected command: ${action}`);
    return handlers[action](params);
  };
  const options={now:()=>time,
    sleep:async(ms:number)=>{
      assert.ok(ms>0);sleeps.push(ms);time+=ms;
      if(time>=settleAt){server.location.in_transit=false;settleAt=Infinity;}
      // Unrelated pushes never establish a dock.
      account.state.ship!.cargo_used=++server.ship.cargo_used;
    },
    checkpoint:async(settled=false)=>{checkpoints.push({at:time,settled});},
  };
  return {server,account,trace,reads,calls,checkpoints,sleeps,handlers,options,
    transit:(delay:number)=>{server.location.in_transit=true;settleAt=time+delay;},
    run:(baseId?:string)=>dockAt(account,command,baseId,options),now:()=>time};
}

test('C4 docks once at the station and treats an existing dock as satisfied',async()=>{
  for(const mode of ['ordinary','unnamed','already','stale-docked','stale-undocked','other-base','already-error','in-transit']) {
    const f=fixture();
    if(mode==='already'||mode==='stale-undocked')f.server.location.docked_at='sol_base';
    if(mode==='stale-docked')f.account.state.location!.docked_at='sol_base'; // a stale cache cannot satisfy the dock
    if(mode==='stale-undocked')f.account.state.location!.docked_at=null;
    if(mode==='other-base')f.server.location.docked_at='other_base';
    if(mode==='already-error')f.handlers['spacemolt/dock']=()=>{
      // The dock landed on an earlier attempt; the server refuses a second one.
      f.server.location.docked_at='sol_base';
      throw new SpacemoltError('already_docked','Already docked');
    };
    if(mode==='in-transit')f.transit(2_000);
    const expected=mode==='unnamed'?undefined:'sol_base';
    if(mode==='other-base') {
      await assert.rejects(f.run('sol_base'),DockBlocked);
      assert.deepEqual(f.calls,[],'a dock elsewhere is reported, never overwritten');
      assert.equal(f.server.location.docked_at,'other_base');
      continue;
    }
    const result=await f.run(expected);
    assert.deepEqual(result,{docked:true,docked_at:'sol_base',
      already_docked:mode==='already'||mode==='stale-undocked'||mode==='already-error'},mode);
    assert.equal(f.server.location.docked_at,'sol_base',mode);
    const sends=f.calls.filter(call=>call.action==='spacemolt/dock');
    assert.equal(sends.length,result.already_docked&&mode!=='already-error'?0:1,mode);
    // The dock the caller is told about is the one the server last reported.
    assert.equal(f.reads.at(-1)!.docked,'sol_base',mode);
    if(sends.length)assert.ok(f.trace.indexOf('send:spacemolt/dock')<f.trace.lastIndexOf('read:sol_base'),
      `${mode}: a live read must follow the dock command`);
    if(mode==='in-transit') {
      // Only a live read settles the transit; the dock waits for it.
      assert.equal(sends[0]!.at,30_000);
      assert.ok(f.sleeps.every(ms=>ms===2_000));
    }
  }
});

test('C4 reconciles a lost dock reply by a live read and never re-issues a pending dock',async()=>{
  const codes={lost:()=>new SpacemoltError('mutation_timeout','No action_result for mutation r1 within 180000ms'),
    closed:()=>new ConnectionClosedError('closed'),
    pending:()=>new SpacemoltError('action_pending','dock already queued',{pendingCommand:'dock'}),
    refused:()=>new SpacemoltError('not_at_base','No base at this POI')};
  for(const mode of ['lost-landed','lost-missed','lost-twice','closed-landed','closed-missed',
    'pending-landed','pending-missed','refused','unconfirmed','never-settles','no-poi']) {
    const f=fixture();
    const [kind,outcome]=mode.split('-') as [keyof typeof codes,string|undefined];
    const failure=Object.hasOwn(codes,kind)?codes[kind]():undefined;
    let attempts=0;
    if(failure)f.handlers['spacemolt/dock']=()=>{
      attempts++;
      // A reply that never arrives says nothing about whether the dock landed.
      if(outcome==='landed')f.server.location.docked_at='sol_base';
      if(attempts>1&&mode!=='lost-twice'){f.server.location.docked_at='sol_base';return {};}
      throw failure;
    };
    if(mode==='unconfirmed')f.handlers['spacemolt/dock']=()=>({}); // accepted, but no dock in live state
    if(mode==='never-settles')f.transit(Infinity);
    if(mode==='no-poi')delete (f.server.location as {poi_id?:string}).poi_id;
    const trip=f.run('sol_base');
    const landed=['lost-landed','closed-landed','pending-landed','lost-missed','closed-missed'].includes(mode);
    if(landed) {
      assert.deepEqual(await trip,{docked:true,docked_at:'sol_base',already_docked:false},mode);
    } else {
      await assert.rejects(trip,mode==='never-settles'?ArrivalUnresolved:
        ['unconfirmed','no-poi'].includes(mode)?DockBlocked:error=>error===failure,mode);
    }
    const sends=f.calls.filter(call=>call.action==='spacemolt/dock').length;
    assert.equal(sends,['never-settles','no-poi'].includes(mode)?0:
      ['lost-missed','closed-missed','lost-twice'].includes(mode)?2:1,mode);
    if(sends===2) {
      // The single re-issue is earned by a read that showed no dock, not by hope.
      assert.deepEqual(f.trace.slice(0,4),['read:undocked','send:spacemolt/dock','read:undocked','send:spacemolt/dock'],mode);
      assert.equal(f.reads.length,3,mode);
    }
    if(kind==='pending')assert.equal(f.trace.at(-1),`read:${outcome==='landed'?'sol_base':'undocked'}`,
      `${mode}: a queued dock is reconciled by a read, never by another send`);
    if(mode==='refused')assert.deepEqual(f.trace,['read:undocked','send:spacemolt/dock'],mode);
  }
});
