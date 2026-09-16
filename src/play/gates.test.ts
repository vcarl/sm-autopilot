import assert from 'node:assert/strict';
import test from 'node:test';
import {checkBoundary} from './boundary.ts';
import {checkPolicy} from './policy.ts';

const MAIN="export default async function main() { return orient(); }\n";

test('a pilot file may reach play, its folders, the lib types and its own siblings, and nothing else',()=>{
  for(const line of ["import {orient} from 'play';","import {gatherUntil} from 'play/mining';",
    "import type {V2Ship} from '@spacemolt/lib';","import {mine} from './mine.ts';"])
    assert.deepEqual(checkBoundary(`${line}\n${MAIN}`,'x.ts'),{ok:true,errors:[]},line);
  for(const line of ["import {readFileSync} from 'node:fs';","import {Account} from 'ws';",
    "import {travelTo} from '../travel.ts';","import '../bridge.ts';"])
    assert.match(checkBoundary(`${line}\n${MAIN}`,'x.ts').errors.join(' '),/may import/,line);
  for(const line of ['const jobs=await import("play");','const fs=require("node:fs");','eval("1");',
    'new Function("return 1");','process.env.HOME;','globalThis.x=1;','await fetch("http://x");'])
    assert.match(checkBoundary(`${MAIN}${line}\n`,'x.ts').errors.join(' '),/not available/,line);
  assert.equal(checkBoundary(`// process.env is mentioned in prose only\n${MAIN}`,'x.ts').ok,true);
});

test('the policy refuses uncapped loops without stopped(), stranding landings, and a missing main',()=>{
  assert.equal(checkPolicy(`${MAIN}while(true){ await orient(); if(stopped()) break; }`,'x.ts',true).ok,true);
  assert.match(checkPolicy(`${MAIN}for(;;){ await orient(); }`,'x.ts',true).errors[0]!,/stopped\(\)/);
  assert.match(checkPolicy(`${MAIN}await account().commands.spacemolt.unload_passenger({id: 'all'});`,'x.ts',true).errors[0]!,/strands/);
  assert.match(checkPolicy('export default async () => {}','x.ts',true).errors[0]!,/export default async function main/);
  assert.equal(checkPolicy('export const helper = 1;','helper.ts',false).ok,true,'a sibling needs no main');
});
