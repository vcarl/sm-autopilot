/** The window the activity map draws: the journal's last N runs, or one juncture's runs and the runs before them, and every line
 * they wrote. A run's `focus` is whether it is drawn in colour: every run of a `{runs}` window, only the juncture's in a `{juncture}`. */
import {isRecord,readJournal,type JournalLine} from '../run-record.ts';
import {RUNS} from './constants.ts';

type Row=Record<string,unknown>;
export interface RunRef {run_id:string;started:Date;ended?:Date;start_state?:Row;end_state?:Row;work?:Row;juncture_id?:string;focus:boolean}
/** `focusStart`/`focusEnd` bound the focus runs; with every run in focus they are the window's own. */
export interface Window {runs:RunRef[];lines:JournalLine[];start:Date;end:Date;focusStart:Date;focusEnd:Date}
/** The last N runs, or a juncture (an id or a prefix; a run id stands in when no run carries the juncture) with its context. */
export type Selector=number|{juncture:string};
/** The muted context before a juncture: about the last ten runs or six hours, whichever is less (the spec's `lately` bound). */
export const CONTEXT_RUNS=10,CONTEXT_MS=6*3600_000;

const FIRST_READ=2000,MOST_READ=200_000;
const runId=(line:JournalLine)=>typeof line.run_id==='string'?line.run_id:'';
const time=(value:unknown)=>{const at=typeof value==='string'?new Date(value):undefined;return at&&!Number.isNaN(+at)?at:undefined;};
const rec=(value:unknown)=>isRecord(value)?value:undefined;

/** Every run with a `started` line in `lines`, oldest first, folded with its `ended` line when it has one. */
function runsOf(lines:readonly JournalLine[]):RunRef[] {
  const ended=new Map(lines.filter(line=>line.event==='run'&&line.phase==='ended').map(line=>[runId(line),line]));
  return lines.flatMap(line=>{
    const started=time(line.started)??time(line.at),end=ended.get(runId(line));
    if(line.event!=='run'||line.phase!=='started'||!runId(line)||!started)return [];
    const endedAt=time(end?.at),start_state=rec(line.start_state),end_state=rec(end?.end_state),work=rec(end?.work),juncture_id=typeof line.juncture_id==='string'?line.juncture_id:undefined;
    return [{run_id:runId(line),started,...endedAt?{ended:endedAt}:{},...start_state?{start_state}:{},
      ...end_state?{end_state}:{},...work?{work}:{},...juncture_id?{juncture_id}:{},focus:true}];
  });
}

/** The juncture's runs (by `juncture_id`, else by run id), and before them the context runs: the window `sel` names, oldest first. */
function pick(found:RunRef[],sel:Selector):RunRef[] {
  if(typeof sel==='number')return found.slice(-sel);
  const byJuncture=found.filter(r=>r.juncture_id?.startsWith(sel.juncture)),focus=byJuncture.length?byJuncture:found.filter(r=>r.run_id.startsWith(sel.juncture));
  const first=focus[0];
  if(!first)return [];
  const ids=new Set(focus.map(r=>r.run_id)),before=found.slice(0,found.indexOf(first)).filter(r=>!ids.has(r.run_id))
    .slice(-CONTEXT_RUNS).filter(r=>+first.started-+r.started<=CONTEXT_MS);
  return [...before.map(r=>({...r,focus:false})),...found.filter(r=>ids.has(r.run_id))];
}
/** Enough journal read: the window holds `sel`'s runs, and for a juncture its context reaches back as far as it can. */
const enough=(found:RunRef[],sel:Selector)=>{
  if(typeof sel==='number')return found.length>=sel;
  const runs=pick(found,sel),first=runs.find(r=>r.focus);
  return !!first&&(runs.filter(r=>!r.focus).length>=CONTEXT_RUNS||+first.started-+(found[0]?.started??first.started)>=CONTEXT_MS);
};

/** The runs `sel` names, and the lines they wrote, oldest first. Reads further back until the journal holds them or runs out.
 *
 * ponytail: stops at 200_000 lines read whole (readJournal reads whole files); a window wider than
 * that many lines is cut short. Seek from the end of the files if a journal ever outgrows it. */
export function readWindow(runtime:string,sel:Selector=RUNS):Window {
  let limit=FIRST_READ,lines=readJournal(runtime,limit),found=runsOf(lines);
  while(!enough(found,sel)&&lines.length>=limit&&limit<MOST_READ) {
    limit=Math.min(limit*2,MOST_READ);lines=readJournal(runtime,limit);found=runsOf(lines);
  }
  const kept=pick(found,sel),ids=new Set(kept.map(run=>run.run_id));
  const inside=lines.filter(line=>ids.has(runId(line)));
  const first=kept[0],focus=kept.filter(r=>r.focus);
  if(!first)return {runs:[],lines:[],start:new Date(0),end:new Date(0),focusStart:new Date(0),focusEnd:new Date(0)};
  const times=inside.flatMap(line=>time(line.at)??[]).map(Number);
  const end=times.length?new Date(times.reduce((a,b)=>Math.max(a,b))):first.started,focusStart=focus[0]?.started??first.started;
  return {runs:kept,lines:inside,start:first.started,end,focusStart,focusEnd:end};
}
