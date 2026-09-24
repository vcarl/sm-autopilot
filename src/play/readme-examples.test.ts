/** The play READMEs are the pilot's whole world knowledge, and their worked examples are what it
 * copies. An example that names a function the barrel does not export, or a field the lib does not
 * have, teaches a shape the pilot will keep writing until the gate refuses it — which is four
 * junctures of nothing (the live Trader shift, 2026-09-24). So every fenced `ts` block is a whole
 * `pilot/index.ts` and goes through the real gate: tsc, the import boundary, the policy. */
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {check,playDir} from '../run.ts';

const BLOCK=/^```ts\n([\s\S]*?)^```/gm;

/** Every README under `play/`, the root one first. */
function readmes(play:string):string[] {
  const nested=readdirSync(play,{withFileTypes:true}).filter(entry=>entry.isDirectory())
    .map(entry=>join(play,entry.name,'README.md')).filter(existsSync);
  return [join(play,'README.md'),...nested].sort();
}

test('every ts example in the play READMEs passes the gate a pilot file passes',async()=>{
  const play=playDir();
  const examples=readmes(play).flatMap(path=>
    [...readFileSync(path,'utf8').matchAll(BLOCK)].map(([,source],index)=>
      ({name:`${path.slice(play.length+1)}#${index+1}`,source:source!})));
  assert.ok(examples.length>=7,`found only ${examples.length} examples; the regex or the READMEs moved`);
  const gated=await Promise.all(examples.map(async({name,source})=>{
    const runtime=mkdtempSync(join(tmpdir(),'readme-example-'));
    mkdirSync(join(runtime,'pilot'),{recursive:true});
    writeFileSync(join(runtime,'pilot','index.ts'),source);
    return {name,gate:await check(runtime)};
  }));
  const bad=gated.filter(row=>!row.gate.ok);
  assert.deepEqual(bad.map(row=>`${row.name}: ${row.gate.errors.join(' | ')}`),[]);
});
