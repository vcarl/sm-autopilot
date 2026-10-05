/** One run: `pilot/index.ts` under the runtime dir, validated, executed, streamed, journalled.
 *
 * The pilot's file is the composition; this is the machinery around it. Three gates before
 * anything reaches the game — tsc, the import boundary, the game policy — then the runtime
 * is bound, `main()` runs, the returned Outcome is rendered to prose and the record is written.
 * The next juncture is cron's interval, not the run's business.
 *
 * A run is capped by the wall clock (`RUN_CAP_MS`): the stop flag is raised at the cap, and a
 * script that ignores it is cut off `RUN_GRACE_MS` later. Both land well inside the transport's
 * own request timeout, so the bridge ends its run itself and the kill in `service.py` is only a
 * backstop.
 */
import {execFile,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,existsSync,mkdirSync,readFileSync,readlinkSync,statSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Cause,Effect,Exit,Result,Schema} from 'effect';
import * as play from './play/index.ts';
import {checkTree,specifiers} from './play/boundary.ts';
import {checkPolicy} from './play/policy.ts';
import {ofTheRun,prose} from './play/prose.ts';
import {runSummary} from './play/menu.ts';
import {disengage,FIGHT_CEILING_MS} from './play/combat/hunting.ts';
import {battleAtCloseEffect} from './travel.ts';
import {bind,defect,edge,InterruptsRead,line,listen,outcome as build,progress,reached,runCalls,stateSnapshot,stop,stopped,Stopped,unbind,type Binding,type Interrupts} from './play/runtime.ts';
import {rawError} from './play/game.ts';
import {resupplyEffect} from './play/service.ts';
import type {Outcome} from './play/types.ts';
import {journalRun,writeRun,type RunRecord} from './run-record.ts';
import {warmCheck} from './check-service.ts';

const PLUGIN=fileURLToPath(new URL('..',import.meta.url));
const PLAY=join(PLUGIN,'src','play');
const EXAMPLE=join(PLAY,'pilot','index.ts.example');
/** tsc resolves `play` to its generated declarations (`npm run gen:play`), node to the source: the pilot's
 * check then parses and checks no library implementation, and Effect only where a declaration imports it. */
const PLAY_TYPES={play:[join(PLUGIN,'play.gen','play','index.d.ts')],'play/*':[join(PLUGIN,'play.gen','play','*','index.d.ts')]};
/** The plugin's git HEAD as this bridge loaded it: with the TypeScript fingerprint `service.py`
 * booted it on (`SPACEMOLT_SOURCES`), the code a run's lines were written by. Null outside a checkout. */
const CODE_SHA=(()=>{try {return execFileSync('git',['rev-parse','HEAD'],{cwd:PLUGIN,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();} catch {return null;}})(); // edge: no git or no checkout is the ordinary install, and the stamp is null

/** 24 minutes, then the stop flag; 2 more for the script to honour it. Both inside the 30 of
 * `service.REQUEST_TIMEOUT`, leaving room for the battle check and the record after. */
export const RUN_CAP_MS=24*60_000,RUN_GRACE_MS=2*60_000;
/** What breaking off a fight may take past the cap and its grace: 2 of the 4 minutes `REQUEST_TIMEOUT`
 * leaves, the rest for the resupply's stop and the record, so a capped run still answers in time. */
export const CLOSE_MS=2*60_000;

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
  // Live 2026-10-02 (F-U02): a link kept from another checkout ran that checkout's `play`, which this
  // bridge never bound, so every run broke with "the play runtime is not bound". Replace it.
  const link=(from:string,to:string)=>{
    try {if(readlinkSync(to)===from)return; unlinkSync(to);}
    catch(error){ // edge: a missing link is the first run; any other fs error goes up
      if(!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw error;
    }
    symlinkSync(from,to,'dir');
  };
  link(PLAY,join(modules,'play'));
  link(join(PLUGIN,'node_modules','@spacemolt'),join(modules,'@spacemolt'));
  // verbatimModuleSyntax judges a file by its package's `type`; the pilot's files are ES modules.
  writeFileSync(join(runtime,'package.json'),'{"type":"module"}\n');
  const tsconfig=join(runtime,'tsconfig.json');
  writeFileSync(tsconfig,JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',
    strict:true,verbatimModuleSyntax:true,noEmit:true,allowImportingTsExtensions:true,skipLibCheck:true,types:['node'],paths:PLAY_TYPES,
    typeRoots:[join(PLUGIN,'node_modules','@types')]},include:['pilot/**/*.ts']},null,2));
  return {dir,entry,tsconfig};
}

const TSC=join(PLUGIN,'node_modules','typescript','bin','tsc');
function tsc(tsconfig:string):Promise<string[]> {
  return new Promise(resolveTsc=>{
    execFile(process.execPath,[TSC,'--noEmit','--pretty','false','-p',tsconfig],{cwd:dirname(tsconfig),maxBuffer:4<<20},(error,stdout,stderr)=>{
      if(!error)return resolveTsc([]);
      const lines=String(stdout).split('\n').filter(line=>line.trim());
      // A child that dies with no diagnostics (a signal, a crash, a spawn failure) says why on stderr, not in error.message.
      resolveTsc(lines.length?lines:[`${error.message}${error.signal?` (signal ${error.signal})`:''}${String(stderr).trim()?`: ${String(stderr).trim().slice(0,500)}`:''}`]);
    });
  });
}

/** The warm service unless `warm:false` asks for the `tsc` child; a service that throws falls back to the
 * child too. Each check journals `check_ms` and which path answered. */
async function typecheck(runtime:string,tsconfig:string,sha:string,warm:boolean):Promise<string[]> {
  const t0=performance.now();
  let errors:string[]|null=null,failed:string|undefined;
  if(warm)try {errors=warmCheck(tsconfig);} catch(error){failed=message(error);} // edge: the CLI still checks; the failure is journalled
  const used=errors!==null;
  errors??=await tsc(tsconfig);
  journalRun(runtime,{sha,warm:used,check_ms:Math.round(performance.now()-t0),errors:errors.length,...failed===undefined?{}:{warm_error:failed}},'check');
  return errors;
}

export interface Check {ok:boolean;entry:string;sha:string;errors:string[]}

/** Live 2026-09-30/10-01 (11 refusals): `Cannot find name 'stopped'` where `stopped` is a `play`
 * export the program never imported. tsc says only that the name is unknown. */
const MISSING=/error TS2304: Cannot find name '([^']+)'/;
function hinted(text:string):string {
  const name=MISSING.exec(text)?.[1];
  return name&&Object.hasOwn(play,name)?`${text} (${name} is exported by 'play': add it to your import)`:text;
}

const FRAME=/^(.+?)\((\d+),(\d+)\)/;
/** A tsc error with the offending line under it. A line and a column alone send the pilot
 * back to re-read the file it has just written, which is what the whole-file echo used to
 * pay for; the line itself is the cheap half of that. */
function framed(dir:string,errors:string[]):string[] {
  const cache=new Map<string,string[]>();
  return errors.map(text=>{
    const hit=FRAME.exec(text);
    text=hinted(text);
    if(!hit)return text;
    const [,file,at]=hit;
    if(file===undefined)return text;
    let lines=cache.get(file);
    if(!lines) {
      try {lines=readFileSync(resolve(dir,file),'utf8').split('\n');}
      catch {lines=[];} // edge: tsc names files that may not exist (a lib path, a deleted one); the line stays without its source
      cache.set(file,lines);
    }
    const source=lines[Number(at)-1];
    return source===undefined?text:`${text}\n    ${at} | ${source}`;
  });
}

/** The three gates over `pilot/index.ts` and every sibling it imports. Any failure is the
 * run's whole answer; nothing is executed. */
export async function check(runtime:string,{warm=true}:{warm?:boolean}={}):Promise<Check> {
  const {entry,tsconfig}=pilotHome(runtime);
  const sha=createHash('sha256').update(readFileSync(entry)).digest('hex').slice(0,12);
  const errors=await typecheck(runtime,tsconfig,sha,warm);
  if(errors.length)return {ok:false,entry,sha,errors:framed(dirname(tsconfig),errors).map(line=>`tsc: ${line}`)};
  const boundary=checkTree(entry);
  if(!boundary.ok)return {ok:false,entry,sha,errors:boundary.errors};
  const policy:string[]=[];
  const seen=new Set<string>(),queue=[entry];
  for(let path=queue.shift();path!==undefined;path=queue.shift()) {
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
  /** The wall-clock cap and the grace after it; tests shorten them. */
  capMs?:number;
  graceMs?:number;
  /** The break-off allowance past both (`CLOSE_MS`); tests shorten it. */
  closeMs?:number;
  /** The juncture that asked for this run (`runtime/juncture.json` as the Python handler read it). */
  juncture?:{readonly juncture_id?:string|null;readonly at?:string|null};
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
  /** The script ignored the stop at the cap and was left behind; the bridge must exit so it
   * cannot send another command. */
  abandoned?:boolean;
}

/** The pilot's program as it was checked, kept by sha beside the file it overwrote, so a reader
 * of the journal can see exactly what a run or a refusal was about. */
function keepProgram(runtime:string,entry:string,sha:string):void {
  try {
    const dir=join(runtime,'programs');
    mkdirSync(dir,{recursive:true});
    const kept=join(dir,`${sha}.ts`);
    if(!existsSync(kept))copyFileSync(entry,kept);
  } catch(error) {journalRun(runtime,{job:'keepProgram',message:`the program was not kept: ${message(error)}`},'log');} // edge: the record of a program is never worth a run
}

/** A battle still running when the script returns is unattended combat. The pilot is blind
 * between runs — the 2026-09-25 22:20 death happened in four minutes of dead air *after* the
 * script came back — so a run may not hand control over with a fight on. It breaks the fight
 * off while it still has the runtime bound, and when even that cannot end it, the run says so
 * where nothing reading its report can miss it: the ship will not travel, jump or undock until
 * the battle ends, whatever the next juncture decides to do.
 *
 * Null when no battle held the ship, which is the ordinary case and costs one read. A refused read is
 * "no battle"; a lost one is re-read and, still lost, is not taken as "no battle" (U21's rule,
 * `battleAtCloseEffect`): the run breaks off anyway, and `disengage`'s own reads decide. A defect in the
 * read is a bug, journalled as one, and is still not allowed to skip the report or Tired's resupply. */
async function closeBattle(answerBy:number):Promise<{opponent:string;ended:boolean}|null> {
  // Found in review 2026-10-03: a run cut off at the cap broke off for up to the 5 minute ceiling,
  // 31 minutes in all, past the request's 30. A bound reached is the battle reported still live.
  const bound=()=>Math.min(FIGHT_CEILING_MS,Math.max(0,answerBy-Date.now()));
  const read=await edge(Effect.gen(function*() {
    const seen=yield* Effect.exit(battleAtCloseEffect());
    if(Exit.isSuccess(seen))return build('read the battle','done',{fight:seen.value});
    defect('closeBattle',seen.cause);
    line(`reading the battle threw: ${Cause.pretty(seen.cause)}`);
    return build('read the battle','failed',{fight:undefined});
  }));
  const fight=reached(read)?.fight;
  if(!fight)return null;
  if(fight==='unknown') {
    line("the battle's status was lost three times at the flight's end: breaking off in case a fight is live");
    // `disengage` is an edge: a bug in it is a `defect` line and `false`, never a throw.
    return await disengage(bound())?null:{opponent:'an opponent the lost status never named',ended:false};
  }
  line(`the flight returned with a battle still live against ${fight.opponent}: breaking off before handing back`);
  return {opponent:fight.opponent,ended:await disengage(bound())};
}

const STATUSES=['done','partial','refused','failed'] as const;
const statusOf=(value:unknown)=>STATUSES.find(status=>status===value);
const isObject=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object';
/** What the play library builds: every field the report reads, checked. */
const isOutcome=(value:unknown):value is Outcome<unknown>=>isObject(value)&&statusOf(value.status)!==undefined
  &&typeof value.did==='string'&&isObject(value.gained)&&Array.isArray(value.gained.items)&&isObject(value.gained.xp)
  &&isObject(value.now)&&isObject(value.now.skills)&&isObject(value.cost)&&Array.isArray(value.next);
/** What `main()` returned, as an Outcome the report can trust. One the play library built is kept
 * as is; a hand-built one (live 2026-09-28: `gained:{}`, `now:null`) keeps its words — status,
 * did, why, next, detail — and takes the measured cost, gains and present from the runtime. */
function settle(returned:unknown):Outcome<unknown> {
  const status=isObject(returned)?statusOf(returned.status):undefined;
  if(!isObject(returned)||status===undefined||typeof returned.did!=='string')
    return build('main returned nothing to report','done',{returned:returned??null});
  if(isOutcome(returned))return returned;
  const {next}=returned;
  const built=build(returned.did,status,returned.detail??{},typeof returned.why==='string'&&returned.why?returned.why:undefined);
  return Array.isArray(next)?{...built,next:next.filter(text=>typeof text==='string').slice(0,3)}:built;
}
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const decodeInterrupts=Schema.decodeUnknownResult(InterruptsRead);

/** The module's `interrupts` export, as the run takes it: the declaration, null when there is none,
 * or why it did not read. One that does not read interrupts nothing (observe, don't gate). */
function interruptsOf(loaded:unknown):{declared:Interrupts|null;journal:Record<string,unknown>} {
  const raw=isObject(loaded)?loaded.interrupts:undefined;
  if(raw===undefined)return {declared:null,journal:{interrupts:null}};
  const read=decodeInterrupts(raw);
  return Result.isSuccess(read)?{declared:read.success,journal:{interrupts:read.success}}
    :{declared:null,journal:{interrupts:null,interrupts_unread:read.failure.message}};
}

/** Validate, bind, import fresh, run `main()`, report. Every exit path journals the end,
 * writes the record and unbinds the runtime. */
export async function runPilot(deps:RunDeps):Promise<RunResult> {
  const {runtime}=deps;
  const started=new Date().toISOString(),run_id=randomUUID();
  const juncture=deps.juncture?.juncture_id?{juncture_id:deps.juncture.juncture_id,juncture_at:deps.juncture.at??null,
    since_juncture_s:deps.juncture.at?Math.round((Date.parse(started)-Date.parse(deps.juncture.at))/100)/10:null}:{juncture_id:null,juncture_at:null};
  const gate=await check(runtime);
  keepProgram(runtime,gate.entry,gate.sha);
  if(!gate.ok) {
    journalRun(runtime,{phase:'refused',script:'index.ts',sha:gate.sha,started,run_id,...juncture,errors:gate.errors.slice(0,5)});
    return {accepted:false,reason:`pilot/index.ts is not admissible`,errors:gate.errors,started};
  }
  // RunRecord decodes juncture_at as a string: a null here (juncture.py's `at` is `.get`) would make
  // run.json unreadable, and boot would skip closing this run `interrupted`.
  const record:RunRecord={script:'index.ts',source:gate.sha,started,ended:false,
    ...typeof deps.juncture?.at==='string'?{juncture_at:deps.juncture.at}:{}};
  const save=()=>writeRun(runtime,record);
  save();
  const who=deps.pilot();
  bind({...deps,run_id});
  // Before the module loads: a program's top-level code may send commands at import, and every line
  // it writes must follow the `run started` it joins to by `run_id`.
  journalRun(runtime,{phase:'started',script:'index.ts',sha:gate.sha,started,stance:who.stance??null,mood:who.mood??null,
    ...juncture,code_sha:CODE_SHA,sources:process.env.SPACEMOLT_SOURCES??null,start_state:stateSnapshot()});
  line(`flight launched ${started}  program ${gate.sha}  mood ${who.mood??'-'}  stance ${who.stance??'none'}`);
  const cap=deps.capMs??RUN_CAP_MS,grace=deps.graceMs??RUN_GRACE_MS;
  const timers:ReturnType<typeof setTimeout>[]=[];
  let abandoned=false;
  const cutOff=new Promise<Outcome<unknown>>(resolveCut=>{
    timers.push(setTimeout(()=>{
      line(`the flight reached the flight computer's ${Math.round(cap/60_000)}-minute limit: asking the program to stop`);
      journalRun(runtime,{job:'index.ts',message:'wall-clock cap: stop requested',cap_ms:cap},'log');
      stop(`the flight computer's ${Math.round(cap/60_000)}-minute limit`);
    },cap));
    timers.push(setTimeout(()=>{
      abandoned=true;
      resolveCut(build('the flight computer ended the flight at its ~25-minute limit','partial',{},
        `the program did not stop within ${Math.round(grace/1000)}s of being asked`));
    },cap+grace));
  });
  // A promise the program left unawaited, or a throw from one of its callbacks, would otherwise
  // take the whole bridge down and the run's cause with it: it ends this run `failed` instead.
  // Listened only while the program runs, so outside a run the process behaves as it always has.
  let crashed=(_error:unknown)=>{};
  const broke=new Promise<never>((_,reject)=>{crashed=reject;});
  const onRejection=(error:unknown)=>{stop();crashed(new Error(`unhandled rejection: ${message(error)}`));};
  const onException=(error:unknown)=>{stop();crashed(new Error(`uncaught exception: ${message(error)}`));};
  process.on('unhandledRejection',onRejection);
  process.on('uncaughtException',onException);
  // Left ref'd: a program stuck on a promise has nothing else keeping the process up, and the cap
  // is what ends that run. They are always cleared in the `finally` below.
  let result:Outcome<unknown>;
  try {
    result=await Promise.race([broke,(async()=>{
      const url=pathToFileURL(gate.entry);
      const loaded:unknown=await import(`${url.href}?v=${statSync(gate.entry).mtimeMs}-${gate.sha}`);
      // The declaration is only readable once the module has loaded: its own line, after `run started`.
      const {declared,journal}=interruptsOf(loaded);
      listen(declared);
      journalRun(runtime,journal,'interrupts');
      if(typeof journal.interrupts_unread==='string')line(`interrupts not read, so nothing interrupts this flight: ${journal.interrupts_unread}`);
      if(!isObject(loaded)||typeof loaded.default!=='function')throw new Error('pilot/index.ts exports no default function');
      const returned:unknown=await Reflect.apply(loaded.default,undefined,[]);
      return settle(returned);
    })(),cutOff]);
  } catch(error) { // edge: the pilot's own program may throw anything
    // A stop that reached the program's own code (a paused `ask()` rejects with it) is a stop,
    // as it is inside any library call: `partial`, not a broken script.
    result=error instanceof Stopped?build('the flight was stopped','partial',{},message(error))
      :build('the flight broke','failed',{},message(error));
  } finally {
    // The runtime's own closing commands (resupply, a battle broken off) are not the program's: no pause.
    listen(null);
    for(const timer of timers)clearTimeout(timer);
    process.off('unhandledRejection',onRejection);
    process.off('uncaughtException',onException);
  }
  result=ofTheRun(result,runCalls());
  // Before the report is rendered, so the fact is in the report rather than after it.
  const held=await closeBattle(Date.parse(started)+cap+grace+(deps.closeMs??CLOSE_MS));
  if(held) {
    const why=held.ended
      ?`the flight ended mid-battle against ${held.opponent}; it was broken off before the flight closed`
      :`the flight ended mid-fight against ${held.opponent} and could not break off; the battle is still live`;
    line(why);
    result={...result,...held.ended?{}:{status:'partial'},why:result.why?`${why}; ${result.why}`:why};
  }
  // Tired is the guarantee the ship gets resupplied, whatever the script did: one that ended Tired
  // (it broke, forgot, or made no work call the runtime could resupply at) is brought up here,
  // docked or not. Never while an abandoned script may still be sending, nor with a battle live.
  // A stopped run only services where it stands; otherwise the flight is stopped at the cap plus
  // its grace, so the run still ends inside the transport's timeout.
  if(!abandoned&&!(held&&!held.ended)&&deps.pilot().mood==='Tired') {
    const timer=setTimeout(stop,Math.max(0,Date.parse(started)+cap+grace-Date.now()));
    // A failure is journalled as the bug it always was, and never skips the record.
    await edge(Effect.gen(function*() {
      const exit=yield* Effect.exit(resupplyEffect({travel:!stopped(),trigger:'run_end'}));
      if(Exit.isFailure(exit)) {
        const error=rawError(exit.cause);
        defect('resupply',Cause.die(error));
        line(`the resupply at the flight's end broke: ${message(error)}`);
      }
      return build('resupplied at the flight\'s end','done',{});
    }));
    clearTimeout(timer);
  }
  // The report is words for the pilot; the end of the run is the record. A report that cannot be
  // rendered says so in the record's reason and the run still ends (live 2026-09-28, L5277).
  let text:string;
  try {text=prose(result,runCalls());}
  catch(error) { // edge: a report that cannot be rendered is said in the record, never allowed to skip it
    defect('prose',Cause.die(error));
    const why=`the report could not be rendered: ${message(error)}`;
    result={...result,why:result.why?`${result.why}; ${why}`:why};
    text=`${result.status}: ${result.did}: ${why}.`;
  }
  for(const said of text.split('\n'))line(said);
  const {commands}=progress();
  const work=runSummary(result.status);
  journalRun(runtime,{phase:'ended',script:'index.ts',sha:gate.sha,started,outcome:result.status,reason:result.did,
    ...result.why?{why:result.why}:{},commands,...work?{work}:{},...abandoned?{abandoned:true}:{},
    // ponytail: the first 40 top-level calls; `calls_total` says how many there were.
    end_state:stateSnapshot(),calls:runCalls().slice(0,40),calls_total:runCalls().length});
  line(`flight ended  ${result.status}  ${commands} commands`);
  unbind();
  record.ended=true;
  record.last_job=result.fn;
  const ended_at=new Date().toISOString();
  record.outcome={sha:gate.sha,started,ended:true,ended_at,status:result.status,did:result.did,
    ...result.why?{why:result.why}:{},prose:text,commands};
  save();
  return {accepted:true,status:result.status,reason:result.did,...result.why?{why:result.why}:{},
    prose:text,sha:gate.sha,started,ended_at,commands,...abandoned?{abandoned:true}:{}};
}

/** Where the plugin's own play library is, for a caller that wants to read it. */
export const playDir=()=>resolve(PLAY);
