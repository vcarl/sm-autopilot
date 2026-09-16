/** One run: one script, from the dispatch that asked for it to the juncture at its end.
 *
 * The script is the agent's composition; this is the machinery around it. It refuses a
 * script the lint will not pass before any command reaches the game, builds the `Ctx` the
 * jobs are handed, keeps the rules between jobs, writes the run down so a restart knows what
 * it was doing, caps the whole thing on the wall clock, and reports one outcome.
 */
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,readdirSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
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
  /** The script the pilot wrote, when this run is one: `script` is then its source label. */
  source?:string;
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
  /** How the next juncture is raised when this run ends. Injected by the tests, which spawn
   * nothing; absent, the argv in the environment is spawned for real. */
  wake?:Wake;
}

/** Raising the juncture is running an argv: the cron jobs file is held by a cross-process
 * lock only Python takes, so the runner asks a Python one-shot rather than editing it. */
export type Wake=(argv:string[])=>void;

/** The argv the bridge was handed, or nothing at all — a runner started without one raises
 * no juncture, which is what a test harness and a bare `node src/bridge.ts` both want. */
export function wakeArgv(value=process.env.SPACEMOLT_WAKE):string[] {
  try {
    const argv=JSON.parse(value??'') as unknown;
    return Array.isArray(argv)&&argv.length?argv.map(String):[];
  } catch {return [];}
}

/** Spawn it and do not wait: the run is already over and its record already written, so the
 * only thing the wake owes anyone is a line saying whether it took. It never throws. */
export const QUICK_FAIL_MS=60_000;
export const spawnWake:Wake=argv=>{
  execFile(argv[0]!,argv.slice(1),(error,_stdout,stderr)=>{
    console.error(error
      ?`juncture wake failed: ${String(stderr).trim()||error.message}`
      :'juncture wake: ok');
  });
};

const NAME=/^[a-z][a-z0-9-]*$/;
/** A script file, in the one spelling a script name can take. A test file, a dotted name and
 * the file a source run is kept under are all off the library by the same rule. */
const SCRIPT_FILE=/^[a-z][a-z0-9-]*\.ts$/;
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const digest=(source:string)=>createHash('sha256').update(source).digest('hex').slice(0,12);

/** A run of a script the pilot wrote here and now. The source is its identity, so the
 * journal and the record name the run without carrying the whole text. */
export const sourceLabel=(source:string)=>`source:${digest(source)}`;

const files=(dir:URL):string[]=>{
  try {return readdirSync(dir).filter(file=>SCRIPT_FILE.test(file)).sort();}
  catch {return [];}
};

/** Where the pilot's own scripts live, with the barrel reachable from them.
 *
 * A saved script imports `'../jobs/index.ts'` exactly as a shipped one does, so the runtime
 * directory gets a `jobs` symlink to the real barrel and that specifier resolves for real:
 * the source the pilot wrote is the source that runs, and the lint knows one spelling.
 *
 * ponytail: a symlink, which Windows grants only a privileged process. The bridge runs on
 * macOS and Linux; copy the barrel in the day that changes.
 */
export function scriptsHome(runtime:string):URL {
  const dir=join(runtime,'scripts');
  mkdirSync(dir,{recursive:true});
  try {symlinkSync(fileURLToPath(new URL('./jobs',import.meta.url)),join(runtime,'jobs'),'dir');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  return pathToFileURL(`${dir}/`);
}

/** The shipped scripts, then the pilot's own: where a name is looked up, in that order. */
const libraries=(dir:URL,runtime?:string):[URL,boolean][]=>
  [[dir,false],...runtime?[[pathToFileURL(`${join(runtime,'scripts')}/`),true] as [URL,boolean]]:[]];

/** Write a source where the barrel resolves, once the lint has passed. The lint is the whole
 * boundary: what lands here is loaded and run against a live game account. */
function put(runtime:string,name:string,source:string):URL {
  const url=new URL(`${name}.ts`,scriptsHome(runtime));
  const lint=lintScript(source,fileURLToPath(url));
  if(!lint.ok)throw new Error(`Script ${name} is not admissible: ${lint.errors.join('; ')}`);
  writeFileSync(url,source,{mode:0o600});
  return url;
}

/** A script the pilot keeps: saved under its own name, so a later run asks for it by name
 * and a restart still has it. A shipped name stays the runner's. */
export function saveScript(runtime:string,name:string,source:string,dir:URL=SCRIPTS_DIR):{name:string;path:string} {
  if(!NAME.test(name))
    throw new Error(`A script name is lowercase letters, digits and hyphens: ${JSON.stringify(name)}`);
  if(files(dir).includes(`${name}.ts`))
    throw new Error(`${name} is a script the runner ships; save yours under another name`);
  return {name,path:fileURLToPath(put(runtime,name,source))};
}

/** One script's source, for reading: the shipped ones are the worked examples. */
export function readScript(name:string,dir:URL=SCRIPTS_DIR,runtime?:string):{name:string;saved:boolean;source:string} {
  for(const [from,saved] of libraries(dir,runtime))
    if(files(from).includes(`${name}.ts`))
      return {name,saved,source:readFileSync(new URL(`${name}.ts`,from),'utf8')};
  throw new Error(`Unknown script: ${name}`);
}

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

/** The library: the scripts the runner ships, then the ones the pilot saved, each with the
 * parameters it takes.
 *
 * ponytail: a listing imports every script to read its `params`, so a saved script's
 * top-level code runs here as well as at dispatch. The lint is what bounds that; parse the
 * `params` export out of the source instead the day a listing needs to be inert. */
export async function listScripts(dir:URL=SCRIPTS_DIR,runtime?:string):Promise<{name:string;params:unknown;saved?:boolean}[]> {
  const rows=[];
  for(const [from,saved] of libraries(dir,runtime))
    for(const file of files(from)) {
      const loaded=await import(moduleHref(new URL(file,from),saved)) as {params?:unknown};
      rows.push({name:file.slice(0,-3),params:loaded.params??{type:'object',properties:{}},
        ...saved?{saved:true}:{}});
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

/** What a run is: a script by name, or a script the pilot wrote for this run. */
export interface RunRequest {
  script?:string;
  source?:string;
  params:Record<string,unknown>;
  dir?:URL;
  runtime?:string;
}

/** Load what the run runs, lint it, and check the parameters against what it says it takes.
 * Every refusal a run can make before it starts is made here, so a caller can ask for them
 * and answer the agent rather than starting a job that cannot finish. */
export async function prepareRun(request:RunRequest) {
  const {script,source,params,dir=SCRIPTS_DIR,runtime}=request;
  if(Boolean(script)===Boolean(source))
    throw new Error('Name one of script or source: a run is a script by name, or one you wrote.');
  if(source!==undefined&&runtime===undefined)
    throw new Error('This runner has nowhere to keep a script it was handed');
  const label=source===undefined?script!:sourceLabel(source);
  const loaded=source===undefined
    ?await load(script!,dir,runtime)
    :await loadUrl(put(runtime!,`.src-${digest(source)}`,source),label,true);
  const gaps=checkParams(loaded.params,params);
  if(gaps.length)throw new Error(`Script ${label}: ${gaps.join('; ')}`);
  return {label,loaded};
}

/** A saved script is loaded by its modification time, so a script saved again under the same
 * name is the one that runs rather than the copy the module cache still holds. */
const moduleHref=(url:URL,fresh:boolean)=>fresh?`${url.href}?v=${statSync(url).mtimeMs}`:url.href;

/** Load a script by name, shipped first and then the pilot's own. */
async function load(script:string,dir:URL,runtime?:string) {
  if(!NAME.test(script))throw new Error(`Unknown script: ${JSON.stringify(script)}`);
  const found=libraries(dir,runtime).find(([from])=>files(from).includes(`${script}.ts`));
  if(!found)throw new Error(`Unknown script: ${script}`);
  return loadUrl(new URL(`${script}.ts`,found[0]),script,found[1]);
}

/** Load one script file after the lint passes. Refuses before anything reaches the game. */
async function loadUrl(url:URL,label:string,fresh:boolean) {
  const path=fileURLToPath(url);
  const lint=lintScript(readFileSync(url,'utf8'),path);
  if(!lint.ok)throw new Error(`Script ${label} is not admissible: ${lint.errors.join('; ')}`);
  const loaded=await import(moduleHref(url,fresh)) as
    {default?:(ctx:Ctx,params:any)=>Promise<JobOutcome|void>;params?:unknown};
  if(typeof loaded.default!=='function')
    throw new Error(`Script ${label} exports no default function to run`);
  return loaded;
}

export async function runScript(options:RunOptions):Promise<RunOutcome> {
  const {account,command,script,source,params,facts,runtime,resume,onProgress}=options;
  const {loaded}=await prepareRun({...source===undefined?{script}:{source},params,
    dir:options.scriptsDir??SCRIPTS_DIR,...runtime===undefined?{}:{runtime}});

  // The hold at the run's start is the pilot's own. A resumed run reads it back rather than
  // looking, because what it is looking at includes the take it was carrying home.
  let keep=resume?.keep;
  if(!keep){await account.refresh();keep=ownHold(account.state);}

  const record:RunRecord={script,params,started:options.started??resume?.started??new Date().toISOString(),
    keep,ended:false,...source===undefined?{}:{source}};
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
  // The pilot's next juncture, raised by the runner rather than waited for (N4). Every run
  // ends here — dispatched, resumed, capped or thrown — so this is the one place it belongs,
  // and it comes after the record and the `run ended` line: what the juncture reads is on
  // disk before anything is asked to read it.
  // A run that failed inside a minute did no work and its juncture would only try the same
  // thing again at once (live 2026-09-15 23:46: a hunt at a made-up poi); the schedule carries
  // that one. Real work, however it ended, gets its juncture now.
  const brief=outcome.outcome!=='done'&&Date.now()-Date.parse(record.started)<QUICK_FAIL_MS;
  const argv=brief?[]:wakeArgv();
  if(brief&&runtime)journalRun(runtime,{job:script,message:'juncture left to the schedule: failed inside a minute'},'log');
  if(argv.length) {
    if(runtime)journalRun(runtime,{job:script,message:'juncture raised'},'log');
    try {(options.wake??spawnWake)(argv);}
    catch(error){console.error(`juncture wake failed: ${message(error)}`);}
  }
  return outcome;
}
