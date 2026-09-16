/** The one door from a script to the rest of the game's commands.
 *
 * Two contracts, and they are the whole of what `command` promises: the rules are asked
 * before anything is sent, so a blocked check reaches the game with nothing; and what is
 * sent goes through the same seam a job's command goes through, so the shift's journal has
 * a `command` line for it and the operator can read what the script did.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {command} from './helpers.ts';
import {Blocked,type Ctx} from './ctx.ts';
import {journalCommand} from '../run-record.ts';

/** A ctx with the seam the bridge builds: every game command journalled as it is sent. */
function ctxWith(check:Ctx['check']) {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-helpers-'));
  const sent:{action:string;params:unknown}[]=[];
  const ctx={
    runtime,check,
    command:async(action:string,params:Record<string,unknown>|undefined)=>{
      sent.push({action,params});
      const reply={structuredContent:{kind:'bought',quantity:3}};
      journalCommand(runtime,action,params,true,reply);
      return reply;
    },
  } as unknown as Ctx;
  const journal=()=>readFileSync(join(runtime,'gameplay.jsonl'),'utf8')
    .trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  return {ctx,sent,journal};
}

test('command asks the rules, sends through the journalled seam, and returns the reply', async () => {
  const asked:string[]=[];
  const f=ctxWith(async job=>{asked.push(job);});
  const reply=await command(f.ctx,'spacemolt/buy',{id:'iron_ore',quantity:3}) as any;

  assert.deepEqual(asked,['spacemolt/buy'],'the rules are asked for the command by name');
  assert.deepEqual(f.sent,[{action:'spacemolt/buy',params:{id:'iron_ore',quantity:3}}]);
  assert.equal(reply.structuredContent.quantity,3,'the reply comes back whole');

  // The operator reads the shift as lines: a command a script sent is one of them.
  const line=f.journal().find(entry=>entry.event==='command');
  assert.ok(line,'the send left a command line in the journal');
  assert.deepEqual({tool:line.tool,action:line.action,ok:line.ok},
    {tool:'spacemolt',action:'buy',ok:true});
  assert.deepEqual(line.params,{id:'iron_ore',quantity:3});
});

test('a blocked rules check sends nothing at all', async () => {
  const f=ctxWith(async job=>{throw new Blocked(`${job} not started: threat seen`);});
  await assert.rejects(command(f.ctx,'spacemolt/buy',{id:'iron_ore',quantity:3}),/threat seen/);
  assert.deepEqual(f.sent,[],'the game was never reached');
  assert.throws(()=>f.journal(),'and nothing was written down');
});
