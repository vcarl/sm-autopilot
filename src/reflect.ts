/** What a pilot reflects on: needs, holdings, what it has been doing, and where it has been
 * standing still (N7, N9).
 *
 * Read-only and compact. It answers the questions VISION's "Rest and reflection" asks —
 * what skills are lagging, what the ship lacks, what it owns and owes, what it has seen of
 * the world, and what it has been doing lately — and it names the ones it could not read
 * rather than guessing at them, because a reflection that invents its inputs picks a goal
 * for a pilot that does not exist.
 */
import {readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {readJournal} from './run-record.ts';
import {Effect,Result} from 'effect';
import {Game,field,type GameError} from './play/game.ts';
import type {ReadinessAccount} from './readiness.ts';
import {STANCES} from './rules-table.ts';
import {replyBody,viewStorageEffect} from './storage.ts';

/** Enough of each list to choose from; the whole report stays well under the 3 KB the
 * juncture's own context budget allows it. */
const CAP={skills:6,items:10,runs:5,bases:6,script_runs:3,reason:120};
/** How many journal entries back a reflection looks. Most of them are steps and commands,
 * which this report ignores; the runs, rests and reflections it counts are the sparse ones. */
const JOURNAL_SPAN=6_000;

/** One run as the review reads it: how it ended and what it said. */
export interface ScriptRun {outcome?:string;reason?:string}
/** A file of the pilot's own under `pilot/`, with its size and how its runs ended. */
export interface ScriptReview {name:string;saved?:true;bytes?:number;runs:number;last?:ScriptRun[]}

export interface Pilotish {objective?:string;objective_done?:boolean;goal?:string}

export interface ReflectReport {
  objective?:string;
  objective_done?:boolean;
  /** The lowest-levelled skills first: what training would move (N7). `was`/`since` are the
   * level this skill stood at in the earliest reflection the journal still holds, so an
   * objective phrased as movement ("raise the lowest by two levels") is judged against a number
   * rather than asserted. Absent when no earlier reflection is in the span, or when nothing moved. */
  skills?:{name:string;level:number;max_level:number;was?:number;since?:string}[];
  ship:{fuel:number;max_fuel:number;hull:number;max_hull:number;cargo_capacity:number;modules:string[]};
  holdings:{credits:number;storage:{base_id:string;items:number;ships:number}[];here?:{item_id:string;quantity:number}[]};
  owes:{tax_due?:number;shipping_debt?:number;carrier_tier?:string};
  recent:{script?:string;outcome?:string;reason?:string}[];
  /** The pilot's library beside how it ran: what a rest reviews and rewrites. */
  scripts?:ScriptReview[];
  stagnation:string[];
  stances:string[];
  /** Named, never guessed: the inputs this report could not read this time. */
  missing:string[];
}

/** The pilot's own code, read back against how it actually ran: every `pilot/*.ts` with its
 * size, and how the runs of `index.ts` ended. Rest is where a file that kept ending badly
 * gets rewritten. */
function scriptReview(ran:Map<string,ScriptRun[]>,runtime?:string):ScriptReview[]|undefined {
  if(!runtime)return undefined;
  let files:string[];
  try {files=readdirSync(join(runtime,'pilot')).filter(file=>file.endsWith('.ts')).sort();}
  catch {return undefined;} // edge: the pilot's directory is its own and may not exist yet
  return files.map(file=>{
    const runs=ran.get(file)??[];
    let bytes=0;
    try {bytes=statSync(join(runtime,'pilot',file)).size;} catch {/* listed, unreadable */} // edge: a file listed a moment ago may be gone
    return {name:file,saved:true as const,bytes,runs:runs.length,last:runs.slice(-CAP.script_runs)};
  });
}

/** One read that is allowed to fail: the game is on the other side of a socket and a
 * reflection is worth having without every counter answering. A game failure (a refusal, a lost
 * reply) names the read in `missing`; a defect is a bug and goes up. */
const attempt=<A,R>(missing:string[],name:string,read:Effect.Effect<A,GameError,R>)=>
  Effect.result(read).pipe(Effect.map(done=>Result.isSuccess(done)?done.success:(missing.push(name),undefined)));

/** The rows of a skills reply: a list, or (live, C23 replay) a map keyed by skill id. */
const skillList=(rows:unknown):unknown[]=>Array.isArray(rows)?rows
  :typeof rows==='object'&&rows!==null?Object.values(rows):[];

export const reflectReportEffect=(account:Pick<ReadinessAccount,'state'>,pilot:Pilotish,runtime?:string)=>Effect.gen(function*() {
  const game=yield* Game;
  const missing:string[]=[];
  yield* game.refresh;
  const {ship,player,modules}=account.state;

  // Progression desk. get_skills answers with a state section, so the account holds it
  // after the send; a reply that carries the rows directly is read from the reply.
  const skillRows=yield* attempt(missing,'skills',game.command('spacemolt/get_skills',{}).pipe(
    Effect.map(reply=>skillList(field(replyBody(reply),'skills')??account.state.skills))));
  const storage=yield* attempt(missing,'storage',viewStorageEffect());
  const tax=yield* attempt(missing,'tax',game.command('spacemolt/get_tax_estimate',{}).pipe(Effect.map(replyBody)));
  const shipping=yield* attempt(missing,'shipping_debt',game.command('spacemolt_shipping/profile',{}).pipe(Effect.map(replyBody)));
  const taxDue=tax===undefined?undefined
    :Number(field(tax,'income_tax_total')??0)+Number(field(tax,'property_tax_total')??0)-Number(field(tax,'tax_prepaid')??0);

  // The journal is the account of past work; the present came from the live reads above.
  // A shift now writes a line per step and per game command, so the history reflection needs
  // lives much further back than the default tail: read wide, and let the filters below
  // pick the few kinds of line that say where the pilot has been.
  const journal=runtime?readJournal(runtime,JOURNAL_SPAN):[];
  const chosen=new Set<string>();
  /** The oldest reflection in the span and the levels it saw: the baseline this report measures
   * against. Oldest rather than latest because an objective set several rests ago is measured
   * from before it, and the date is reported so the pilot knows what window it is reading. */
  let baseline:{at:string;levels:Map<string,number>}|undefined;
  const ranJobs=new Map<string,number>(),ranScripts=new Map<string,ScriptRun[]>();
  const recent:ReflectReport['recent']=[];
  const text=(value:unknown)=>typeof value==='string'?value:undefined;
  for(const entry of journal) {
    const event=field(entry,'event'),stance=field(entry,'stance');
    if(event==='reflection'&&stance)chosen.add(String(stance));
    // `reflection_read` is what a script's `reflection()` journals; a `reflect` request is the same
    // rows as an older bridge journalled them.
    const past=event==='reflection_read'?field(entry,'skills')
      :field(field(entry,'request'),'action')==='reflect'?field(field(field(entry,'response'),'result'),'skills'):undefined;
    if(!baseline&&Array.isArray(past)&&past.length)
      baseline={at:String(field(entry,'at')??'an unrecorded time'),
        levels:new Map(past.flatMap((row):[string,number][]=>{
          const level=field(row,'level');
          return typeof level==='number'?[[String(field(row,'name')),level]]:[];
        }))};
    if(event==='run'&&field(entry,'phase')==='ended') {
      const script=text(field(entry,'script')),outcome=text(field(entry,'outcome')),reason=text(field(entry,'reason'));
      recent.push({...script===undefined?{}:{script},...outcome===undefined?{}:{outcome},...reason===undefined?{}:{reason}});
      const name=String(field(entry,'script')??'');
      if(name) {
        const runs=ranScripts.get(name)??[];
        ranScripts.set(name,runs);
        runs.push({...outcome===undefined?{}:{outcome},reason:String(field(entry,'reason')??'').slice(0,CAP.reason)});
      }
      // `work` is the run's first work call, as `run` journals it (`runSummary`).
      const fn=field(field(entry,'work'),'fn');
      if(fn)ranJobs.set(String(fn),(ranJobs.get(String(fn))??0)+1);
    }
  }

  const base=baseline;
  const skills=skillRows?.flatMap(row=>{
    const level=field(row,'level');
    return typeof level==='number'?[{name:String(field(row,'name')),level,max_level:Number(field(row,'max_level')??0)}]:[];
  }).sort((a,b)=>(a.level-b.level)||a.name.localeCompare(b.name))
    .slice(0,CAP.skills)
    .map(row=>{
      const was=base?.levels.get(row.name);
      return {...row,...base===undefined||was===undefined||was===row.level?{}:{was,since:base.at}};
    });

  const scripts=scriptReview(ranScripts,runtime);
  const stagnation:string[]=[];
  const runCount=recent.length;
  const kinds=[...ranJobs.entries()].sort((a,b)=>b[1]-a[1]);
  const [lead]=kinds;
  if(runCount>=3&&kinds.length===1&&lead)
    stagnation.push(`every run in the journal's span led with ${lead[0]} (${lead[1]} of them)`);
  const untried=STANCES.map(stance=>stance.name).filter(name=>!chosen.has(name));
  if(untried.length)stagnation.push(`stances never chosen: ${untried.join(', ')}`);

  const report:ReflectReport={
    ...pilot.objective?{objective:pilot.objective}:{},
    ...pilot.objective_done?{objective_done:true}:{},
    ...skills?.length?{skills}:{},
    ship:{fuel:ship?.fuel??0,max_fuel:ship?.max_fuel??0,hull:ship?.hull??0,
      max_hull:ship?.max_hull??0,cargo_capacity:ship?.cargo_capacity??0,
      modules:(Array.isArray(modules)?modules:[]).map(row=>String(row.type_id))},
    holdings:{credits:player?.credits??0,
      storage:(storage?.locations??[]).slice(0,CAP.bases)
        .map(row=>({base_id:row.base_id,items:row.item_count,ships:row.ship_count})),
      ...storage?.items.length?{here:storage.items.slice(0,CAP.items)
        .map(row=>({item_id:row.item_id,quantity:row.quantity}))}:{}},
    owes:{...taxDue===undefined?{}:{tax_due:taxDue},
      ...shipping===undefined?{}:{shipping_debt:Number(field(field(shipping,'profile'),'outstanding_debt')??0),
        carrier_tier:String(field(field(shipping,'profile'),'tier')??'unknown')}},
    recent:recent.slice(-CAP.runs),
    ...scripts?.length?{scripts}:{},
    stagnation,
    stances:STANCES.map(stance=>stance.name),
    // The ship's fit against each stance's needs has no table behind it yet: D7 names the
    // counters a stance points at, never a hull or a module a stance requires.
    // No ship in the account's state: the zeros above are not readings, so say so.
    missing:[...missing,...ship?[]:['ship'],'ship fit against each stance (no per-stance ship requirement exists yet)',
      ...baseline?[]:['earlier skill levels (no reflection inside the journal\'s span to measure movement from)']],
  };
  return report;
});
