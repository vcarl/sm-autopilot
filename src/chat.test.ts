/** Chat: frames kept as raw facts, a declared post pausing a run the way `ask()` does, and sends
 * that keep the game's refusal and are never re-sent. Driven through `serve` with the real runner
 * and gate over a bridge world, as `ask.test.ts` is. */
import type {Account} from '@spacemolt/lib';
import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serve,type Pilot} from './bridge.ts';
import {CHAT_FILE,chatJournal} from './chat.ts';
import {journalCommand,readJournal,readRun} from './run-record.ts';
import {bridgeWorld,type WorldOptions} from './test-support/bridge-world.ts';

const PILOT:Pilot={name:'kvothe',stance:'Prospector'};
const DM=(text:string,sender='Zed')=>({channel:'private',content:text,sender,sender_id:`p-${sender.toLowerCase()}`,
  target_id:'p-me',timestamp:'2026-10-04T12:00:00Z'});

/** Reads until something paused it and was answered, then says what it heard. Bounded, so a run
 * nothing interrupts ends on its own. */
const LISTENS=(declare:string)=>"import {heard, messages, note, outcome, stopped} from 'play';\n"+declare+
  "export default async function main(){\n"+
  "  for(let i=0;i<5&&!stopped();i++){\n"+
  "    await messages();\n"+
  "    const got=heard();\n"+
  "    for(const h of got) note(`heard ${h.chat.from} on ${h.chat.channel}: ${h.chat.text} -> ${h.answer}`);\n"+
  "    if(got.length) return outcome(`heard ${got.length}`);\n"+
  "  }\n"+
  "  return outcome('nothing heard');\n"+
  "}\n";
const ZED="export const interrupts = {from: ['zed'], channels: ['private' as const]};\n";

/** `first`: posts pushed while the run's first command is on the wire — after the module loaded and
 * its `interrupts` was read, as a post arriving mid-run is. */
function harness(source:string,world:WorldOptions={},onLine?:(text:string,game:ReturnType<typeof bridgeWorld>)=>void,first:unknown[]=[]) {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-chat-'));
  mkdirSync(join(runtime,'pilot'),{recursive:true});
  writeFileSync(join(runtime,'pilot','index.ts'),source);
  const game=bridgeWorld(world);
  chatJournal(game.account as unknown as Account,runtime);
  const lines:string[]=[];
  let fired=false;
  const command:typeof game.command=async(action,params)=>{
    if(!fired) {fired=true;for(const post of first)game.pushChat(post);}
    // Journalled as main() journals every command, so a test can read where it lands.
    const reply=await game.command(action,params);
    journalCommand(runtime,action,params,true,reply);
    return reply;
  };
  const dispatch=serve(game.account as unknown as Account,command,
    {pilot:()=>PILOT,runtime,emit:text=>{lines.push(text);onLine?.(text,game);}});
  const send=(action:string,params:Record<string,unknown>={})=>dispatch(action,params,()=>{}) as Promise<any>;
  const chatLines=()=>existsSync(join(runtime,CHAT_FILE))
    ?readFileSync(join(runtime,CHAT_FILE),'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  return {runtime,game,lines,send,chatLines,journal:(event:string)=>readJournal(runtime,10_000).filter(row=>row.event===event),
    close:()=>rmSync(runtime,{recursive:true,force:true})};
}

test('a chat_message frame becomes a post line in chat.jsonl: the raw facts, nothing judged',()=>{
  const f=harness(LISTENS(''));
  try {
    f.game.pushChat({...DM('meet at the belt'),poi_id:'belt'});
    const [post]=f.chatLines();
    assert.equal(post.event,'post');
    assert.equal(post.channel,'private');
    assert.equal(post.content,'meet at the belt');
    assert.equal(post.sender,'Zed');
    assert.equal(post.sender_id,'p-zed');
    assert.equal(post.poi_id,'belt');
    assert.equal(post.sent_at,'2026-10-04T12:00:00Z');
    assert.ok(Date.parse(post.at));
  } finally {f.close();}
});

test('an undecodable frame is journalled, never a crash and never a defect',()=>{
  const f=harness(LISTENS(''));
  try {
    f.game.pushChat('not a frame');
    f.game.pushChat({sender:'Zed',content:'no channel'});
    f.game.pushChat({channel:7});
    assert.equal(f.journal('chat_undecodable').length,3);
    assert.equal(f.journal('defect').length,0);
    assert.deepEqual(f.chatLines(),[]);
  } finally {f.close();}
});

test('a declared DM pauses the run between commands; answer resumes it and the program reads it with heard()',async()=>{
  const f=harness(LISTENS(ZED),{},undefined,[DM('need fuel?')]);
  try {
    const paused=await f.send('run');
    assert.equal(paused.paused,true,JSON.stringify(paused));
    assert.deepEqual(paused.question.chat,{from:'Zed',channel:'private',text:'need fuel?',at:'2026-10-04T12:00:00Z',sender_id:'p-zed'});
    assert.equal(readRun(f.runtime)!.question?.chat?.text,'need fuel?','run.json keeps it for the gate');
    // A safe point: the command it paused after had finished, and nothing is on the wire.
    assert.equal((await f.send('status')).pending,undefined);
    const ended=await f.send('answer',{answer:'replied; carry on'});
    assert.equal(ended.status,'done');
    assert.equal(ended.did,'heard 1');
    assert.ok(f.lines.includes('✎ heard Zed on private: need fuel? -> replied; carry on'),f.lines.join('\n'));
    const [started]=f.journal('run').filter(row=>row.phase==='started');
    const [declared]=f.journal('interrupts');
    assert.deepEqual(declared!.interrupts,{from:['zed'],channels:['private']},'the declaration is journalled as read');
    assert.equal(declared!.run_id,started!.run_id);
    assert.equal(f.journal('chat_interrupt').length,1);
  } finally {f.close();}
});

test('two DMs while paused are both delivered, one pause each, in order',async()=>{
  let paused=false;
  const f=harness(LISTENS(ZED),{},(text,game)=>{
    if(text.startsWith('? paused')&&!paused){paused=true;game.pushChat(DM('two'));game.pushChat(DM('three','Ann'));}
  },[DM('one')]);
  try {
    const first=await f.send('run');
    assert.equal(first.question.chat.text,'one');
    const second=await f.send('answer',{answer:'a'});
    assert.equal(second.paused,true,JSON.stringify(second));
    assert.equal(second.question.chat.text,'two','queued while paused, not lost');
    const ended=await f.send('answer',{answer:'b'});
    assert.equal(ended.did,'heard 2');
    assert.ok(f.lines.includes('✎ heard Zed on private: one -> a'));
    assert.ok(f.lines.includes('✎ heard Zed on private: two -> b'));
    assert.equal(f.chatLines().length,3,'every post is kept, matching or not');
  } finally {f.close();}
});

test('a post the declaration does not name never pauses the run',async()=>{
  const f=harness(LISTENS(ZED),{},undefined,[DM('hello','Ann'),{...DM('local zed'),channel:'local'}]);
  try {
    const ended=await f.send('run');
    assert.equal(ended.paused,undefined);
    assert.equal(ended.did,'nothing heard');
  } finally {f.close();}
});

test('a run that declares nothing never pauses, whatever arrives',async()=>{
  const f=harness(LISTENS(''),{},undefined,[DM('anyone?')]);
  try {
    const ended=await f.send('run');
    assert.equal(ended.paused,undefined);
    assert.equal(ended.did,'nothing heard');
    assert.equal(f.journal('interrupts')[0]!.interrupts,null);
  } finally {f.close();}
});

test('a declaration that does not read is said and interrupts nothing; the run still flies',async()=>{
  const f=harness(LISTENS("export const interrupts = {channels: ['nowhere']};\n"),{},undefined,[DM('hi')]);
  try {
    const ended=await f.send('run');
    assert.equal(ended.did,'nothing heard');
    assert.ok(f.lines.some(line=>line.startsWith('interrupts not read')),f.lines.join('\n'));
  } finally {f.close();}
});

test('an empty declaration pauses for a private message only: local, system and global posts never pause it',async()=>{
  const f=harness(LISTENS('export const interrupts = {};\n'),{},undefined,
    [{...DM('local'),channel:'local'},{...DM('system'),channel:'system'},{...DM('global'),channel:'global'},DM('a dm','Ann')]);
  try {
    const paused=await f.send('run');
    assert.equal(paused.question.chat.text,'a dm',JSON.stringify(paused));
    const ended=await f.send('answer',{answer:'ok'});
    assert.equal(ended.did,'heard 1');
    assert.equal(f.journal('chat_interrupt').length,1);
  } finally {f.close();}
});

test('a stop while paused on a message ends the run partial, with no defect and nothing heard',async()=>{
  const f=harness("import {messages} from 'play';\nexport const interrupts = {};\n"+
    "export default async function main(){\n"+
    "  for(let i=0;i<5;i++){const read=await messages(); if(read.status!=='done') return read;}\n"+
    "  return messages();\n"+
    "}\n",{},undefined,[DM('wait')]);
  try {
    const ran=await f.send('run');
    assert.equal(ran.paused,true,JSON.stringify(ran));
    const stopped=await f.send('stop');
    assert.equal(stopped.stopping,true);
    assert.equal(stopped.withdrawn.chat.text,'wait');
    assert.equal(stopped.status,'partial',JSON.stringify(stopped));
    assert.equal(f.journal('defect').length,0);
    assert.equal(readRun(f.runtime)!.question,undefined);
  } finally {f.close();}
});

test('a command at the top level of the program follows run started and carries its run_id',async()=>{
  const f=harness("import {messages, outcome} from 'play';\nawait messages();\n"+
    "export default async function main(){return outcome('loaded');}\n");
  try {
    assert.equal((await f.send('run')).did,'loaded');
    const rows=readJournal(f.runtime,10_000);
    const start=rows.findIndex(row=>row.event==='run'&&row.phase==='started');
    const sent=rows.findIndex(row=>row.event==='command');
    assert.ok(start>=0&&sent>start,rows.map(row=>`${row.event}:${row.phase??''}`).join(' '));
    assert.equal(rows[sent]!.run_id,rows[start]!.run_id);
    assert.ok(rows[sent]!.run_id);
  } finally {f.close();}
});

const SAYS="import {chat, outcome} from 'play';\n"+
  "export default async function main(){\n"+
  "  const said=await chat('private','on my way','p-zed');\n"+
  "  return outcome(`${said.status}: ${said.why??said.detail.message}`, said.status);\n"+
  "}\n";

test('chat() sends once and keeps the sent line',async()=>{
  const f=harness(SAYS);
  try {
    assert.equal((await f.send('run')).did,'done: Message sent to private');
    assert.deepEqual(f.game.chats,[{target:'private',content:'on my way',target_id:'p-zed'}]);
    assert.deepEqual(f.chatLines().map(row=>[row.event,row.channel,row.content,row.target_id]),
      [['sent','private','on my way','p-zed']]);
  } finally {f.close();}
});

test('a refused chat keeps the game code in the Outcome',async()=>{
  const f=harness(SAYS,{chat:{refuse:'muted'}});
  try {
    const ended=await f.send('run');
    assert.equal(ended.status,'refused');
    assert.match(ended.did,/^refused: spacemolt_social\/chat: muted/);
    assert.deepEqual(f.chatLines(),[],'nothing landed, nothing recorded as sent');
  } finally {f.close();}
});

test('a chat whose reply is lost is never re-sent',async()=>{
  const f=harness(SAYS,{chat:{lose:true}});
  try {
    const ended=await f.send('run');
    assert.equal(ended.status,'failed');
    assert.match(ended.did,/reply lost/);
    assert.equal(f.game.count('spacemolt_social/chat'),1,'sent once, never repeated');
  } finally {f.close();}
});

test('messages() reads the history on the fields it uses; a row that does not read is left out and said',async()=>{
  const f=harness("import {messages, note, outcome} from 'play';\n"+
    "export default async function main(){\n"+
    "  const read=await messages({channel:'local'});\n"+
    "  for(const m of read.detail.messages) note(`${m.sender}: ${m.content}`);\n"+
    "  return read;\n"+
    "}\n",{chat:{history:[{id:'m1',channel:'local',content:'selling ore',sender:'Ann',sender_id:'p-ann',timestamp_utc:'2026-10-04T11:00:00Z'},
    {id:'m2',channel:'local',sender:'Bo'}]}});
  try {
    const ended=await f.send('run');
    assert.equal(ended.status,'done');
    assert.ok(f.lines.includes('✎ Ann: selling ore'));
    assert.ok(f.lines.some(line=>line.includes('a message (m2) did not read')),f.lines.join('\n'));
  } finally {f.close();}
});
