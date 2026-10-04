import assert from 'node:assert/strict';
import test from 'node:test';
import {ConnectionClosedError,SpacemoltError,type MarketListingItem} from '@spacemolt/lib';
import {FILE_BYTES,fileIntel,fileRows,inFaction} from './trade-intel.ts';

const row=(item_id:string,best_buy:number,best_sell:number,qty=100)=>
  ({item_id,best_buy,best_buy_qty:qty,best_sell,best_sell_qty:qty}) as MarketListingItem;

test('a book too big for one report is cut to the cap, the two-sided rows kept first',()=>{
  // 716 one-sided rows is sol's live book, which dropped the connection; one two-sided row sits last.
  const book=[...Array.from({length:716},(_,i)=>row(`one_sided_item_${i}`,1000+i,0)),row('traded',5,6,1)];
  const rows=fileRows(book);
  assert.ok(rows.length<book.length,'trimmed');
  assert.ok(JSON.stringify(rows).length<=FILE_BYTES);
  assert.equal(rows[0]!.item_id,'traded','a bid and an ask outrank any one-sided value');
  assert.equal(rows[1]!.item_id,'one_sided_item_715','then by value on the book');
});

test('a filing that fails at one base does not stop the next, and is said once',async()=>{
  const sent:string[]=[],said:string[]=[];
  const command=async(_action:string,params:Record<string,unknown>)=>{
    const [station]=params.stations as {base_id:string}[];
    sent.push(station!.base_id);
    if(station!.base_id!=='ok_base')throw new SpacemoltError('rate_limited','slow down');
  };
  const account={state:{player:{faction_id:'guild'}}},book=[row('ore',10,12)];
  await fileIntel(account,command,'big_base',book,1,text=>said.push(text));
  await fileIntel(account,command,'big_base',book,1,text=>said.push(text));
  await fileIntel(account,command,'ok_base',book,1,text=>said.push(text));
  await fileIntel(account,command,'big_base',book,2,text=>said.push(text));
  assert.deepEqual(sent,['big_base','ok_base','big_base'],'the failed base waits for the next tick, no longer');
  assert.deepEqual(said,['trade intel not filed at big_base: spacemolt_intel/submit_trade_intel: rate_limited — slow down']);
});

// Live 2026-09-28 (kvothe): 152 filings refused `not_in_faction`, one per base per tick. Membership
// is in the account's state; with none there, nothing is sent, and the skip is said once.
test('a pilot in no faction files nothing, and is told once',async()=>{
  const sent:string[]=[],said:string[]=[];
  const command=async(action:string)=>{sent.push(action);};
  const book=[row('ore',10,12)];
  for(const account of [{state:{player:{credits:1}}},{state:{player:{credits:1}}}])
    for(const [base,tick] of [['a_base',1],['b_base',1],['a_base',2]] as const)
      await fileIntel(account,command,base,book,tick,text=>said.push(text));
  assert.deepEqual(sent,[]);
  assert.equal(said.length,1,said.join('\n'));
  assert.equal(inFaction({state:{player:{faction_id:'guild'}}}),true);
});

const guild={state:{player:{faction_id:'guild'}}};

test('a refusal is said with its action and code, and the next base still files',async()=>{
  const sent:string[]=[],said:string[]=[];
  const command=async(_action:string,params:Record<string,unknown>)=>{
    const [station]=params.stations as {base_id:string}[];
    sent.push(station!.base_id);
    if(station!.base_id==='a_base')throw new SpacemoltError('not_in_faction','no guild');
  };
  const account={...guild};
  await fileIntel(account,command,'a_base',[row('ore',10,12)],1,text=>said.push(text));
  await fileIntel(account,command,'b_base',[row('ore',10,12)],1,text=>said.push(text));
  assert.deepEqual(sent,['a_base','b_base']);
  assert.deepEqual(said,['trade intel not filed at a_base: spacemolt_intel/submit_trade_intel: not_in_faction — no guild']);
});

test('a lost reply is said as lost, not as a refusal',async()=>{
  const said:string[]=[];
  const command=async()=>{throw new ConnectionClosedError();};
  await fileIntel({...guild},command,'a_base',[row('ore',10,12)],1,text=>said.push(text));
  assert.deepEqual(said,['trade intel not filed at a_base: reply lost on spacemolt_intel/submit_trade_intel']);
});

test('a defect is not swallowed: the caller gets the thrown error',async()=>{
  const bug=new Error('bug');
  const command=async()=>{throw bug;};
  await assert.rejects(fileIntel({...guild},command,'a_base',[row('ore',10,12)],1),error=>error===bug);
});
