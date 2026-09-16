/** The runner's own voice during a long step. Every job's long loop is silent between its
 * started and done lines; rather than each loop remembering to speak, one reader of the
 * journal notices a run that has said nothing for a while and writes what it can see: the
 * step, how long, how many commands, the last one. Any `log` line a job writes itself resets
 * the clock, so richer progress is one `journal(ctx, …, 'log')` call in the loop, not a
 * mechanism. */
import {renderLine} from './journal-lines.ts';
import {journalRun,watchJournal} from './run-record.ts';

export const QUIET_MS=5*60_000;
const TICK_MS=60_000;

export interface HeartbeatDeps {now?:()=>number;schedule?:(fn:()=>void,ms:number)=>{unref?():void}}

export function startHeartbeat(runtime:string,deps:HeartbeatDeps={}):()=>void {
  const now=deps.now??Date.now;
  const schedule=deps.schedule??((fn,ms)=>setInterval(fn,ms));
  let run:{script:string;started:number}|null=null,step:{job:string;step:string}|null=null;
  let spoken=now(),commands=0,last='';
  const unwatch=watchJournal(entry=>{
    const e=entry as Record<string,any>;
    if(e.event==='run'&&e.phase==='started') {run={script:String(e.script),started:now()};step=null;commands=0;spoken=now();}
    if(e.event==='run'&&e.phase==='ended')run=null;
    if(e.event==='step')step={job:String(e.job),step:String(e.step)};
    if(e.event==='command') {commands++;last=String(e.summary??e.action??'');}
    if(renderLine(e))spoken=now();
  });
  const timer=schedule(()=>{
    if(!run||now()-spoken<QUIET_MS)return;
    const minutes=Math.round((now()-run.started)/60_000);
    journalRun(runtime,{job:step?.job??run.script,step:step?.step,
      message:`still ${step?.step??run.script} after ${minutes} min, ${commands} commands, last ${last}`},'log');
  },TICK_MS);
  timer.unref?.();
  return unwatch;
}
