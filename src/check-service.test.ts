/** The warm checker must say exactly what `tsc` says: the pilot reads its errors, and `framed()`
 * parses them. Every README example (as readme-examples.test.ts finds them) and one broken file
 * go through both paths. */
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {check,playDir} from './run.ts';

const BLOCK=/^```ts\n([\s\S]*?)^```/gm;
const BROKEN=`import {goTo} from 'play';\nconst n:number='three';\nexport async function main(){return goTo(42);}\n`;
// Live 2026-09-30 (run 058d3387): a type imported as a value passed tsc and died at load.
const TYPE_AS_VALUE=`import {Outcome,orient} from 'play';\nexport default async function main():Promise<Outcome|undefined>{ await orient(); stopped(); return undefined; }\n`;

function examples():{name:string;source:string}[] {
  const play=playDir();
  const nested=readdirSync(play,{withFileTypes:true}).filter(entry=>entry.isDirectory())
    .map(entry=>join(play,entry.name,'README.md')).filter(existsSync);
  return [join(play,'README.md'),...nested].sort().flatMap(path=>
    [...readFileSync(path,'utf8').matchAll(BLOCK)].map(([,source],index)=>({name:`${path.slice(play.length+1)}#${index+1}`,source:source!})));
}

function home(source:string):string {
  const runtime=mkdtempSync(join(tmpdir(),'check-parity-'));
  mkdirSync(join(runtime,'pilot'),{recursive:true});
  writeFileSync(join(runtime,'pilot','index.ts'),source);
  return runtime;
}

const journal=(runtime:string)=>readFileSync(join(runtime,'gameplay.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));

test('the warm checker and tsc give the same errors for every README example and a broken file',async()=>{
  const all=[...examples(),{name:'broken',source:BROKEN},{name:'type as value',source:TYPE_AS_VALUE}];
  assert.ok(all.length>=8);
  // One runtime, the file rewritten per example, as a bridge has: a service per runtime holds its own
  // checked program, and one per example passed 4 GB of heap at 19 examples (2026-10-04).
  const runtime=home('');
  for(const {name,source} of all) {
    writeFileSync(join(runtime,'pilot','index.ts'),source);
    const warm=await check(runtime),cold=await check(runtime,{warm:false});
    assert.deepEqual(warm.errors,cold.errors,name);
    if(name==='broken')assert.ok(warm.errors.some(line=>/error TS\d+/.test(line)),'the broken file has errors');
    // Both paths read the pilot tsconfig's verbatimModuleSyntax, and both hint the unimported play export.
    if(name==='type as value')assert.match(warm.errors.join('\n'),/type-only import[\s\S]*stopped is exported by 'play'/);
    assert.deepEqual(journal(runtime).filter(line=>line.event==='check').slice(-2).map(line=>line.warm),[true,false],name);
  }
});

test('a warm check of an unchanged library is fast',async()=>{
  const [first]=examples();
  const runtime=home(first!.source);
  await check(runtime);
  const times:number[]=[];
  for(let i=0;i<3;i++) {
    writeFileSync(join(runtime,'pilot','index.ts'),`${first!.source}\n// ${i}\n`);
    await check(runtime);
    times.push(journal(runtime).filter(line=>line.event==='check').at(-1).check_ms);
  }
  console.log(`warm check best of 3: ${Math.min(...times)} ms (${times.join(', ')})`);
  assert.ok(Math.min(...times)<630,`warm ${times.join(', ')} ms`);
});
