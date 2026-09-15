/** One run: one script, from the dispatch that asked for it to the juncture at its end.
 *
 * The script is the agent's composition; this is the machinery around it. It refuses a
 * script the lint will not pass before any command reaches the game, builds the `Ctx` the
 * jobs are handed, keeps the rules between jobs, writes the run down so a restart knows what
 * it was doing, caps the whole thing on the wall clock, and reports one outcome.
 */
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Blocked,type Ctx,type JobOutcome} from './jobs/ctx.ts';
import {ownHold} from './jobs/gather.ts';
import {lintScript} from './script-lint.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import type {Mood} from './mood-policy.ts';
import type {Reconciliation} from './reconcile.ts';
import {jobStop,type Facts} from './rules-table.ts';
import {journalRun,writeRun,type RunRecord} from './run-record.ts';

/** ponytail: one number, not a config system. A job is minutes of real game time and a
 * handful of them is a shift; 45 minutes is the cap past which a run is stuck, not slow.
 * Lift it into config.yaml the day a pilot has a script that legitimately runs longer. */
export const DEFAULT_RUN_CAP_MS=45*60_000;

export const SCRIPTS_DIR=new URL('./scripts/',import.meta.url);

export interface RunOutcome {
  script:string;
  outcome:'done'|'failed'|'blocked';
  reason?:string;
  jobs:JobOutcome[];
  /** What the script itself wanted the agent to see beyond its sentence — counts, ids. */
  result?:Record<string,unknown>;
  /** Carried up from the job that stopped for it, so the runner journals it once (C13). */
  moved?:Reconciliation;
}

export interface RunOptions {
  account:ReadinessAccount;
  command:ReadinessCommand;
  script:string;
  params:Record<string,unknown>;
  /** The facts the rules read between jobs. Asked for afresh each time: the world moves. */
  facts:()=>Promise<Facts|null>;
  mood:Mood;
  home?:string;
  permissions?:Facts['permissions'];
  runtime?:string;
  /** A run being re-run after a restart: its first job re-enters where the world says. */
  resume?:RunRecord;
  /** The run's identity, when the caller already told someone what it was. */
  started?:string;
  capMs?:number;
  /** Every write of the record, so a caller can answer `status` without reading the disk. */
  onProgress?:(record:RunRecord)=>void;
  scriptsDir?:URL;
}

const NAME=/^[a-z][a-z0-9-]*$/;
const message=(error:unknown)=>error instanceof Error?error.message:String(error);

/** The run a script finished on its own terms: the `JobOutcome` it returned, over the
 * derived sentence. Its `result` travels to the juncture as the run's — through JSON first,
 * which drops the functions a script has no business handing the agent and is what the run
 * record has to survive anyway. `job` is the script's own name, which the run already says. */
function said(script:string,jobs:JobOutcome[],value:JobOutcome|void):RunOutcome {
  const spoke=value&&typeof value==='object'?value:undefined;
  let result:Record<string,unknown>|undefined;
  try {result=JSON.parse(JSON.stringify(spoke?.result??{})) as Record<string,unknown>;}
  catch {result=undefined;}
  return {script,outcome:spoke?.outcome??'done',jobs,
    reason:spoke?.reason??`${script} done: ${jobs.length} job${jobs.length===1?'':'s'}`,
    ...result&&Object.keys(result).length?{result}:{}};
}

/** The scripts the dispatch tool may name, with the parameters each one takes. */
export async function listScripts(dir:URL=SCRIPTS_DIR):Promise<{name:string;params:unknown}[]> {
  const files=readdirSync(dir).filter(file=>file.endsWith('.ts')&&!file.endsWith('.test.ts'));
  const rows=[];
  for(const file of files.sort()) {
    const name=file.slice(0,-3);
    const loaded=await import(new URL(file,dir).href) as {params?:unknown};
    rows.push({name,params:loaded.params??{type:'object',properties:{}}});
  }
  return rows;
}

/** What the script says it takes, checked before it runs: a run that cannot be meant is a
 * refusal at the juncture, not a job started on a parameter the script will not find. */
export function checkParams(schema:any,params:Record<string,unknown>):string[] {
  const properties=(schema?.properties??{}) as Record<string,{type?:string}>;
  const gaps:string[]=[];
  for(const name of (schema?.required??[]) as string[])
    if(params[name]===undefined)gaps.push(`${name} is required`);
  for(const [name,value] of Object.entries(params)) {
    const expected=properties[name]?.type;
    if(!expected){gaps.push(`${name} is not a parameter of this script`);continue;}
    const actual=Array.isArray(value)?'array':typeof value;
    const ok=expected==='integer'?Number.isInteger(value)
      :expected==='number'?actual==='number':actual===expected;
    if(!ok)gaps.push(`${name} must be ${expected}`);
  }
  return gaps;
}

/** Load a script by name, lint it, and check the parameters against what it says it takes.
 * Every refusal a run can make before it starts is made here, so a caller can ask for them
 * and answer the agent rather than starting a job that cannot finish. */
export async function prepareRun(script:string,params:Record<string,unknown>,dir:URL=SCRIPTS_DIR) {
  const loaded=await load(script,dir);
  const gaps=checkParams(loaded.params,params);
  if(gaps.length)throw new Error(`Script ${script}: ${gaps.join('; ')}`);
  return loaded;
}

/** Load a script by name after the lint passes. Refuses before anything reaches the game. */
async function load(script:string,dir:URL) {
  if(!NAME.test(script))throw new Error(`Unknown script: ${JSON.stringify(script)}`);
  const url=new URL(`${script}.ts`,dir);
  let source:string;
  try {source=readFileSync(url,'utf8');}
  catch {throw new Error(`Unknown script: ${script}`);}
  const path=fileURLToPath(url);
  const lint=lintScript(source,path);
  if(!lint.ok)throw new Error(`Script ${script} is not admissible: ${lint.errors.join('; ')}`);
  const loaded=await import(url.href) as
    {default?:(ctx:Ctx,params:any)=>Promise<JobOutcome|void>;params?:unknown};
  if(typeof loaded.default!=='function')
    throw new Error(`Script ${script} exports no default function to run`);
  return loaded;
}

export async function runScript(options:RunOptions):Promise<RunOutcome> {
  const {account,command,script,params,facts,runtime,resume,onProgress}=options;
  const loaded=await prepareRun(script,params,options.scriptsDir??SCRIPTS_DIR);

  // The hold at the run's start is the pilot's own. A resumed run reads it back rather than
  // looking, because what it is looking at includes the take it was carrying home.
  let keep=resume?.keep;
  if(!keep){await account.refresh();keep=ownHold(account.state);}

  const record:RunRecord={script,params,started:options.started??resume?.started??new Date().toISOString(),
    keep,ended:false};
  const jobs:JobOutcome[]=[];
  const save=()=>{if(runtime)writeRun(runtime,record);onProgress?.({...record});};
  save();
  if(runtime)journalRun(runtime,{phase:'started',script,params,started:record.started});

  let resuming=Boolean(resume);
  const ctx:Ctx={
    account,command,mood:options.mood,permissions:options.permissions??{},jobs,keep,
    ...options.home===undefined?{}:{home:options.home},
    ...runtime===undefined?{}:{runtime},
    check:async job=>{
      // A pilot with no mood is a pilot at rest: no stance, and no rule of the shift to
      // apply. The menu answers the same way rather than inventing bounds (N7).
      const now=await facts();
      const stop=now&&jobStop(now);
      if(stop)throw new Blocked(`${job} not started: ${stop}`);
    },
    progress:update=>{Object.assign(record,update);save();},
    resuming:()=>{const was=resuming;resuming=false;return was;},
  };

  const capMs=options.capMs??DEFAULT_RUN_CAP_MS;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const cap=new Promise<{cap:true}>(resolve=>{
    timer=setTimeout(()=>resolve({cap:true}),capMs);
    timer.unref?.();
  });
  // ponytail: the cap ends the RUN, not the call in flight — a game command cannot be
  // recalled. The next juncture reconciles from live state, which is what it does anyway.
  const ran=await Promise.race([
    loaded.default!(ctx,params).then(said=>({said}),(error:unknown)=>({error})),
    cap,
  ]);
  clearTimeout(timer);

  // The precedence, top down: the cap, a throw, a job that did not finish, what the script
  // returned, the derived sentence. A script speaks for its own run, never over the world's.
  const stopped=jobs.find(job=>job.outcome!=='done');
  const outcome:RunOutcome='cap' in ran
    ?{script,outcome:'failed',reason:`timeout: the run passed its ${Math.round(capMs/1000)} second cap`,jobs}
    :'error' in ran
      ?{script,outcome:ran.error instanceof Blocked?'blocked':'failed',
        reason:message(ran.error),jobs}
      :stopped
        ?{script,outcome:stopped.outcome,jobs,
          reason:`${script} ${stopped.outcome} at job ${jobs.indexOf(stopped)+1} of ${jobs.length}: ${stopped.reason}`}
        :said(script,jobs,ran.said);
  const moved=(stopped??jobs.at(-1))?.moved;
  if(moved)outcome.moved=moved;

  record.ended=true;
  record.outcome={...outcome};
  save();
  if(runtime) {
    // A move the world made gets its own line: a reader of the journal should find it
    // without digging it out of a run outcome (S45, C13).
    if(outcome.moved)journalRun(runtime,{script,started:record.started,
      ...outcome.moved as unknown as Record<string,unknown>},'unsolicited_move');
    journalRun(runtime,{phase:'ended',started:record.started,...outcome});
  }
  return outcome;
}
