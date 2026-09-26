/** One run: `pilot/index.ts` under the runtime dir, validated, executed, streamed, journalled.
 *
 * The pilot's file is the composition; this is the machinery around it. Three gates before
 * anything reaches the game — tsc, the import boundary, the game policy — then the runtime
 * is bound, `main()` runs, the returned Outcome is rendered to prose, the record is written
 * and the next juncture raised. No wall-clock cap: `stop` is the way out.
 */
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync,existsSync,mkdirSync,readFileSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {checkTree,specifiers} from './play/boundary.ts';
import {checkPolicy} from './play/policy.ts';
import {prose} from './play/prose.ts';
import {runSummary} from './play/menu.ts';
import {disengage} from './play/combat/hunting.ts';
import {battleNow} from './travel.ts';
import {bind,command,line,outcome as build,progress,runCalls,Stopped,unbind,type Binding} from './play/runtime.ts';
import type {Outcome} from './play/types.ts';
import {restNow} from './play/rest.ts';
import {journalRun,writeRun,type RunRecord} from './run-record.ts';

const PLUGIN=fileURLToPath(new URL('..',import.meta.url));
const PLAY=join(PLUGIN,'src','play');
const EXAMPLE=join(PLAY,'pilot','index.ts.example');

/** Raising the juncture is running an argv: the cron jobs file is held by a cross-process
 * lock only Python takes, so the runner asks a Python one-shot rather than editing it. */
export type Wake=(argv:string[])=>void;
export function wakeArgv(value=process.env.SPACEMOLT_WAKE):string[] {
  try {const argv=JSON.parse(value??'') as unknown;return Array.isArray(argv)&&argv.length?argv.map(String):[];}
  catch {return [];}
}
export const QUICK_FAIL_MS=60_000;
export const spawnWake:Wake=argv=>{
  execFile(argv[0]!,argv.slice(1),(error,_stdout,stderr)=>{
    console.error(error?`juncture wake failed: ${String(stderr).trim()||error.message}`:'juncture wake: ok');
  });
};

/** The pilot's directory, ready to typecheck and run: `pilot/index.ts` (from the example on
 * first use), `node_modules/play` and `node_modules/@spacemolt` linked so the bare specifiers
 * resolve for tsc and for node alike, and the tsconfig tsc is pointed at.
 *
 * ponytail: symlinks, which Windows grants only a privileged process. The bridge runs on
 * macOS and Linux; copy the day that changes. */
export function pilotHome(runtime:string):{dir:string;entry:string;tsconfig:string} {
  const dir=join(runtime,'pilot'),entry=join(dir,'index.ts');
  mkdirSync(dir,{recursive:true});
  if(!existsSync(entry))copyFileSync(EXAMPLE,entry);
  const modules=join(runtime,'node_modules');
  mkdirSync(modules,{recursive:true});
  const link=(from:string,to:string)=>{
    try {symlinkSync(from,to,'dir');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  };
  link(PLAY,join(modules,'play'));
  link(join(PLUGIN,'node_modules','@spacemolt'),join(modules,'@spacemolt'));
  const tsconfig=join(runtime,'tsconfig.json');
  writeFileSync(tsconfig,JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',
    strict:true,noEmit:true,allowImportingTsExtensions:true,skipLibCheck:true,types:['node'],
    typeRoots:[join(PLUGIN,'node_modules','@types')]},include:['pilot/**/*.ts']},null,2));
  return {dir,entry,tsconfig};
}

const TSC=join(PLUGIN,'node_modules','typescript','bin','tsc');
function tsc(tsconfig:string):Promise<string[]> {
  return new Promise(resolveTsc=>{
    execFile(process.execPath,[TSC,'--noEmit','--pretty','false','-p',tsconfig],{cwd:dirname(tsconfig),maxBuffer:4<<20},(error,stdout)=>{
      if(!error)return resolveTsc([]);
      const lines=String(stdout).split('\n').filter(line=>line.trim());
      resolveTsc(lines.length?lines:[error.message]);
    });
  });
}

export interface Check {ok:boolean;entry:string;sha:string;errors:string[]}

const FRAME=/^(.+?)\((\d+),(\d+)\)/;
/** A tsc error with the offending line under it. A line and a column alone send the pilot
 * back to re-read the file it has just written, which is what the whole-file echo used to
 * pay for; the line itself is the cheap half of that. */
function framed(dir:string,errors:string[]):string[] {
  const cache=new Map<string,string[]>();
  return errors.map(text=>{
    const hit=FRAME.exec(text);
    if(!hit)return text;
    const [,file,at]=hit;
    if(!cache.has(file!)) {
      try {cache.set(file!,readFileSync(resolve(dir,file!),'utf8').split('\n'));}
      catch {cache.set(file!,[]);}
    }
    const source=cache.get(file!)![Number(at)-1];
    return source===undefined?text:`${text}\n    ${at} | ${source}`;
  });
}

/** The three gates over `pilot/index.ts` and every sibling it imports. Any failure is the
 * run's whole answer; nothing is executed. */
export async function check(runtime:string):Promise<Check> {
  const {entry,tsconfig}=pilotHome(runtime);
  const sha=createHash('sha256').update(readFileSync(entry)).digest('hex').slice(0,12);
  const errors=await tsc(tsconfig);
  if(errors.length)return {ok:false,entry,sha,errors:framed(dirname(tsconfig),errors).map(line=>`tsc: ${line}`)};
  const boundary=checkTree(entry);
  if(!boundary.ok)return {ok:false,entry,sha,errors:boundary.errors};
  const policy:string[]=[];
  const seen=new Set<string>(),queue=[entry];
  while(queue.length) {
    const path=queue.shift()!;
    if(seen.has(path))continue;
    seen.add(path);
    const source=readFileSync(path,'utf8');
    policy.push(...checkPolicy(source,path,path===entry).errors);
    for(const spec of specifiers(source))if(spec.startsWith('./'))queue.push(join(dirname(path),spec));
  }
  return {ok:!policy.length,entry,sha,errors:policy};
}

export interface RunDeps extends Omit<Binding,'runtime'> {
  runtime:string;
  wake?:Wake;
  /** A record being re-run after a restart. */
  resume?:RunRecord;
}
/** What a run answers with: the sentence, the reason and the rendered report — never the
 * Outcome itself, which is kilobytes of ship, location and skills. That stays in `run.json`
 * and the journal, where a reader who wants it can go and look. */
export interface RunResult {
  accepted:boolean;
  status?:Outcome['status'];
  /** The Outcome's `did`. */
  reason?:string;
  why?:string;
  /** The rendered report of the returned Outcome. */
  prose?:string;
  errors?:string[];
  /** The sha of `pilot/index.ts` as it ran. */
  sha?:string;
  started:string;
  ended_at?:string;
  commands?:number;
}

/** A battle still running when the script returns is unattended combat. The pilot is blind
 * between runs — the 2026-09-25 22:20 death happened in four minutes of dead air *after* the
 * script came back — so a run may not hand control over with a fight on. It breaks the fight
 * off while it still has the runtime bound, and when even that cannot end it, the run says so
 * where nothing reading its report can miss it: the ship will not travel, jump or undock until
 * the battle ends, whatever the next juncture decides to do.
 *
 * Null when no battle held the ship, which is the ordinary case and costs one read. */
async function closeBattle():Promise<{opponent:string;ended:boolean}|null> {
  const fight=await battleNow(command);
  if(!fight)return null;
  line(`the run returned with a battle still live against ${fight.opponent}: breaking off before handing back`);
  let ended=false;
  try {ended=await disengage();} catch(error){line(`breaking off threw: ${message(error)}`);}
  return {opponent:fight.opponent,ended};
}

const isOutcome=(value:unknown):value is Outcome<unknown>=>
  Boolean(value)&&typeof value==='object'&&typeof (value as Outcome).status==='string'&&typeof (value as Outcome).did==='string';
const message=(error:unknown)=>error instanceof Error?error.message:String(error);

/** Validate, bind, import fresh, run `main()`, report. Every exit path journals the end,
 * writes the record, unbinds the runtime and raises the juncture. */
export async function runPilot(deps:RunDeps):Promise<RunResult> {
  const {runtime,resume}=deps;
  const started=resume?.started??new Date().toISOString();
  const gate=await check(runtime);
  if(!gate.ok)return {accepted:false,reason:`pilot/index.ts is not admissible`,errors:gate.errors,started};
  const record:RunRecord={script:'index.ts',source:gate.sha,started,ended:false};
  const save=()=>writeRun(runtime,record);
  save();
  journalRun(runtime,{phase:'started',script:'index.ts',sha:gate.sha,started,...resume?{resumed:true}:{}});
  bind({...deps});
  line(`run started ${started}  index.ts sha ${gate.sha}  mood ${deps.pilot().mood??'-'}  stance ${deps.pilot().stance??'-'}`);
  /** A record with no stance or mood is a pilot at rest, and every mood-gated call refuses in that
   * state (`admit`), so the script cannot accomplish anything whatever it contains.
   *
   * Live 2026-09-25, 23:07Z: one run started with this exact header — `mood - stance -` — and spent
   * the whole juncture on 38 identical `hunt not started: the pilot record names no mood` refusals
   * across four systems, cycling, with zero reflections. The gating chain was right at every step
   * and `rest()` had cleared the record as designed; what was missing was anyone asking the question
   * at the top, where the answer was already printed.
   *
   * One guard here kills the class. A retry limit on each mood-gated call would not: there are a
   * dozen of them, and the next one burns the juncture just as well. */
  const shiftless=!deps.pilot().stance||!deps.pilot().mood
    ?'no shift is open: the pilot record names '
      +`${!deps.pilot().stance&&!deps.pilot().mood?'no stance and no mood'
        :!deps.pilot().stance?'no stance':'no mood'}`
      +', so every job would refuse and nothing this script does can work. '
      +'Do not run a script: call spacemolt_reflect with a goal, a stance and a mood, and end the turn.'
    :null;
  let result:Outcome<unknown>;
  if(shiftless) {
    line(shiftless);
    result=build('no run was started','refused',{shiftless:true},shiftless);
  }
  else try {
    const url=pathToFileURL(gate.entry);
    const loaded=await import(`${url.href}?v=${statSync(gate.entry).mtimeMs}-${gate.sha}`) as {default?:()=>Promise<unknown>};
    if(typeof loaded.default!=='function')throw new Error('pilot/index.ts exports no default function');
    const returned=await loaded.default();
    result=isOutcome(returned)?returned:build('main returned nothing to report','done',{returned:returned??null});
  } catch(error) {
    // A stop that reached the program's own code (a paused `ask()` rejects with it) is a stop,
    // as it is inside any library call: `partial`, not a broken script.
    result=error instanceof Stopped?build('the run was stopped','partial',{},message(error))
      :build('the run broke','failed',{},message(error));
  }
  // Before the report is rendered, so the fact is in the report rather than after it.
  const held=await closeBattle();
  if(held) {
    const why=held.ended
      ?`the run ended mid-battle against ${held.opponent}; it was broken off before the run closed`
      :`BATTLE STILL LIVE against ${held.opponent}: the run ended mid-fight and could not break off. `
        +'Nothing will move the ship until it ends; disengage() is the first call of the next run';
    line(why);
    result={...result,...held.ended?{}:{status:'partial'},why:result.why?`${why}; ${result.why}`:why};
  }
  // Rest is a barrel call now, and a script that broke never reached its own `rest()` line. Tired
  // is imposed by the runtime and rest is the only thing that clears it, so a pilot left Tired and
  // docked is one that can no longer start work and — reflection happening only at rest — can no
  // longer change stance either. That is a deadlock with no human in it to break, so the runner
  // ends the shift here, and only here: after any other run the boundary stays the pilot's.
  if(deps.pilot().mood==='Tired'&&deps.account.state.location?.docked_at) {
    try {
      const ended=await restNow(deps.account,command,deps.pilot(),deps.setPilot,runtime);
      line(ended.rested
        ?'tired and docked when the run ended: the shift was put down for the pilot, and the next juncture reflects'
        :`tired and docked when the run ended, but rest is not admissible: ${ended.reason}`);
    } catch(error){line(`tired and docked when the run ended, but rest broke: ${message(error)}`);}
  }
  const text=prose(result,runCalls());
  for(const said of text.split('\n'))line(said);
  const {commands}=progress();
  const work=runSummary(result.status);
  journalRun(runtime,{phase:'ended',script:'index.ts',started,outcome:result.status,reason:result.did,commands,...work?{work}:{}});
  line(`run ended  ${result.status}  ${commands} commands`);
  unbind();
  record.ended=true;
  record.last_job=result.fn;
  const ended_at=new Date().toISOString();
  record.outcome={sha:gate.sha,started,ended:true,ended_at,status:result.status,did:result.did,
    ...result.why?{why:result.why}:{},prose:text,commands};
  save();
  // A run that failed inside a minute did no work; its juncture would only try the same thing
  // again at once. The schedule carries that one. Real work, however it ended, gets its juncture.
  // A run left with a live battle is the one thing that must not wait for the schedule, so it
  // is never "brief": the juncture it raises is how a pilot learns the ship is still in a fight.
  const brief=!held&&result.status!=='done'&&Date.now()-Date.parse(started)<QUICK_FAIL_MS;
  const argv=brief?[]:wakeArgv();
  if(brief)journalRun(runtime,{job:'index.ts',message:'juncture left to the schedule: failed inside a minute'},'log');
  if(argv.length) {
    journalRun(runtime,{job:'index.ts',message:'juncture raised'},'log');
    try {(deps.wake??spawnWake)(argv);} catch(error){console.error(`juncture wake failed: ${message(error)}`);}
  }
  return {accepted:true,status:result.status,reason:result.did,...result.why?{why:result.why}:{},
    prose:text,sha:gate.sha,started,ended_at,commands};
}

/** Where the plugin's own play library is, for a caller that wants to read it. */
export const playDir=()=>resolve(PLAY);
