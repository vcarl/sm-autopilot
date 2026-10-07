/** `query`: a program that only reads, run beside the run on a binding of its own. Driven through
 * `serve` with the real gate, as `ask.test.ts` drives a run: every command it sends must be a query in
 * the lib's ACTIONS, a refused one never reaches the game, and it leaves no run.json behind. */
import type {Account} from '@spacemolt/lib';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serve,type Pilot} from './bridge.ts';
import {notAQuery,runQuery} from './query.ts';
import {readJournal,readRun} from './run-record.ts';
import {bridgeWorld} from './test-support/bridge-world.ts';

const PILOT:Pilot={name:'kvothe',stance:'Prospector'};
const program=(body:string)=>`import {account, ask, note} from 'play';\nexport default async function main(){\n${body}\n}\n`;

function harness() {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-query-'));
  const game=bridgeWorld({services:['refuel','repair']});
  const dispatch=serve(game.account as unknown as Account,game.command,{pilot:()=>PILOT,runtime,emit:()=>{}});
  const send=(action:string,params:Record<string,unknown>={})=>dispatch(action,params,()=>{}) as Promise<any>;
  const write=(dir:'pilot'|'query',source:string)=>{mkdirSync(join(runtime,dir),{recursive:true});writeFileSync(join(runtime,dir,'index.ts'),source);};
  const queries=()=>readJournal(runtime,10_000).filter(entry=>entry.event==='query');
  return {runtime,game,send,write,queries,close:()=>rmSync(runtime,{recursive:true,force:true})};
}

test('the rule is the lib\'s own: a query action passes, a mutation, an unknown action and login do not',()=>{
  assert.equal(notAQuery('spacemolt/get_system'),null);
  assert.equal(notAQuery('spacemolt_social/chat'),null,'the lib calls chat a query, and nothing else filters');
  assert.match(notAQuery('spacemolt/travel')??'',/not a read/);
  assert.match(notAQuery('spacemolt/no_such_thing')??'',/not a read/);
  for(const name of ['login','login_link','login_link_poll','login_token','logout','register'])
    assert.match(notAQuery(`spacemolt_auth/${name}`)??'',/not available in a query/);
  assert.match(notAQuery('spacemolt_battle/self_destruct')??'',/not available in a query/);
  // A craft's dry run moves nothing; the craft itself, and a dry_run that is not `true`, still do not pass.
  assert.equal(notAQuery('spacemolt/craft',{id:'refine_steel',dry_run:true}),null);
  assert.match(notAQuery('spacemolt/craft',{id:'refine_steel'})??'',/not a read/);
  assert.match(notAQuery('spacemolt/craft',{id:'refine_steel',dry_run:'true'})??'',/not a read/);
});

test('a query sends a craft\'s dry run, and returns a string as text',async()=>{
  // Live 2026-10-06 (kvothe, query b86b3973): every recipes() quote came back not_a_query.
  const f=harness();
  try {
    f.write('query',program("  const quote:any=await account().commands.spacemolt.craft({id:'refine_steel',quantity:1,dry_run:true});\n  return `quoted ${quote.delta.details.recipe}\\nline two`;"));
    const answer=await f.send('query');
    assert.equal(answer.ok,true,JSON.stringify(answer));
    assert.equal(answer.refused,undefined);
    assert.equal(f.game.count('spacemolt/craft'),1);
    assert.equal(answer.returned,'quoted Refine Steel\nline two');
  } finally {f.close();}
});

test('a query that reads answers with what main returned, journals one query line, and writes no run.json',async()=>{
  const f=harness();
  try {
    f.write('query',program("  const read:any=await account().commands.spacemolt_shipping.profile({});\n  note('read the profile');\n  return {tier:read.structuredContent.profile.tier};"));
    const answer=await f.send('query',{juncture:{juncture_id:'j1',at:null}});
    assert.equal(answer.ok,true,JSON.stringify(answer));
    assert.match(answer.returned,/"tier"/);
    assert.ok(answer.lines.includes('✎ read the profile'));
    assert.deepEqual(f.game.sent.map(call=>call.action),['spacemolt_shipping/profile']);
    assert.equal(readRun(f.runtime),null,'a query is not a run');
    const [line,...more]=f.queries();
    assert.equal(more.length,0);
    assert.equal(line?.juncture_id,'j1');
    assert.equal(line?.query_id,answer.query_id);
    assert.equal(line?.ok,true);
    assert.equal(line?.sha,answer.sha);
    // Every line it caused is joinable to it: the check, the note.
    const own=readJournal(f.runtime,10_000).filter(entry=>entry.query_id===answer.query_id).map(entry=>entry.event);
    assert.ok(own.includes('check')&&own.includes('line'),own.join(','));
    assert.ok(!readJournal(f.runtime,10_000).some(entry=>entry.event==='run'));
  } finally {f.close();}
});

test('the window\'s look: the record, the flight and the ship\'s log read from a query, sending nothing',async()=>{
  const f=harness();
  try {
    writeFileSync(join(f.runtime,'run.json'),JSON.stringify({script:'pilot/index.ts',started:'2026-10-06T00:00:00Z',ended:false,last_job:'tradeRun'}));
    writeFileSync(join(f.runtime,'gameplay.jsonl'),`${JSON.stringify({at:'2026-10-06T00:00:01Z',event:'rest',did:'docked and serviced'})}\n`);
    f.write('query',"import {flight, pilot, shipLog} from 'play';\nexport default async function main(){\n  return {pilot:pilot().stance,flight:flight()?.last_job,log:shipLog(5)};\n}\n");
    const answer=await f.send('query');
    assert.equal(answer.ok,true,JSON.stringify(answer));
    const read=JSON.parse(answer.returned);
    assert.equal(read.pilot,'Prospector');
    assert.equal(read.flight,'tradeRun');
    assert.ok(read.log.some((line:string)=>/rest/.test(line)),read.log);
    assert.deepEqual(f.game.sent,[],'a file read is no game command');
  } finally {f.close();}
});

test('a mutation through account().commands is refused by name and never sent',async()=>{
  const f=harness();
  try {
    f.write('query',program("  await account().commands.spacemolt.refuel({});\n  return 'refueled';"));
    const answer=await f.send('query');
    assert.equal(answer.ok,false);
    assert.match(answer.error,/spacemolt\/refuel is not a read/);
    assert.deepEqual(answer.refused,['spacemolt/refuel']);
    assert.equal(f.game.count('spacemolt/refuel'),0);
    assert.deepEqual(f.queries()[0]?.refused,['spacemolt/refuel']);
  } finally {f.close();}
});

test('account().send, .mutate and .query take the same rule, and the session controls are not a query\'s',async()=>{
  const f=harness();
  try {
    f.write('query',program([
      "  const said:string[]=[];",
      "  const tryIt=async(go:()=>Promise<unknown>)=>{try {await go();said.push('sent');} catch(e){said.push(String((e as Error).message));}};",
      "  await tryIt(()=>account().send('spacemolt','refuel',{}));",
      "  await tryIt(()=>account().mutate('spacemolt','refuel',{}));",
      "  await tryIt(()=>account().query('spacemolt_shipping','profile',{}));",
      "  await tryIt(()=>account().commands.spacemolt_auth.logout());",
      "  await tryIt(async()=>account().logout());",
      "  await tryIt(async()=>account().close());",
      "  await tryIt(()=>ask({question:'which?'}));",
      "  return said;"].join('\n')));
    const answer=await f.send('query');
    assert.equal(answer.ok,true,JSON.stringify(answer));
    const said=JSON.parse(answer.returned);
    assert.match(said[0],/refuel is not a read/);
    assert.match(said[1],/refuel is not a read/);
    assert.equal(said[2],'sent');
    assert.match(said[3],/spacemolt_auth\/logout is not available in a query/);
    assert.match(said[4],/account\(\)\.logout is not available in a query/);
    assert.match(said[5],/account\(\)\.close is not available in a query/);
    assert.match(said[6],/ask\(\) is not available in a query/);
    assert.deepEqual(f.game.sent.map(call=>call.action),['spacemolt_shipping/profile']);
  } finally {f.close();}
});

test('a query reads while the run waits on ask(), and leaves the run and its question as they were',async()=>{
  const f=harness();
  try {
    f.write('pilot',program("  const pick=await ask({question:'Which belt?',choices:['north','south']});\n  note(`picked ${pick}`);\n  return outcome(`went ${pick}`);").replace("import {account, ask, note}","import {ask, note, outcome}"));
    const paused=await f.send('run');
    assert.equal(paused.paused,true,JSON.stringify(paused));
    const before=readRun(f.runtime);
    f.write('query',program("  await account().commands.spacemolt_shipping.profile({});\n  return 'looked';"));
    const answer=await f.send('query');
    assert.equal(answer.ok,true,JSON.stringify(answer));
    assert.equal(answer.returned,'looked','a string is the pilot\'s own text, not JSON');
    assert.deepEqual(readRun(f.runtime),before,'run.json is the run\'s alone');
    const status=await f.send('status');
    assert.equal(status.question.question,'Which belt?','the run is still paused on its question');
    // Its lines carry its own key, never the paused run's.
    assert.equal(f.queries()[0]?.run_id,undefined);
    const ended=await f.send('answer',{answer:'north'});
    assert.equal(ended.did,'went north');
  } finally {f.close();}
});

test('a query that does not check comes back with the diagnostics and runs nothing',async()=>{
  const f=harness();
  try {
    f.write('query',"export default async function main(){ return nope; }\n");
    const answer=await f.send('query');
    assert.equal(answer.ok,false);
    assert.ok(answer.errors.some((line:string)=>line.includes("Cannot find name 'nope'")),answer.errors.join('\n'));
    assert.equal(f.game.sent.length,0);
    assert.equal(f.queries()[0]?.ok,false);
  } finally {f.close();}
});

test('a query reads beside a run that is flying, each on its own binding',async()=>{
  const f=harness();
  try {
    f.write('pilot',"import {account, outcome, stopped} from 'play';\nexport default async function main(){\n"+
      "  while(!stopped()){await account().commands.spacemolt_shipping.active();await new Promise(r=>setTimeout(r,10));}\n"+
      "  return outcome('watched');\n}\n");
    const flight=f.send('run');
    await new Promise(r=>setTimeout(r,300));
    const flying=await f.send('status');
    assert.equal(flying.running,true,JSON.stringify([flying,await Promise.race([flight,'pending'])]));
    f.write('query',program("  await account().commands.spacemolt_shipping.profile({});\n  await account().commands.spacemolt_shipping.profile({});\n  return 'looked';"));
    const answer=await f.send('query');
    assert.equal(answer.ok,true,JSON.stringify(answer));
    assert.equal(f.queries()[0]?.commands,2,'the query counts its own commands, not the run\'s');
    assert.equal((await f.send('status')).running,true,'the run flies on');
    await f.send('stop');
    assert.equal((await flight).did,'watched');
    assert.equal(f.game.count('spacemolt_shipping/profile'),2);
  } finally {f.close();}
});

test('a query is stopped at its cap, and code it left running can send nothing more',async()=>{
  const f=harness();
  try {
    f.write('query',program("  await new Promise(r=>setTimeout(r,200));\n  await account().commands.spacemolt_shipping.profile({});\n  return 'late';"));
    const answer=await runQuery({account:f.game.account as unknown as Account,command:f.game.command,pilot:()=>PILOT,runtime:f.runtime,capMs:50});
    assert.equal(answer.ok,false);
    assert.match(String(answer.error),/cap/);
    await new Promise(r=>setTimeout(r,300));
    assert.equal(f.game.sent.length,0,'the late read found nothing bound');
    assert.equal(f.queries()[0]?.capped,true);
  } finally {f.close();}
});

test('a query assigns, reassigns and recalls no freighter',async()=>{
  const f=harness();
  try {
    f.write('query',"import {recall} from 'play';\nexport default async function main(){ const out=await recall('hauler'); return [out.status,out.why]; }\n");
    const answer=await f.send('query');
    assert.equal(answer.ok,true,JSON.stringify(answer));
    assert.match(answer.returned,/refused.*a query only reads/);
  } finally {f.close();}
});
