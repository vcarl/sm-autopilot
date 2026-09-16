/** The journal as a person reads it: one short line per thing the pilot actually did.
 *
 * The journal on disk is for machines — the runner resuming, reflection counting, a proof
 * replaying. This is the other half: what the operator sees in a chat window and in the
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
    // A command that took is already in the step line above it; one that did not is the
    // only account of why the step said what it said.
    case 'command':return entry.ok?null:`! ${text(entry.tool)}/${text(entry.action)}: ${text(entry.summary)}`;
    case 'rest':return `rest${entry.home?` at ${text(entry.home)}`:''}`;
    case 'reflection':
      if(entry.objective_done)return `reflection: objective done — ${text(entry.objective)}`;
      return `reflection: ${text(entry.stance)}/${text(entry.mood)} — ${text(entry.goal)}`;
    case 'instruction':return `instruction: ${JSON.stringify(text(entry.text))}`;
    case 'unsolicited_move':return `moved (${text(entry.cause)}): ${text(entry.evidence)}`;
    // The request/response pairs: every one that took is covered by a line above, so only
    // the refusals earn one. A read that failed is a thing the pilot could not do.
    case 'request':
      return entry.response&&entry.response.ok===false
        ?`! ${text(entry.request?.action)}: ${text(entry.response.error)}`:null;
    default:return null;
  }
}

/** The tail of a journal file, rendered. The one-shot the plugin's `spacemolt_journal` runs,
 * so the window and the Discord drain read the same lines from the same renderer. */
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
  const {readJournal}=await import('./run-record.ts');
  const runtime=process.argv[2]??process.env.SPACEMOLT_RUNTIME_DIR??'';
  const limit=Math.max(1,Number(process.argv[3]??40));
  // Read well past the limit: most entries render to nothing, so a tail of N lines is drawn
  // from a much longer tail of entries.
  const lines=readJournal(runtime,limit*40).map(renderLine).filter((line):line is string=>Boolean(line));
  process.stdout.write(`${lines.slice(-limit).join('\n')}\n`);
}
