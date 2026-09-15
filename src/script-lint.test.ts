import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {lintFile,lintScript} from './script-lint.ts';

const ok=(body:string)=>lintScript(`import {gather,type Ctx} from '../jobs/index.ts';\n${body}`,'x.ts');
const BODY='export const params={type:"object",properties:{}};\nexport default async (ctx:Ctx)=>{await gather(ctx,{poi_id:"belt"});};\n';

test('a script may reach the jobs barrel and nothing else', () => {
  assert.deepEqual(ok(BODY),{ok:true,errors:[]});
  // The directory spelling resolves to the same module and is admissible too.
  assert.equal(lintScript(`import {gather} from '../jobs';\n${BODY}`,'x.ts').ok,true);

  for(const [name,line] of [
    ['a sibling module',"import {gatherJob} from '../gather-job.ts';"],
    ['a node builtin',"import {readFileSync} from 'node:fs';"],
    ['a bare package',"import {Account} from '@spacemolt/lib';"],
    ['a re-export',"export {travelTo} from '../travel.ts';"],
    ['a side-effect import',"import '../bridge.ts';"],
  ] as [string,string][]) {
    const verdict=lintScript(`${line}\n${BODY}`,'x.ts');
    assert.equal(verdict.ok,false,name);
    assert.match(verdict.errors.join(' '),/may import only/,name);
  }
});

test('a script may not reach past its imports either', () => {
  for(const [name,line] of [
    ['a dynamic import','const jobs=await import("../jobs/index.ts");'],
    ['require','const fs=require("node:fs");'],
    ['eval','eval("1+1");'],
    ['Function','const f=new Function("return 1");'],
    ['the process env','const home=process.env.HOME;'],
    ['globalThis','globalThis.x=1;'],
  ] as [string,string][]) {
    const verdict=ok(`${BODY}${line}\n`);
    assert.equal(verdict.ok,false,name);
    assert.match(verdict.errors.join(' '),/not available to a script/,name);
  }
  // A script with nothing to run is refused rather than loaded and found empty.
  assert.equal(ok('const x=1;\n').ok,false);
});

test('a script reaches another script through the barrel, never by its path', () => {
  // A script composes like a job, so one script may call another — through the one door.
  assert.equal(lintScript(
    `import {gatherUntil,type Ctx} from '../jobs/index.ts';\n${BODY}`,'x.ts').ok,true);
  const verdict=lintScript(`import gatherUntil from '../scripts/gather-until.ts';\n${BODY}`,'x.ts');
  assert.equal(verdict.ok,false);
  assert.match(verdict.errors.join(' '),/may import only/);
});

test('a mention in a comment is prose, not a reach', () => {
  assert.equal(ok(`// this one does not use node:fs or process.env\n${BODY}`).ok,true);
});

test('every shipped script is admissible', () => {
  const dir=new URL('./scripts/',import.meta.url);
  const files=readdirSync(dir).filter(file=>file.endsWith('.ts'));
  assert.ok(files.length>=2,'the runner ships scripts to run');
  for(const file of files) {
    const verdict=lintFile(fileURLToPath(new URL(file,dir)));
    assert.deepEqual(verdict.errors,[],file);
  }
});
