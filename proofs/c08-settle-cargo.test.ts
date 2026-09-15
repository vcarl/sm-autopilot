import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionClosedError,SpacemoltError} from '@spacemolt/lib';
import type {ReadinessAccount,ReadinessCommand} from '../src/readiness.ts';
import {settleCargo} from '../src/settle-cargo.ts';

// Recording handler-map pattern from the C5/C7 proofs. The server is independent of the
// cache: only refresh exposes it, so nothing production reads can be pushed at it.
// Every sell reply over-claims (9_999 credits for 99 units), so a `cleared` assertion
// below can only pass if the number came from the authoritative wallet and cargo deltas.
function fixture(opts:{credits?:number;storage?:boolean;prices?:Record<string,number>}={}) {
  const prices=opts.prices??{ore:10,carbon:4};
  const server={
    location:{system_id:'sol',poi_id:'dock',docked_at:'base' as string|null,in_transit:false},
    ship:{id:'ship',cargo_used:24,cargo_capacity:50},
    player:{credits:opts.credits??1_000},
    cargo:[{item_id:'ore',quantity:12},{item_id:'carbon',quantity:6},
      {item_id:'relic',quantity:4},{item_id:'cabin_economy',quantity:2}] as {item_id:string;quantity:number}[],
    storage:[] as {item_id:string;quantity:number}[],
  };
  const take=(item:string,quantity:number)=>{
    const row=server.cargo.find(current=>current.item_id===item);
    const moved=Math.min(row?.quantity??0,quantity);
    if(row) {
      row.quantity-=moved;
      if(!row.quantity)server.cargo=server.cargo.filter(current=>current!==row);
    }
    server.ship.cargo_used-=moved;
    return moved;
  };
  const credit=(amount:number)=>{server.player.credits+=amount;};
  const account:ReadinessAccount={state:structuredClone(server) as unknown as ReadinessAccount['state'],
    async refresh(){account.state=structuredClone(server) as unknown as ReadinessAccount['state'];}};
  const calls:{action:string;params:Record<string,unknown>}[]=[];
  const claim=(item_id:string)=>({command:'sell',delta:{details:{action:'sell',item_id,
    quantity_sold:99,total_earned:9_999,fills:[{price_each:9_999,quantity:99,subtotal:9_999}]}}});
  const sold=(item_id:string,quantity:number)=>{
    const moved=take(item_id,quantity);
    credit(moved*(prices[item_id]??0));
    return claim(item_id);
  };
  const hooks={sell:(_item:string,_quantity:number):unknown=>undefined,
    deposit:(_item:string,_quantity:number):unknown=>undefined};
  const handlers:Record<string,(params:any)=>unknown>={
    'spacemolt_market/view_market':()=>({delta:{details:{action:'view_market',base_id:'base',current_tick:7,
      items:Object.entries(prices).map(([item_id,buy_price])=>
        ({item_id,item_name:item_id,category:'raw',buy_price,buy_quantity:500,sell_price:buy_price*2,sell_quantity:0}))}}}),
    'spacemolt_storage/view':()=>{
      if(!(opts.storage??true))throw new SpacemoltError('no_storage','This station offers no storage');
      return {delta:{details:{action:'view_storage',base_id:'base',items:structuredClone(server.storage)}}};
    },
    'spacemolt/sell':params=>{
      const override=hooks.sell(String(params.id),Number(params.quantity));
      return override===undefined?sold(String(params.id),Number(params.quantity)):override;
    },
    'spacemolt_storage/deposit':params=>{
      const override=hooks.deposit(String(params.item_id),Number(params.quantity));
      if(override!==undefined)return override;
      const moved=take(String(params.item_id),Number(params.quantity));
      server.storage.push({item_id:String(params.item_id),quantity:moved});
      return {delta:{details:{action:'deposit_items',item_id:params.item_id,quantity:99,
        cargo_remaining:server.ship.cargo_used,cargo_space:50,storage_total:99}}};
    },
  };
  const command:ReadinessCommand=async(action,params)=>{
    calls.push({action,params:params??{}});
    assert.ok(Object.hasOwn(handlers,action),`Unexpected command: ${action}`);
    return handlers[action](params??{});
  };
  return {server,account,calls,hooks,take,credit,claim,prices,
    run:(keep:string[]=['cabin_economy'])=>settleCargo(account,command,{keep})};
}

const actions=(f:ReturnType<typeof fixture>)=>f.calls.map(call=>call.action);
const carried=(f:ReturnType<typeof fixture>,item:string)=>
  f.server.cargo.find(row=>row.item_id===item)?.quantity??0;

test('C8: quoted cargo sells, unquoted cargo is deposited or held, and keep cargo is never touched',async()=>{
  for(const storage of [true,false]) {
    const f=fixture({storage});
    const result=await f.run();

    // `quoted` is the price seen in the book before selling; `cleared` is the wallet
    // delta afterwards. The reply claimed 9_999 for 99 units and contributes neither.
    assert.deepEqual(result.sold,[
      {item_id:'carbon',quantity:6,quoted:24,cleared:24},
      {item_id:'ore',quantity:12,quoted:120,cleared:120},
    ],`storage=${storage}`);
    assert.deepEqual(result.unsettled,[],`storage=${storage}`);
    assert.equal(result.credits_before,1_000,`storage=${storage}`);
    assert.equal(result.credits_after,1_144,`storage=${storage}`);

    // The station will not buy a relic. With storage it is deposited; without, it is held
    // and no command is issued for it at all.
    assert.deepEqual(result.deposited,storage?[{item_id:'relic',quantity:4}]:[],`storage=${storage}`);
    assert.deepEqual(result.held,storage?[]:[{item_id:'relic',quantity:4}],`storage=${storage}`);
    assert.equal(carried(f,'relic'),storage?0:4,`storage=${storage}`);

    // Starting cargo the caller listed is never sold and never deposited: no command
    // names it, and every unit is still in the hold.
    assert.equal(carried(f,'cabin_economy'),2,`storage=${storage}`);
    assert.ok(f.calls.every(call=>!Object.values(call.params).includes('cabin_economy')),`storage=${storage}`);
    assert.ok([...result.sold,...result.deposited,...result.held,...result.unsettled]
      .every(row=>row.item_id!=='cabin_economy'),`storage=${storage}`);

    // The book is read once, before any money moves, and storage is probed only when
    // something the station will not buy turns up.
    assert.deepEqual(actions(f),['spacemolt_market/view_market','spacemolt/sell','spacemolt/sell',
      'spacemolt_storage/view',...storage?['spacemolt_storage/deposit']:[]],`storage=${storage}`);
    assert.equal(actions(f).indexOf('spacemolt_market/view_market'),0,`storage=${storage}`);
    // Each sale names its own item and the quantity actually carried.
    assert.deepEqual(f.calls.filter(call=>call.action==='spacemolt/sell').map(call=>call.params),
      [{id:'carbon',quantity:6},{id:'ore',quantity:12}],`storage=${storage}`);
  }

  // Nothing but keep cargo: a settled hold sends no mutation at all (S42).
  const empty=fixture();
  empty.server.cargo=[{item_id:'cabin_economy',quantity:2}];
  empty.server.ship.cargo_used=2;
  const settled=await empty.run();
  assert.deepEqual([settled.sold,settled.deposited,settled.held,settled.unsettled],[[],[],[],[]]);
  assert.deepEqual(actions(empty),['spacemolt_market/view_market']);
  assert.equal(settled.credits_before,settled.credits_after);
});

test('C8: a sale the post-state does not confirm is unsettled, and a lost reply is reconciled',async()=>{
  const modes=['credits-unchanged','cargo-unchanged','rejected','lost-landed','lost-nothing',
    'lost-partial','deposit-unchanged','deposit-lost-landed','deposit-lost-nothing'] as const;
  for(const mode of modes) {
    const f=fixture();
    // Only the ore sale misbehaves; carbon clears normally either side of it, so a
    // gap in one item can never be smeared over the rest of the settlement.
    if(mode==='credits-unchanged')f.hooks.sell=item=>item==='ore'?(f.take('ore',12),f.claim('ore')):undefined;
    if(mode==='cargo-unchanged')f.hooks.sell=item=>item==='ore'?(f.credit(120),f.claim('ore')):undefined;
    if(mode==='rejected')f.hooks.sell=item=>{
      if(item!=='ore')return undefined;
      throw new SpacemoltError('no_buyers','Nobody is buying ore here');
    };
    // The sale landed; only the reply was lost. Reconcile from state, never re-send.
    if(mode==='lost-landed')f.hooks.sell=item=>{
      if(item!=='ore')return undefined;
      f.take('ore',12);f.credit(120);
      throw new ConnectionClosedError('WebSocket connection closed');
    };
    // Nothing moved: exactly one re-issue, which clears.
    let attempts=0;
    if(mode==='lost-nothing')f.hooks.sell=item=>{
      if(item!=='ore')return undefined;
      if(++attempts===1)throw new ConnectionClosedError('WebSocket connection closed');
      return undefined;
    };
    // Cargo gone but the wallet never moved: neither cleared nor safe to re-send.
    if(mode==='lost-partial')f.hooks.sell=item=>{
      if(item!=='ore')return undefined;
      f.take('ore',12);
      throw new ConnectionClosedError('WebSocket connection closed');
    };
    if(mode==='deposit-unchanged')f.hooks.deposit=item=>item==='relic'?
      {delta:{details:{action:'deposit_items',item_id:'relic',quantity:4,storage_total:4}}}:undefined;
    if(mode==='deposit-lost-landed')f.hooks.deposit=item=>{
      if(item!=='relic')return undefined;
      f.take('relic',4);
      throw new ConnectionClosedError('WebSocket connection closed');
    };
    let deposits=0;
    if(mode==='deposit-lost-nothing')f.hooks.deposit=item=>{
      if(item!=='relic')return undefined;
      if(++deposits===1)throw new ConnectionClosedError('WebSocket connection closed');
      return undefined;
    };

    const result=await f.run();
    const sells=f.calls.filter(call=>call.action==='spacemolt/sell').length;
    const deposited=f.calls.filter(call=>call.action==='spacemolt_storage/deposit').length;

    // Carbon is untouched by any of this: it clears in every mode.
    assert.deepEqual(result.sold.filter(row=>row.item_id==='carbon'),
      [{item_id:'carbon',quantity:6,quoted:24,cleared:24}],mode);

    // A gap in the deposit leg never taints the sale leg: ore still clears there.
    const cleared=['lost-landed','lost-nothing'].includes(mode)||mode.startsWith('deposit');
    assert.deepEqual(result.sold.filter(row=>row.item_id==='ore'),
      cleared?[{item_id:'ore',quantity:12,quoted:120,cleared:120}]:[],mode);
    // A lost reply costs at most one re-issue, and only when the post-state moved nothing.
    assert.equal(sells,mode==='lost-nothing'?3:2,mode);

    if(!cleared) {
      assert.equal(result.unsettled.length,1,mode);
      const gap=result.unsettled[0]!;
      assert.equal(gap.item_id,'ore',mode);
      assert.equal(gap.quantity,12,mode);
      // The quote survives into the refusal: an unsettled row still says what was offered.
      assert.equal(gap.quoted,120,mode);
      assert.match(gap.gap,mode==='rejected'?/no_buyers/:/cargo|credits/,mode);
      // Credits reported are the wallet's, not the sale's claim.
      assert.equal(result.credits_after,f.server.player.credits,mode);
    }

    if(mode.startsWith('deposit')) {
      const landed=mode!=='deposit-unchanged';
      assert.deepEqual(result.deposited,landed?[{item_id:'relic',quantity:4}]:[],mode);
      assert.equal(deposited,mode==='deposit-lost-nothing'?2:1,mode);
      if(!landed) {
        assert.deepEqual(result.unsettled.map(row=>row.item_id),['relic'],mode);
        assert.equal(result.unsettled[0]!.quoted,null,mode);
        assert.equal(carried(f,'relic'),4,mode);
      }
    }
    // Keep cargo survives every failure path untouched.
    assert.equal(carried(f,'cabin_economy'),2,mode);
    assert.equal(f.server.ship.id,'ship',mode);
  }
});

test('C8: settling requires an authoritative docked read, and drift stops it mid-hold',async()=>{
  // An undocked ship has no counter to settle at, and a cache claiming otherwise is
  // not a read: nothing is sent.
  const undocked=fixture();
  undocked.server.location.docked_at=null;
  undocked.account.state.location!.docked_at='base';
  await assert.rejects(undocked.run(),/dock/i);
  assert.deepEqual(actions(undocked),[]);

  const noWallet=fixture();
  delete (noWallet.server as {player?:unknown}).player;
  await assert.rejects(noWallet.run(),/wallet|credits/i);
  assert.deepEqual(actions(noWallet),[]);

  // The world moves with no command behind it. Carbon already cleared, so its sale is
  // still reported; the rest of the hold is unsettled with the drift named, and no
  // further command is sent.
  for(const [mode,pattern] of [['undocked',/dock/i],['ship',/ship/i]] as const) {
    const f=fixture();
    f.hooks.sell=item=>{
      if(item!=='carbon')return undefined;
      const reply=f.claim('carbon');
      f.take('carbon',6);f.credit(24);
      if(mode==='undocked')f.server.location.docked_at=null;
      else f.server.ship.id='other-ship';
      return reply;
    };
    const result=await f.run();
    assert.deepEqual(result.sold,[{item_id:'carbon',quantity:6,quoted:24,cleared:24}],mode);
    assert.deepEqual(result.unsettled.map(row=>row.item_id),['ore','relic'],mode);
    assert.ok(result.unsettled.every(row=>pattern.test(row.gap)),mode);
    assert.deepEqual(actions(f),['spacemolt_market/view_market','spacemolt/sell'],mode);
    assert.equal(carried(f,'ore'),12,mode);
  }
});
