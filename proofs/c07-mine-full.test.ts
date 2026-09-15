import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionClosedError,SpacemoltError} from '@spacemolt/lib';
import type {ReadinessAccount,ReadinessCommand} from '../src/readiness.ts';
import {mineToFull} from '../src/mine.ts';

// Recording handler-map pattern from the C2/C5 proofs. The server is independent of
// the cache: only refresh exposes it, so nothing production reads can be pushed at it.
// Every mine reply over-claims its take (99 ore), so a yield assertion below can only
// pass if the number came from the authoritative cargo delta.
function fixture(opts:{used?:number;capacity?:number;docked?:string|null}={}) {
  const server={
    location:{system_id:'sol',poi_id:'belt',docked_at:opts.docked??null,in_transit:false},
    ship:{id:'ship',cargo_used:opts.used??1,cargo_capacity:opts.capacity??10,incapacitated:false},
    cargo:[{item_id:'ore',quantity:1}] as {item_id:string;quantity:number}[],
  };
  const reads:{cargo_used:number}[]=[],calls:{action:string;cargo_used:number}[]=[];
  const account:ReadinessAccount={state:structuredClone(server) as ReadinessAccount['state'],
    async refresh(){
      reads.push({cargo_used:server.ship.cargo_used});
      account.state=structuredClone(server) as ReadinessAccount['state'];
    }};
  const add=(item:string,quantity:number)=>{
    const row=server.cargo.find(current=>current.item_id===item);
    if(row)row.quantity+=quantity;else server.cargo.push({item_id:item,quantity});
    server.ship.cargo_used=Math.min(server.ship.cargo_capacity,server.ship.cargo_used+quantity);
  };
  const claim=()=>({command:'mine',delta:{details:{kind:'yield',resource_id:'ore',quantity:99,remaining:5}}});
  // Three cargo units a cycle out of a ten-unit hold: full after three accepted cycles.
  const productive=()=>{add('ore',2);add('carbon',1);return claim();};
  let cycle=0;
  const hooks={mine:(_cycle:number):unknown=>undefined};
  const handlers:Record<string,()=>unknown>={
    'spacemolt/mine':()=>{
      const override=hooks.mine(++cycle);
      return override===undefined?productive():override;
    },
  };
  const command:ReadinessCommand=async(action,params)=>{
    calls.push({action,cargo_used:server.ship.cargo_used});
    assert.deepEqual(params,{},'the mine primitive takes no parameters');
    assert.ok(Object.hasOwn(handlers,action),`Unexpected command: ${action}`);
    return handlers[action]();
  };
  return {server,account,reads,calls,hooks,add,claim,run:()=>mineToFull(account,command)};
}

const takeAfter=(cycles:number)=>[{item_id:'carbon',quantity:cycles},{item_id:'ore',quantity:cycles*2}];

test('C7: the hold fills, cargo_full in any shape is success, and yield is the authoritative delta',async()=>{
  for(const mode of ['fills','already-full','reply-cargo-full','error-cargo-full','lost-reply-full']) {
    const f=fixture(mode==='already-full'?{used:10}:{});
    // The server says "full" three ways: a post-state at capacity, a reply token, and
    // a rejection. A hold the server calls full need not be numerically full.
    if(mode==='reply-cargo-full')f.hooks.mine=cycle=>cycle===2?{command:'mine',delta:{details:{kind:'cargo_full'}}}:undefined;
    if(mode==='error-cargo-full')f.hooks.mine=cycle=>{
      if(cycle===2)throw new SpacemoltError('cargo_full','Cargo hold is full');
      return undefined;
    };
    if(mode==='lost-reply-full')f.hooks.mine=cycle=>{
      if(cycle!==2)return undefined;
      // The take landed; only the reply was lost. Reconcile from state, never retry blind.
      f.add('ore',6);throw new ConnectionClosedError('WebSocket connection closed');
    };
    const result=await f.run();
    assert.equal(result.outcome,'full',mode);

    const cycles=mode==='fills'?3:mode==='already-full'?0:mode==='reply-cargo-full'?2:1;
    assert.equal(result.cycles,cycles,mode);
    assert.equal(f.calls.length,mode==='already-full'?0:mode==='fills'?3:2,mode);
    assert.ok(f.calls.every(call=>call.action==='spacemolt/mine'),mode);

    // Never 99: the reply's claim is not evidence, the cargo delta is.
    const expected=mode==='already-full'?[]:
      mode==='lost-reply-full'?[{item_id:'carbon',quantity:1},{item_id:'ore',quantity:8}]:
      takeAfter(mode==='reply-cargo-full'?1:cycles);
    assert.deepEqual(result.yield,expected,mode);

    // Every reported unit is still carried by the ship the step began with.
    const carried=f.server.cargo.reduce((sum,row)=>sum+row.quantity,0);
    assert.equal(carried,1+result.yield.reduce((sum,row)=>sum+row.quantity,0),mode);
    assert.equal(f.server.ship.id,'ship',mode);
    // Success is read from state, not asserted: a read closes every accepted cycle.
    assert.ok(f.reads.length>=(mode==='already-full'?1:cycles+1),mode);
    if(mode==='fills')assert.equal(f.reads.at(-1)!.cargo_used,10,mode);
    if(mode==='reply-cargo-full')assert.equal(f.server.ship.cargo_used,4,mode);
  }
});

test('C7: depletion ends the step without failing, and a genuine failure names its cause',async()=>{
  const depletion=['depleted','resource_depleted','deposit_too_sparse','no_common_ores','no_resources'];
  const failures={
    closed:/closed/i,incapacitated:/incapacitated/i,moved:/belt/,
    transit:/transit/i,'docked-start':/dock/i,reject:/not_at_asteroid/,
  };
  for(const mode of [...depletion,'stall',...Object.keys(failures)]) {
    const f=fixture(mode==='docked-start'?{docked:'base'}:{});
    if(depletion.includes(mode))f.hooks.mine=cycle=>{
      if(cycle===2)throw new SpacemoltError(mode,`the site gives no more (${mode})`);
      return undefined;
    };
    // An over-claiming reply whose post-state never moved yields nothing and stops.
    if(mode==='stall')f.hooks.mine=cycle=>cycle===2?f.claim():undefined;
    if(mode==='closed')f.hooks.mine=cycle=>{
      if(cycle===2)throw new ConnectionClosedError('WebSocket connection closed');
      return undefined;
    };
    if(mode==='reject')f.hooks.mine=cycle=>{
      if(cycle===2)throw new SpacemoltError('not_at_asteroid','Not at a mining site');
      return undefined;
    };
    // The world moves with no command behind it: death, capture, or a fleet kick.
    const unsolicited=(change:()=>void)=>(cycle:number)=>{
      if(cycle!==2)return undefined;
      change();return f.claim();
    };
    if(mode==='incapacitated')f.hooks.mine=unsolicited(()=>{f.server.ship.incapacitated=true;});
    if(mode==='moved')f.hooks.mine=unsolicited(()=>{f.server.location.poi_id='other-belt';});
    if(mode==='transit')f.hooks.mine=unsolicited(()=>{f.server.location.in_transit=true;});

    const result=await f.run();
    const failing=Object.hasOwn(failures,mode);
    assert.equal(result.outcome,failing?'failed':'depleted',mode);
    assert.match(result.reason??'',failing?failures[mode as keyof typeof failures]:
      mode==='stall'?/no cargo change/i:new RegExp(mode),mode);

    if(mode==='docked-start') {
      // Named for an end state that cannot hold from a dock: nothing is sent at all.
      assert.deepEqual(f.calls,[],mode);
      assert.equal(result.cycles,0,mode);
      assert.deepEqual(result.yield,[],mode);
      continue;
    }
    // Whatever ended it, the cycle that did land keeps its measured take, and the
    // cycle that produced nothing contributes none of its claimed 99.
    assert.deepEqual(result.yield,takeAfter(1),mode);
    assert.equal(result.cycles,['stall','incapacitated','moved','transit'].includes(mode)?2:1,mode);
    assert.equal(f.calls.length,2,`${mode}: an ended step never re-sends`);
    assert.equal(f.server.ship.cargo_used,4,`${mode}: nothing was jettisoned or sold`);
  }
});
