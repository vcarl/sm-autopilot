/** The run on disk: the durable half of `status`, and the one account a process outside the
 * bridge (the juncture's gate) has of whether a run is in flight.
 *
 * A bridge that dies mid-run leaves the record un-ended; the next bridge closes it as
 * `interrupted` at boot (`closeInterrupted`) rather than re-running anything.
 */
import {appendFileSync,existsSync,mkdirSync,readdirSync,readFileSync,renameSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Option,Schema} from 'effect';
import {replyLost} from './command-boundary.ts';
import {replyBody} from './storage.ts';

export const isRecord=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null;

/** What `ask()` leaves in run.json; `play/runtime.ts`'s `Question` is the same shape. */
const Question=Schema.Struct({question:Schema.String,choices:Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),asked_at:Schema.String});
const open=Schema.Record(Schema.String,Schema.Unknown);
// A record that cannot name its script and start is not a run (`readRun`); the run's own code
// moves `ended`, `last_job`, `outcome` and `question` as it flies, so those keys stay mutable.
// Struct decode drops unknown keys and `closeInterrupted` writes the record back: every key a
// writer sets (run.ts, play/runtime.ts) is named here.
export const RunRecord=Schema.Struct({
  script:Schema.NonEmptyString,
  /** The sha of the program that ran; the text is kept at `programs/<sha>.ts`. */
  source:Schema.optionalKey(Schema.String),
  params:Schema.optionalKey(open),
  /** The run's identity: no counter, no ids to keep unique across restarts. */
  started:Schema.NonEmptyString,
  /** When the context this run was written from was rendered. An instruction given after it
   * was never seen, so this run does not consume it (juncture.py's `_pending_instruction`). */
  juncture_at:Schema.optionalKey(Schema.String),
  last_job:Schema.optionalKey(Schema.String).pipe(Schema.mutableKey),
  last_step:Schema.optionalKey(Schema.String),
  ended:Schema.Boolean.pipe(Schema.mutableKey),
  /** Present exactly when the run ended: the same shape the juncture reads as `last`. */
  outcome:Schema.optionalKey(open).pipe(Schema.mutableKey),
  /** Present while the program is paused on `ask()`: what the juncture gate wakes the pilot for. */
  question:Schema.optionalKey(Question).pipe(Schema.mutableKey),
});
export type RunRecord=typeof RunRecord.Type;

/** One gameplay.jsonl line: `at` and `event` when the writer stamped them (the old
 * request/response pairs carry no `event`), every other key as written. */
export const JournalLine=Schema.StructWithRest(
  Schema.Struct({at:Schema.optionalKey(Schema.String),event:Schema.optionalKey(Schema.String)}),[open]);
export type JournalLine=typeof JournalLine.Type;
const decodeRun=Schema.decodeUnknownOption(Schema.fromJsonString(RunRecord));
const decodeLine=Schema.decodeUnknownOption(Schema.fromJsonString(JournalLine));

/** Temp file then rename: a torn write would tell a restarting bridge a lie about the pilot. */
export function writeRun(runtime:string,record:RunRecord):void {
  mkdirSync(runtime,{recursive:true});
  const path=join(runtime,'run.json'),temp=`${path}.${process.pid}.tmp`;
  writeFileSync(temp,JSON.stringify(record),{mode:0o600});
  renameSync(temp,path);
}

/** No record, or one too broken to name a script, is the same answer: nothing to resume. */
export function readRun(runtime:string):RunRecord|null {
  const path=join(runtime,'run.json');
  return existsSync(path)?Option.getOrNull(decodeRun(readFileSync(path,'utf8'))):null;
}

/** The last error line the previous bridge wrote to its stderr log: the one the gateway rotated
 * aside at this boot (`bridge.stderr.<UTC stamp>.log`, newest), then the live log, which a
 * playtest appends to without rotating.
 *
 * ponytail: an appended log spans every boot, so its last error may be an older bridge's; read
 * from the last boot marker if that ever misleads. */
export function lastBridgeError(runtime:string):string|undefined {
  const rotated=existsSync(runtime)?readdirSync(runtime).filter(name=>/^bridge\.stderr\..+\.log$/.test(name)).sort().slice(-1):[];
  const lines=[...rotated,'bridge.stderr.log'].flatMap(name=>existsSync(join(runtime,name))?readFileSync(join(runtime,name),'utf8').split('\n'):[]);
  return lines.findLast(line=>/^[A-Za-z]*(Error|Exception)\b/.test(line))?.trim().slice(0,300);
}

/** A record a dead bridge left un-ended, closed as `interrupted` and journalled, with the dead
 * bridge's last error as `why` when its log has one; null when there was none. Called at boot,
 * after the controller lock is held, so no live bridge owns the run. */
export function closeInterrupted(runtime:string):RunRecord|null {
  const kept=readRun(runtime);
  if(!kept||kept.ended)return null;
  const ended_at=new Date().toISOString();
  const did='the bridge ended while this run was in flight; nothing was re-run';
  const why=lastBridgeError(runtime);
  const closed:RunRecord={...kept,ended:true,outcome:{...kept.source?{sha:kept.source}:{},started:kept.started,
    ended:true,ended_at,status:'interrupted',did,...why?{why}:{}}};
  writeRun(runtime,closed);
  journalRun(runtime,{phase:'ended',script:kept.script,...kept.source?{sha:kept.source}:{},started:kept.started,
    outcome:'interrupted',reason:did,...why?{why}:{}});
  return closed;
}

/** The journal files newest first: `gameplay.jsonl`, then each `gameplay.<UTC stamp>.jsonl` a
 * boot rotated away. The stamps sort as time. */
function journalFiles(runtime:string):string[] {
  const rotated=existsSync(runtime)?readdirSync(runtime).filter(name=>/^gameplay\..+\.jsonl$/.test(name)).sort().reverse():[];
  return ['gameplay.jsonl',...rotated].map(name=>join(runtime,name));
}

/** The tail of the journal as data: what the pilot has actually done, for the readers that need
 * history rather than the present (reflection, the menu, the rendered window). Walks from the
 * current file back through the rotated ones until it has `limit` entries, so a fresh boot's
 * nearly empty journal does not cost them their past.
 *
 * ponytail: each file is read whole and the tail kept. Rest happens once an evening, so a
 * few MB costs nothing; seek from the end if a journal ever outgrows that. */
export function readJournal(runtime:string,limit=400):JournalLine[] {
  let lines:string[]=[];
  for(const path of journalFiles(runtime)) {
    if(lines.length>=limit)break;
    if(existsSync(path))lines=[...readFileSync(path,'utf8').split('\n').filter(line=>line.trim()),...lines];
  }
  return lines.slice(-limit).flatMap(line=>Option.toArray(decodeLine(line)));
}

/** A bridge's boot, in the journal: a non-empty `gameplay.jsonl` is renamed to
 * `gameplay.<UTC stamp>.jsonl`, then the interrupted-run close and the `boot` line (naming the
 * rotated file as `rotated_from`, so the chain walks back) open the fresh one. Called once the
 * controller lock is held, so no live bridge is writing the file being moved. Python writers
 * open the journal by name per line, so they follow the rename.
 *
 * ponytail: rotated journals are kept forever, for post hoc analysis; no pruning. Add it here
 * (drop the oldest of `journalFiles`) if disk becomes a concern. */
export function bootJournal(runtime:string,now=new Date()):RunRecord|null {
  mkdirSync(runtime,{recursive:true});
  const current=join(runtime,'gameplay.jsonl');
  let rotated_from:string|undefined;
  if(existsSync(current)&&statSync(current).size>0) {
    const stamp=now.toISOString().replace(/\.\d+Z$/,'Z').replaceAll(':','-');
    // Two boots inside one second must not overwrite the first one's file; `_` sorts after `.`,
    // so the second still reads as the newer.
    rotated_from=existsSync(join(runtime,`gameplay.${stamp}.jsonl`))?`gameplay.${stamp}_${process.pid}.jsonl`:`gameplay.${stamp}.jsonl`;
    renameSync(current,join(runtime,rotated_from));
  }
  const interrupted=closeInterrupted(runtime);
  journalRun(runtime,{pid:process.pid,...interrupted?{interrupted:interrupted.started}:{},...rotated_from?{rotated_from}:{}},'boot');
  return interrupted;
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
export function journalRun(runtime:string,entry:Record<string,unknown>,event='run',file='gameplay.jsonl'):void {
  mkdirSync(runtime,{recursive:true});
  const line={at:new Date().toISOString(),event,...entry.freighter===undefined?stamp:{},...entry};
  appendFileSync(join(runtime,file),`${JSON.stringify(line)}\n`,{mode:0o600});
  if(file!=='gameplay.jsonl')return;
  // A listener that throws is its own problem: it never costs the pilot the line on disk.
  for(const fn of listeners)try {fn(line);} catch {/* the journal is written; the reader is not the record */} // edge: a listener is another reader's code
}

const SUMMARY_CHARS=120;
const text=(value:unknown)=>value===undefined||value===null?'':String(value);

/** What one game command was, in the space a line can afford: the tool and action, the ids
 * and quantities it named, whether it took, and one sentence off the reply. Never the reply
 * body — a `get_system` answer is kilobytes and the journal is read by a human. */
export function journalCommand(runtime:string,action:string,params:Record<string,unknown>|undefined,
  ok:boolean,reply:unknown,{freighter,ms}:{freighter?:string;ms?:number}={}):void {
  const [tool='',name='']=action.split('/');
  const scalars:Record<string,unknown>={};
  for(const [key,value] of Object.entries(params??{}))
    if(value!==null&&typeof value!=='object')
      scalars[key]=typeof value==='string'?value.slice(0,40):value;
  const who=freighter?{freighter}:{};
  // `ms` is wall time around the lib's send, its own rate-limit retries included; `code` is the
  // error's own code (the game's string, or a socket close number), the thing to count by.
  const code=ok||!isRecord(reply)?undefined:reply.code;
  // `lost`: the reply is gone, not the outcome (`replyLost`, the same test `classify` makes).
  journalRun(runtime,{tool,action:name,params:scalars,ok,summary:summarise(ok,reply),
    ...ms===undefined?{}:{ms},...code===undefined?{}:{code},...!ok&&replyLost(reply)?{lost:true}:{},...who},'command');
  // A freighter's action is prefixed with its name, so it never takes the pilot's quote.
  const held=quoted?.action===action&&(quoted.id===undefined||quoted.id===params?.id)?quoted.quote:undefined;
  if(quoted?.action===action)quoted=null;
  if(!ok)return;
  const raw=replyBody(reply);
  const fact=TELEMETRY[name]?.(isRecord(raw)?raw:{});
  if(fact)journalRun(runtime,{...fact,...held?{quote:held}:{},...who},fact.event);
}

/** The socket's own life on the journal: each reconnect attempt, its success, and a connection
 * lost for good — what a command's `ms` cannot say about the time between commands. */
export function journalConnection(runtime:string,account:{onReconnecting(fn:(attempt:number)=>void):unknown;
  onReconnected(fn:()=>void):unknown;onDisconnected(fn:(error:{code?:number;reason?:string;message:string})=>void):unknown},
freighter?:string):void {
  const who=freighter?{freighter}:{};
  account.onReconnecting(attempt=>journalRun(runtime,{attempt,...who},'reconnecting'));
  account.onReconnected(()=>journalRun(runtime,{...who},'reconnected'));
  account.onDisconnected(error=>journalRun(runtime,{code:error.code,reason:error.reason||error.message,...who},'disconnected'));
}

/** A book or posted price the caller had in hand as it sent `action`: attached to that command's
 * `trade` line and cleared. Pilot-side only; a freighter's trades carry no quote. */
let quoted:{action:string;id?:unknown;quote:Record<string,unknown>}|null=null;
export function quoteNext(action:string,id:unknown,quote:Record<string,unknown>):void {quoted={action,id,quote};}

const unit=(total:unknown,quantity:unknown)=>Number(quantity)>0&&Number.isFinite(Number(total))?Number(total)/Number(quantity):null;
/** ponytail: fills capped at 10 rows; a deeper walk of the book is summarised by total/quantity. */
const fills=(body:Record<string,unknown>)=>{
  const rows:unknown[]=Array.isArray(body.fills)?body.fills:[];
  return rows.slice(0,10).flatMap(f=>isRecord(f)?[{price_each:f.price_each,quantity:f.quantity}]:[]);
};
const pick=(body:Record<string,unknown>,keys:string[])=>Object.fromEntries(keys.filter(key=>body[key]!==undefined).map(key=>[key,body[key]]));
const MISSION_KEYS=['mission_id','title','type','template_id','expires_at','credits_earned','credits_promised',
  'credits_shortfall','items_received','skill_xp_gained','reputation_changes','chain_next'];
/** The facts a reply carries that the journal keeps as their own event, raw: a trade's unit
 * price, a mission's id and reward. Read off replies the seam already has; nothing is asked. */
type Fact=Record<string,unknown>&{event:string};
const TELEMETRY:Record<string,(body:Record<string,unknown>)=>Fact|null>={
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
  const delta=isRecord(reply)&&isRecord(reply.delta)?reply.delta.details:undefined;
  const body:unknown=(isRecord(reply)?reply.structuredContent:undefined)??delta??reply??{};
  if(!isRecord(body))return text(body).slice(0,SUMMARY_CHARS);
  const bits=[text(body.command??body.action??body.kind),
    body.tick===undefined?'':`tick ${text(body.tick)}`,
    text(body.error??body.message)];
  return bits.filter(Boolean).join(' ').slice(0,SUMMARY_CHARS);
}
