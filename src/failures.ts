/** The pilot's last few distinct failures: `failures.json` in the runtime dir, newest first, fed
 * from the journal as each line lands (`watchFailures`) and shown in the juncture context. The pilot
 * repeated the same refusals across sessions because each fire saw only its own; this is the memory
 * of them, kept across bridge boots and never rotated. The bridge is its only writer. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {keepJson} from './play/places.ts';
import {isRecord,watchJournal} from './run-record.ts';

const FILE='failures.json';
/** How many distinct failures are kept. */
export const FAILURES=5;
export interface Failure {key:string;command:string;text:string;first_at:string;last_at:string;count:number}
type Row=Record<string,unknown>;
interface Seen {name:string;command:string;text:string}

/** The runtime's own sends, not the pilot's acts: travel's battle probe (4,000 "No active battle"
 * lines live) and the trade-intel submit. */
const NOT_THE_PILOTS=new Set(['spacemolt_battle/status','spacemolt_intel/submit_trade_intel']);
/** A failure of the connection, not of the act: the reply is gone, never sent, or the socket closed. */
const noise=(e:Row)=>e.lost===true||typeof e.code==='number'||e.code==='connect_timeout'
  ||/^(cannot send|Sent before connected)/.test(String(e.summary??''));

/** The text with what makes one occurrence differ from the next taken out: quoted strings, then any
 * token holding a digit (numbers, uuids, hex ids, `r1549`). */
export const normalize=(text:string):string=>text.replace(/'[^'\n]*'|"[^"\n]*"/g,"'…'").replace(/[\w.-]*\d[\w.-]*/g,'#');

const str=(value:unknown)=>typeof value==='string'?value:value===undefined||value===null?'':String(value);
const firstLine=(value:unknown)=>str(value).split(/\r?\n/)[0]??'';

/** The failures one journal line records, each its command's name, the command, and what was said. */
export function failuresOf(e:Row):Seen[] {
  if(e.freighter!==undefined)return [];
  if(e.event==='command'&&e.ok===false) {
    const name=`${str(e.tool)}/${str(e.action)}`;
    if(NOT_THE_PILOTS.has(name)||noise(e))return [];
    const params=Object.entries(isRecord(e.params)?e.params:{}).map(([k,v])=>`${k}=${str(v)}`).join(' ');
    return [{name,command:params?`${name} ${params}`:name,text:str(e.summary)}];
  }
  if(e.event==='run'&&e.phase==='ended')return (Array.isArray(e.calls)?e.calls:[]).filter(isRecord)
    .filter(call=>call.status==='refused'||call.status==='failed')
    .map(call=>({name:str(call.fn),command:`${str(call.fn)}(${str(call.arg)})`,text:str(call.why)||str(call.did)}));
  if(e.event==='run'&&e.phase==='refused')
    return [{name:'check',command:`check ${str(e.script)}`,text:firstLine(Array.isArray(e.errors)?e.errors[0]:'')}];
  if(e.event==='defect')return [{name:str(e.fn),command:str(e.fn),text:str(e.why)}];
  return [];
}

/** One failure folded in: a repeat of a kept one counts and takes its latest words; a new one goes
 * first and the oldest falls off. */
export function foldFailure(kept:readonly Failure[],seen:Seen,at:string):Failure[] {
  const key=`${seen.name} ${normalize(seen.text)}`,old=kept.find(row=>row.key===key);
  return [{key,command:seen.command,text:seen.text,first_at:old?.first_at??at,last_at:at,count:(old?.count??0)+1},
    ...kept.filter(row=>row.key!==key)].slice(0,FAILURES);
}

export function readFailures(runtime:string):Failure[] {
  try {
    const rows:unknown=JSON.parse(readFileSync(join(runtime,FILE),'utf8'));
    return Array.isArray(rows)?rows.filter((row):row is Failure=>isRecord(row)&&typeof row.key==='string'
      &&typeof row.text==='string'&&typeof row.last_at==='string'&&typeof row.count==='number'):[];
  } catch {return [];} // edge: an absent or unreadable file is no failures kept
}

/** Fold one journal line's failures into the file; a line with none reads nothing. */
export function noteFailures(runtime:string,entry:Row):void {
  const seen=failuresOf(entry);
  if(!seen.length)return;
  const at=str(entry.at)||new Date().toISOString();
  keepJson(runtime,FILE,seen.reduce((kept,one)=>foldFailure(kept,one,at),readFailures(runtime)));
}

export const watchFailures=(runtime:string):()=>void=>watchJournal(entry=>noteFailures(runtime,entry));
