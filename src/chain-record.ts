/** The chain on disk: what a restarting runner knows about the work it was doing.
 *
 * Nothing here decides anything. It is the durable half of `status`: the definition, where
 * the chain had got to, and the outcome once it has one, so a bridge that died mid-chain
 * does not leave the next one answering `last: null` with the ship still out at the belt.
 */
import {appendFileSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {ChainRecord} from './chain.ts';

export interface StoredChain extends ChainRecord {
  chain_id:string;
  /** Present exactly when the chain ended: the same shape the juncture reads as `last`. */
  outcome?:Record<string,unknown>;
}

/** Temp file then rename: a torn write would tell a restarting bridge a lie about the pilot. */
export function writeChain(runtime:string,stored:StoredChain):void {
  mkdirSync(runtime,{recursive:true});
  const path=join(runtime,'chain.json'),temp=`${path}.${process.pid}.tmp`;
  writeFileSync(temp,JSON.stringify(stored),{mode:0o600});
  renameSync(temp,path);
}

/** No record, or one too broken to name a chain, is the same answer: nothing to resume. */
export function readChain(runtime:string):StoredChain|null {
  try {
    const stored=JSON.parse(readFileSync(join(runtime,'chain.json'),'utf8')) as StoredChain;
    return stored?.chain_id&&Array.isArray(stored.jobs)?stored:null;
  } catch {return null;}
}

/** The tail of the journal as data: what the pilot has actually done, for the one reader
 * that needs history rather than the present (reflection, N7/N9).
 *
 * ponytail: the file is read whole and the tail kept. Rest happens once an evening, so a
 * few MB costs nothing; seek from the end if a journal ever outgrows that. */
export function readJournal(runtime:string,limit=400):Record<string,any>[] {
  try {
    const lines=readFileSync(join(runtime,'gameplay.jsonl'),'utf8').split('\n').filter(line=>line.trim());
    return lines.slice(-limit).flatMap(line=>{
      try {return [JSON.parse(line) as Record<string,any>];} catch {return [];}
    });
  } catch {return [];}
}

/** The chain's own line in the pilot's journal, beside the request/response pairs. The
 * runner's other self-made changes take the same line under their own event name (S45). */
export function journalChain(runtime:string,entry:Record<string,unknown>,event='chain'):void {
  mkdirSync(runtime,{recursive:true});
  appendFileSync(join(runtime,'gameplay.jsonl'),
    `${JSON.stringify({at:new Date().toISOString(),event,...entry})}\n`,{mode:0o600});
}
