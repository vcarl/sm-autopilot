/** The run on disk: the durable half of `status`, and the one account a process outside the
 * bridge (the juncture's gate) has of whether a run is in flight.
 *
 * A bridge that dies mid-run leaves the record un-ended; the next bridge closes it as
 * `interrupted` at boot (`closeInterrupted`) rather than re-running anything.
 */
import {appendFileSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Question} from './play/runtime.ts';
import {details} from './response-details.ts';

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
  /** Present while the program is paused on `ask()`: what the juncture gate wakes the pilot for. */
  question?:Question;
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

/** The join keys stamped on every line while a run is bound (`run_id`), set by `bind`/`unbind`.
 * A line carrying `freighter` is a freighter's, never the pilot's run, and is left unstamped. */
let stamp:Record<string,unknown>={};
export function stampRun(keys:Record<string,unknown>|null):void {stamp=keys??{};}

/** The run's own lines in the pilot's journal, beside the request/response pairs. The
 * runner's other self-made changes take the same line under their own event name (S45). */
export function journalRun(runtime:string,entry:Record<string,unknown>,event='run'):void {
  mkdirSync(runtime,{recursive:true});
  const line={at:new Date().toISOString(),event,...entry.freighter===undefined?stamp:{},...entry};
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
  ok:boolean,reply:unknown,freighter?:string):void {
  const [tool='',name='']=action.split('/');
  const scalars:Record<string,unknown>={};
  for(const [key,value] of Object.entries(params??{}))
    if(value!==null&&typeof value!=='object')
      scalars[key]=typeof value==='string'?value.slice(0,40):value;
  const who=freighter?{freighter}:{};
  journalRun(runtime,{tool,action:name,params:scalars,ok,summary:summarise(ok,reply),...who},'command');
  // A freighter's action is prefixed with its name, so it never takes the pilot's quote.
  const held=quoted?.action===action&&(quoted.id===undefined||quoted.id===params?.id)?quoted.quote:undefined;
  if(quoted?.action===action)quoted=null;
  if(!ok)return;
  const body=details(reply);
  const fact=TELEMETRY[name]?.(body);
  if(fact)journalRun(runtime,{...fact,...held?{quote:held}:{},...who},fact.event as string);
}

/** A book or posted price the caller had in hand as it sent `action`: attached to that command's
 * `trade` line and cleared. Pilot-side only; a freighter's trades carry no quote. */
let quoted:{action:string;id?:unknown;quote:Record<string,unknown>}|null=null;
export function quoteNext(action:string,id:unknown,quote:Record<string,unknown>):void {quoted={action,id,quote};}

const unit=(total:unknown,quantity:unknown)=>Number(quantity)>0&&Number.isFinite(Number(total))?Number(total)/Number(quantity):null;
/** ponytail: fills capped at 10 rows; a deeper walk of the book is summarised by total/quantity. */
const fills=(body:Record<string,any>)=>(Array.isArray(body.fills)?body.fills:[]).slice(0,10)
  .map((f:any)=>({price_each:f.price_each,quantity:f.quantity}));
const pick=(body:Record<string,any>,keys:string[])=>Object.fromEntries(keys.filter(key=>body[key]!==undefined).map(key=>[key,body[key]]));
const MISSION_KEYS=['mission_id','title','type','template_id','expires_at','credits_earned','credits_promised',
  'credits_shortfall','items_received','skill_xp_gained','reputation_changes','chain_next'];
/** The facts a reply carries that the journal keeps as their own event, raw: a trade's unit
 * price, a mission's id and reward. Read off replies the seam already has; nothing is asked. */
const TELEMETRY:Record<string,(body:Record<string,any>)=>Record<string,unknown>|null>={
  sell:body=>({event:'trade',side:'sell',item_id:body.item_id,quantity:body.quantity_sold,total:body.total_earned,
    unit_price:unit(body.total_earned,body.quantity_sold),fills:fills(body)}),
  buy:body=>({event:'trade',side:'buy',item_id:body.item_id,quantity:body.quantity,total:body.total_cost,
    unit_price:unit(body.total_cost,body.quantity),fills:fills(body)}),
  refuel:body=>({event:'trade',side:'service',service:'refuel',total:body.cost??null,
    ...pick(body,['fuel','fuel_now','fuel_max','cells_used','item_id','source','market_cost','tax_amount'])}),
  repair:body=>({event:'trade',side:'service',service:'repair',total:body.cost??null,
    unit_price:unit(body.cost,body.repaired),...pick(body,['repaired','hull','max_hull','kits_used','item_id','source'])}),
  accept_mission:body=>({event:'mission',verb:'accepted',...pick(body,MISSION_KEYS)}),
  complete_mission:body=>({event:'mission',verb:'completed',...pick(body,MISSION_KEYS)}),
  abandon_mission:body=>({event:'mission',verb:'abandoned',...pick(body,MISSION_KEYS)}),
};

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
