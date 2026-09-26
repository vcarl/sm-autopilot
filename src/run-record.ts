/** The run on disk: the durable half of `status`, and the one account a process outside the
 * bridge (the juncture's gate) has of whether a run is in flight.
 *
 * A bridge that dies mid-run leaves the record un-ended; the next bridge closes it as
 * `interrupted` at boot (`closeInterrupted`) rather than re-running anything.
 */
import {appendFileSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

export interface RunRecord {
  script:string;
  /** The sha of the program that ran; the text is kept at `programs/<sha>.ts`. */
  source?:string;
  params?:Record<string,unknown>;
  /** The run's identity: no counter, no ids to keep unique across restarts. */
  started:string;
  last_job?:string;
  last_step?:string;
  ended:boolean;
  /** Present exactly when the run ended: the same shape the juncture reads as `last`. */
  outcome?:Record<string,unknown>;
}

/** Temp file then rename: a torn write would tell a restarting bridge a lie about the pilot. */
export function writeRun(runtime:string,record:RunRecord):void {
  mkdirSync(runtime,{recursive:true});
  const path=join(runtime,'run.json'),temp=`${path}.${process.pid}.tmp`;
  writeFileSync(temp,JSON.stringify(record),{mode:0o600});
  renameSync(temp,path);
}

/** No record, or one too broken to name a script, is the same answer: nothing to resume. */
export function readRun(runtime:string):RunRecord|null {
  try {
    const stored=JSON.parse(readFileSync(join(runtime,'run.json'),'utf8')) as RunRecord;
    return stored?.script&&stored.started?stored:null;
  } catch {return null;}
}

/** A record a dead bridge left un-ended, closed as `interrupted` and journalled; null when there
 * was none. Called at boot, after the controller lock is held, so no live bridge owns the run. */
export function closeInterrupted(runtime:string):RunRecord|null {
  const kept=readRun(runtime);
  if(!kept||kept.ended)return null;
  const ended_at=new Date().toISOString();
  const did='the bridge ended while this run was in flight; nothing was re-run';
  const closed:RunRecord={...kept,ended:true,outcome:{...kept.source?{sha:kept.source}:{},started:kept.started,
    ended:true,ended_at,status:'interrupted',did}};
  writeRun(runtime,closed);
  journalRun(runtime,{phase:'ended',script:kept.script,...kept.source?{sha:kept.source}:{},started:kept.started,
    outcome:'interrupted',reason:did});
  return closed;
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

/** The one reader of the journal as it is being written: the webhook drain, which renders
 * each line as it lands rather than watching the file. Null turns it off. One process writes
 * this journal, so one listener is the whole of the need. */
const listeners=new Set<(entry:Record<string,unknown>)=>void>();
/** Add a reader; null removes them all. Returns the remover for the one added. */
export function watchJournal(fn:((entry:Record<string,unknown>)=>void)|null):()=>void {
  if(!fn) {listeners.clear();return ()=>{};}
  listeners.add(fn);
  return ()=>{listeners.delete(fn);};
}

/** The run's own lines in the pilot's journal, beside the request/response pairs. The
 * runner's other self-made changes take the same line under their own event name (S45). */
export function journalRun(runtime:string,entry:Record<string,unknown>,event='run'):void {
  mkdirSync(runtime,{recursive:true});
  const line={at:new Date().toISOString(),event,...entry};
  appendFileSync(join(runtime,'gameplay.jsonl'),`${JSON.stringify(line)}\n`,{mode:0o600});
  // A listener that throws is its own problem: it never costs the pilot the line on disk.
  for(const fn of listeners)try {fn(line);} catch {/* the journal is written; the reader is not the record */}
}

const SUMMARY_CHARS=120;
const text=(value:unknown)=>value===undefined||value===null?'':String(value);

/** What one game command was, in the space a line can afford: the tool and action, the ids
 * and quantities it named, whether it took, and one sentence off the reply. Never the reply
 * body — a `get_system` answer is kilobytes and the journal is read by a human. */
export function journalCommand(runtime:string,action:string,params:Record<string,unknown>|undefined,
  ok:boolean,reply:unknown):void {
  const [tool='',name='']=action.split('/');
  const scalars:Record<string,unknown>={};
  for(const [key,value] of Object.entries(params??{}))
    if(value!==null&&typeof value!=='object')
      scalars[key]=typeof value==='string'?value.slice(0,40):value;
  journalRun(runtime,{tool,action:name,params:scalars,ok,summary:summarise(ok,reply)},'command');
}

/** The reply in one short string: what the game says it did, when, and what went wrong. */
function summarise(ok:boolean,reply:unknown):string {
  if(!ok)return text(reply instanceof Error?reply.message:reply).slice(0,SUMMARY_CHARS);
  let body:Record<string,any>={};
  try {body=(reply as any)?.structuredContent??(reply as any)?.delta?.details??reply??{};} catch {/* not an object */}
  if(typeof body!=='object'||body===null)return text(body).slice(0,SUMMARY_CHARS);
  const bits=[text(body.command??body.action??body.kind),
    body.tick===undefined?'':`tick ${text(body.tick)}`,
    text(body.error??body.message)];
  return bits.filter(Boolean).join(' ').slice(0,SUMMARY_CHARS);
}
