/** The rings freighters have drained: `drained.json` in the pilot's runtime dir, each ring's key
 * and the game tick a freighter parked on it for want of trade. The freighter host writes it;
 * `routes({circuit})` reads it to let a ring's books refill before it plans that ring again. */
import {readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Option,Schema} from 'effect';

const FILE='drained.json';

/** One ring of bases: its stops in order, read from whichever rotation sorts first, so every
 * rotation of a ring is one key. The same key `routes()` ranks one row per. */
export const ring=(stops:readonly {at:string}[]):string=>
  stops.map((_,i)=>[...stops.slice(i),...stops.slice(0,i)].map(stop=>stop.at).join(' ')).sort()[0]??'';

/** Read leniently: a ring whose tick is not a number is dropped, the rest kept. */
const decodeDrained=Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String,Schema.Unknown)));

export function readDrained(runtime:string):Record<string,number> {
  try {
    const drained=decodeDrained(readFileSync(join(runtime,FILE),'utf8'));
    return Option.isSome(drained)?Object.fromEntries(Object.entries(drained.value).flatMap(([key,tick])=>typeof tick==='number'?[[key,tick]]:[])):{};
  } catch {return {};} // edge: an absent or unreadable file is no ring drained
}
export function markDrained(runtime:string,key:string,tick:number):void {
  const path=join(runtime,FILE),temp=`${path}.${process.pid}.tmp`;
  writeFileSync(temp,JSON.stringify({...readDrained(runtime),[key]:tick},null,2),{mode:0o600});
  renameSync(temp,path);
}
