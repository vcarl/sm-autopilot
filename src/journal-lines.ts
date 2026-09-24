/** The journal as a person reads it: one short line per thing the pilot actually did.
 *
 * The journal on disk is for machines — the runner resuming, reflection counting, a proof
 * replaying. This is the other half: what the human sees in a chat window and in the
 * Discord drain, where a shift is a few dozen lines rather than a few thousand JSON objects.
 *
 * Every entry renders to at most one line, or to null when a line would be noise: a status
 * poll, a `where` read, a command a step line already summarises. Rendering never reads the
 * game and never fails — a line it cannot parse is a line it does not print.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/** A chat line, not a paragraph. Long reasons are cut rather than wrapped. */
export const LINE_CHARS=160;

const text=(value:unknown)=>value===undefined||value===null?'':String(value);
const clip=(value:string,chars:number)=>value.length>chars?`${value.slice(0,chars-1)}…`:value;

/** Local time, because the person reading this is in it. */
function clock(at:unknown):string {
  const when=new Date(text(at));
  if(Number.isNaN(when.getTime()))return '--:--';
  return `${String(when.getHours()).padStart(2,'0')}:${String(when.getMinutes()).padStart(2,'0')}`;
}

/** `+61 carbon_ore +59 iron_ore`, three rows at most: the rest is a count. */
function rows(value:unknown):string {
  const list=(Array.isArray(value)?value:[]).filter(row=>row&&typeof row==='object');
  const shown=list.slice(0,3)
    .map((row:any)=>`+${text(row.quantity)} ${text(row.item_id)}`).join(' ');
  return list.length>3?`${shown} +${list.length-3} more`:shown;
}

/** A run's parameters as a person names them: where it went, what it made, how many. */
function asked(params:unknown):string {
  const bits:string[]=[];
  for(const [key,value] of Object.entries((params??{}) as Record<string,unknown>)) {
    if(value===null||typeof value==='object')continue;
    if(key==='poi_id')bits.unshift(`→ ${text(value)}`);
    else if(key==='quantity'||key==='fights')bits.push(`×${text(value)}`);
    else if(key==='base_id')bits.push(`@ ${text(value)}`);
    else bits.push(text(value));
  }
  return bits.join(' ');
}

/** What a finished run yielded, when it said: the same rows the outcome carries. */
function produced(entry:Record<string,any>):string {
  const jobs=Array.isArray(entry.jobs)?entry.jobs:[];
  const yielded=jobs.flatMap((job:any)=>Array.isArray(job?.yield)?job.yield:[]);
  return yielded.length?rows(yielded):text(entry.reason);
}

/** Commands worth a line of their own when they succeed: the pilot moving or acting at a counter. */
const ACTS=new Set(['travel','jump','undock','dock','deposit','withdraw','craft','refuel','repair','hunt','loot','sell','buy','set_home']);
const STEP_OUTCOME:Record<string,string>={done:'',skipped:'skipped',failed:'failed',blocked:'blocked'};

function step(entry:Record<string,any>):string {
  const bits=[`${text(entry.job)} ${text(entry.step)}`];
  if(entry.poi_id)bits.push(`→ ${text(entry.poi_id)}`);
  if(entry.base_id)bits.push(`@ ${text(entry.base_id)}`);
  const moved=rows(entry.yield);
  if(moved)bits.push(moved);
  if(entry.n!==undefined)bits.push(`×${text(entry.n)}`);
  const state=STEP_OUTCOME[text(entry.outcome)]??text(entry.outcome);
  if(state)bits.push(`${state}: ${text(entry.reason)}`);
  else if(entry.reason&&!moved)bits.push(text(entry.reason));
  return bits.join(' ');
}

/** One journal entry as one line, or null when it is not worth one. */
export function renderLine(entry:Record<string,any>|null|undefined):string|null {
  if(!entry||typeof entry!=='object')return null;
  const body=render(entry);
  return body?clip(`${clock(entry.at)} ${body.replace(/\s+/g,' ').trim()}`,LINE_CHARS):null;
}

function render(entry:Record<string,any>):string|null {
  // Lines the bridge wrote before the request/response pair carried an event name: they are
  // still the pilot's history, and a journal that starts rendering at today is no history.
  switch(text(entry.event)||(entry.request?'request':'')) {
    case 'run':
      if(entry.phase==='started')return `run ${text(entry.script)} ${asked(entry.params)}`;
      if(entry.phase==='ended') {
        const what=produced(entry),head=`${text(entry.script)} ${text(entry.outcome)}`;
        return what.startsWith(head)?what:`${head}: ${what}`;
      }
      return null;
    case 'step':return step(entry);
    // The run's own stream: what a helper said while it worked, already one line.
    case 'line':return text(entry.text);
    case 'tired':return `tired: ${text(entry.rule)}`;
    case 'tired_cleared':return `tired cleared: ${text(entry.mood)} again`;
    // A command that took is already in the step line above it; one that did not is the
    // only account of why the step said what it said.
    case 'command': {
      if(!entry.ok)return `! ${text(entry.tool)}/${text(entry.action)}: ${text(entry.summary)}`;
      // A move or a counter act is the pilot doing something and shows even when it took; a
      // read is not, and a mine tick is one of many the step line adds up.
      const action=text(entry.action);
      if(!ACTS.has(action))return null;
      const params=(entry.params??{}) as Record<string,unknown>;
      const target=params.id??params.item_id??params.recipe_id??params.station_id;
      const qty=params.quantity?` ×${text(params.quantity)}`:'';
      return `${action}${target?` → ${text(target)}`:''}${qty}`;
    }
    case 'rest':return 'rest';
    case 'reflection':
      if(entry.objective_done)return `reflection: objective done — ${text(entry.objective)}`;
      return `reflection: ${text(entry.stance)}/${text(entry.mood)} — ${text(entry.goal)}`;
    case 'log': {
      const skip=new Set(['at','event','job','script','step','message']);
      const fields=Object.entries(entry).filter(([k,v])=>!skip.has(k)&&v!==null&&typeof v!=='object').map(([k,v])=>`${k}=${text(v)}`);
      return `${text(entry.job??entry.script)} ${text(entry.message)}${fields.length?` ${fields.join(' ')}`:''}`;
    }
    case 'instruction':return `instruction: ${JSON.stringify(text(entry.text))}`;
    case 'unsolicited_move':return `moved (${text(entry.cause)}): ${text(entry.evidence)}`;
    // Something the game told the pilot without being asked. The ids and scalars only: the
    // frame body never reaches the journal, so there is nothing else here to print.
    case 'push': {
      const skip=new Set(['at','event','push','message']);
      const fields=Object.entries(entry).filter(([key,value])=>!skip.has(key)&&value!==null&&typeof value!=='object')
        .map(([key,value])=>`${key}=${text(value)}`);
      return `push ${text(entry.push)}${fields.length?` ${fields.join(' ')}`:''}${entry.message?` — ${text(entry.message)}`:''}`;
    }
    // The request/response pairs: every one that took is covered by a line above, so only
    // the refusals earn one. A read that failed is a thing the pilot could not do.
    case 'request': {
      if(entry.response&&entry.response.ok===false)return `! ${text(entry.request?.action)}: ${text(entry.response.error)}`;
      // The one reply worth a line of its own: the menu is the pilot's whole view of the
      // world at a juncture, and which moves it was offered is what a diagnosis asks.
      const result=(entry.response?.result??{}) as Record<string,any>;
      if(text(entry.request?.action)!=='menu'||!Array.isArray(result.moves))return null;
      const who=[result.stance,result.mood].filter(Boolean).join('/');
      const offered=result.moves.length?result.moves.map(text).join(' · '):'(nothing)';
      const refused=Array.isArray(result.not_now)&&result.not_now.length
        ?` — not now: ${result.not_now.map(text).join(' · ')}`:'';
      return `menu${who?` ${who}`:''}: ${offered}${refused}`;
    }
    default:return null;
  }
}

/** The tail of a journal file, rendered. The one-shot the plugin's `spacemolt_status` runs
 * for its `journal` key, so the window and the Discord drain read the same lines from the same renderer. */
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
  const {readJournal}=await import('./run-record.ts');
  const runtime=process.argv[2]??process.env.SPACEMOLT_RUNTIME_DIR??'';
  const limit=Math.max(1,Number(process.argv[3]??40));
  // Read well past the limit: most entries render to nothing, so a tail of N lines is drawn
  // from a much longer tail of entries.
  const lines=readJournal(runtime,limit*40).map(renderLine).filter((line):line is string=>Boolean(line));
  process.stdout.write(`${lines.slice(-limit).join('\n')}\n`);
}
