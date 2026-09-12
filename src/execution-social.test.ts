import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executionFixture as fixture} from './execution-fixture.ts';
import {ExecutionHost,maxChatContent} from './execution-host.ts';

const host=async(t:any)=>{
  const f=fixture(t);
  const execution=new ExecutionHost(f.account,f.directory);
  await execution.dispatch('execution/configure',{objective:'Coordinate with nearby pilots'});
  return {f,execution};
};

test('outbound chat refuses unusable or unaddressed messages and records one durable receipt',async t=>{
  const {f,execution}=await host(t);
  await assert.rejects(execution.dispatch('social/send',{content:'   ',target:'local'}),/nonempty/);
  await assert.rejects(execution.dispatch('social/send',{content:'hello',target:'private'}),/target_id/);
  await assert.rejects(execution.dispatch('social/send',{content:'x'.repeat(maxChatContent+1),target:'local'}),/exceeds/);
  await assert.rejects(execution.dispatch('social/send',{content:'hello',target:'broadcast'}),/target must be/);
  assert.equal(f.calls.filter(call=>call.key.startsWith('spacemolt_social/')).length,0);
  const receipt:any=await execution.dispatch('social/send',{content:'  Trading at base  ',target:'local'});
  assert.equal(receipt.status,'sent');
  assert.equal(receipt.content,'Trading at base');
  assert.equal(receipt.target,'local');
  assert.ok(Date.parse(receipt.sent_at)>0);
  const sent=f.calls.filter(call=>call.key==='spacemolt_social/chat');
  assert.equal(sent.length,1);
  assert.deepEqual(sent[0].params,{content:'Trading at base',target:'local'});
});

test('chat never carries an environment value, and the inbox normalises whatever the game returns',async t=>{
  const {f,execution}=await host(t);
  process.env.SPACEMOLT_TEST_SECRET='swordfish-9182';
  t.after(()=>{delete process.env.SPACEMOLT_TEST_SECRET;});
  await assert.rejects(execution.dispatch('social/send',{content:'my key is swordfish-9182',target:'local'}),/environment value/);
  const send=f.account.send.bind(f.account);
  f.account.send=async(tool:string,action:string,params:any)=>{
    if(action==='get_chat_history')return {structuredContent:{messages:[{from:'other-pilot',message:'docking soon',sent_at:'2026-09-11T00:00:00Z'}]}} as any;
    return send(tool,action,params);
  };
  await assert.rejects(execution.dispatch('social/inbox',{target:'local',limit:0}),/limit/);
  const inbox:any=await execution.dispatch('social/inbox',{target:'local'});
  assert.deepEqual(inbox.messages,[{sender:'other-pilot',target:'local',content:'docking soon',timestamp:'2026-09-11T00:00:00Z'}]);
});
