import assert from 'node:assert/strict';
import test from 'node:test';
import {ConnectionClosedError,SpacemoltError} from '@spacemolt/lib';
import {Effect} from 'effect';
import {settleCargoEffect} from './settle-cargo.ts';
import {GameLive,Rejected,ReplyLost} from './play/game.ts';
import {FakeLibGoalAccount} from './test-support/fake-lib-account.ts';

type Server={ship:{id:string;cargo_capacity:number};location:{docked_at:string};player:{credits:number};cargo:{item_id:string;quantity:number}[]};
type Fake=FakeLibGoalAccount<Server>;
type Handlers={
  /** What the station buys, item to price; absent items are not bought. */
  book?:Record<string,number>;
  market?:()=>unknown;
  sell?:(fake:Fake,id:string,quantity:number)=>unknown;
  view?:(fake:Fake)=>unknown;
  deposit?:(fake:Fake,id:string,quantity:number)=>unknown;
};
/** A docked ship holding `cargo`. Each handler is the server's answer: it may change the world and then throw. */
const world=(cargo:Server['cargo'],h:Handlers={})=>{
  const fake:Fake=new FakeLibGoalAccount<Server>({ship:{id:'s1',cargo_capacity:100},location:{docked_at:'sol_base'},player:{credits:100},cargo},{
    spacemolt_market:{view_market:()=>h.market?.()??({structuredContent:{items:Object.entries(h.book??{}).map(([item_id,buy_price])=>({item_id,buy_price}))}})},
    spacemolt:{sell:p=>(h.sell??pays)(fake,String(p?.id),Number(p?.quantity))},
    spacemolt_storage:{view:()=>h.view?.(fake)??{structuredContent:{items:[]}},deposit:p=>(h.deposit??stows)(fake,String(p?.item_id),Number(p?.quantity))},
  });
  const send=(action:string,params:Record<string,unknown>)=>{const [tool='',name='']=action.split('/');return fake.send(tool,name,params);};
  const count=(action:string)=>fake.calls.filter(c=>c.action===action).length;
  return {fake,send,count};
};
const take=(fake:Fake,id:string,quantity:number)=>{
  const row=fake.server.cargo.find(r=>r.item_id===id);
  if(row)row.quantity-=quantity;
  fake.server.cargo=fake.server.cargo.filter(r=>r.quantity>0);
};
const pays=(fake:Fake,id:string,quantity:number)=>{take(fake,id,quantity);fake.server.player.credits+=quantity*5;return {ok:true};};
const stows=(fake:Fake,id:string,quantity:number)=>{take(fake,id,quantity);return {ok:true};};
const live=(w:ReturnType<typeof world>)=>GameLive({send:w.send,refresh:()=>w.fake.refresh()});
const settle=(w:ReturnType<typeof world>,options?:{keep?:string[]})=>Effect.runPromise(settleCargoEffect(w.fake,options).pipe(Effect.provide(live(w))));
const failure=(w:ReturnType<typeof world>)=>Effect.runPromise(Effect.flip(settleCargoEffect(w.fake)).pipe(Effect.provide(live(w))));
const ore=[{item_id:'ore',quantity:10}];

test('a sale the post-state confirms is sold, with the quote and the cleared delta',async()=>{
  const out=await settle(world(ore,{book:{ore:4}}));
  assert.deepEqual(out.sold,[{item_id:'ore',quantity:10,quoted:40,cleared:50}]);
  assert.deepEqual(out.unsettled,[]);
  assert.equal(out.credits_after,150);
});

test('a refused sale is unsettled with the refusal, and the next item still settles',async()=>{
  const w=world([{item_id:'gold',quantity:2},...ore],{book:{ore:4,gold:9},
    sell:(fake,id,quantity)=>{if(id==='gold')throw new SpacemoltError('in_battle','cannot trade in combat');return pays(fake,id,quantity);}});
  const out=await settle(w);
  assert.deepEqual(out.unsettled,[{item_id:'gold',quantity:2,quoted:18,gap:'in_battle: cannot trade in combat'}]);
  assert.deepEqual(out.sold.map(r=>r.item_id),['ore']);
  assert.equal(w.count('sell'),2);
});

test('a reply lost after the sale landed is cleared by the read, and not re-sent',async()=>{
  const w=world(ore,{book:{ore:4},sell:(fake,id,quantity)=>{pays(fake,id,quantity);throw new ConnectionClosedError('closed');}});
  const out=await settle(w);
  assert.deepEqual(out.sold,[{item_id:'ore',quantity:10,quoted:40,cleared:50}]);
  assert.equal(w.count('sell'),1);
});

test('a reply lost with nothing moved is unsettled with the cause, and not re-sent',async()=>{
  for(const lost of [new ConnectionClosedError('closed'),new SpacemoltError('mutation_timeout','no result')]) {
    const w=world(ore,{book:{ore:4},sell:()=>{throw lost;}});
    const out=await settle(w);
    assert.deepEqual(out.unsettled,[{item_id:'ore',quantity:10,quoted:40,
      gap:`sale did not clear: cargo -0, credits +0 after ${lost instanceof SpacemoltError?lost.code:lost.name}: ${lost.message}`}]);
    assert.equal(w.count('sell'),1);
  }
});

test('an item the station will not buy is stowed when there is storage, and held when there is not',async()=>{
  const stowed=world(ore,{});
  const out=await settle(stowed);
  assert.deepEqual(out.deposited,[{item_id:'ore',quantity:10}]);
  for(const view of [()=>{throw new SpacemoltError('no_storage','no storage here');},()=>{throw new ConnectionClosedError('closed');},()=>({structuredContent:{}})]) {
    const w=world(ore,{view});
    assert.deepEqual((await settle(w)).held,[{item_id:'ore',quantity:10}]);
    assert.equal(w.count('deposit'),0);
  }
});

test('a deposit whose reply is lost is unsettled with the cause, and not re-sent',async()=>{
  const w=world(ore,{deposit:()=>{throw new SpacemoltError('mutation_timeout','no result');}});
  const out=await settle(w);
  assert.deepEqual(out.unsettled,[{item_id:'ore',quantity:10,quoted:null,gap:'deposit did not clear: cargo -0, credits +0 after mutation_timeout: no result'}]);
  assert.equal(w.count('deposit'),1);
});

test('a refused deposit is unsettled with the refusal',async()=>{
  const w=world(ore,{deposit:()=>{throw new SpacemoltError('storage_full','no room');}});
  assert.deepEqual((await settle(w)).unsettled,[{item_id:'ore',quantity:10,quoted:null,gap:'storage_full: no room'}]);
});

test('a market that cannot be read fails the composite with the refusal, and nothing is sent',async()=>{
  const w=world(ore,{market:()=>{throw new SpacemoltError('not_docked','not docked');}});
  const failed=await failure(w);
  assert.ok(failed instanceof Rejected&&failed.code==='not_docked');
  assert.equal(w.count('sell')+w.count('deposit'),0);
});

test('a refresh that fails after a send fails the composite, with no further send',async()=>{
  const lost=new ConnectionClosedError('canonical refresh lost');
  const w=world([{item_id:'gold',quantity:2},...ore],{book:{ore:4,gold:9},sell:(fake,id,quantity)=>{pays(fake,id,quantity);fake.refresh=async()=>{throw lost;};}});
  const failed=await failure(w);
  assert.ok(failed instanceof ReplyLost&&failed.cause===lost);
  assert.equal(w.count('sell'),1);
});

test('a plain Error from the seam is a defect, and goes up raw',async()=>{
  const raised=new Error('bug');
  const w=world(ore,{book:{ore:4},sell:()=>{throw raised;}});
  await assert.rejects(settle(w),/bug/);
  assert.equal(w.count('sell'),1);
  const stor=world(ore,{view:()=>{throw raised;}});
  await assert.rejects(settle(stor),/bug/);
});

test('items on keep are never offered',async()=>{
  const w=world(ore,{book:{ore:4}});
  const out=await settle(w,{keep:['ore']});
  assert.deepEqual([out.sold,out.deposited,out.held,out.unsettled],[[],[],[],[]]);
  assert.equal(w.count('sell'),0);
});
