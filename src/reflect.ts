/** What a resting pilot reflects on: needs, holdings, what it has seen, what it has been
 * doing, and where it has been standing still (N7, N9).
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
import {details} from './response-details.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {STANCES} from './rules-table.ts';
import {viewStorage} from './storage.ts';

/** Enough of each list to choose from; the whole report stays well under the 3 KB the
 * juncture's own context budget allows it. */
const CAP={skills:6,visited:16,items:10,runs:5,bases:6,script_runs:3,reason:120};
/** How many journal entries back a reflection looks. Most of them are steps and commands,
 * which this report ignores; the runs, rests and reflections it counts are the sparse ones. */
const JOURNAL_SPAN=6_000;

/** One run as the review reads it: how it ended and what it said. */
export interface ScriptRun {outcome?:string;reason?:string}
/** A file of the pilot's own under `pilot/`, with its size and how its runs ended. */
export interface ScriptReview {name:string;saved?:true;bytes?:number;runs:number;last?:ScriptRun[]}

export interface Pilotish {objective?:string;objective_done?:boolean;home?:string;goal?:string}

export interface ReflectReport {
  at_rest:true;
  objective?:string;
  objective_done?:boolean;
  home?:string;
  /** The lowest-levelled skills first: what training would move (N7). */
  skills?:{name:string;level:number;max_level:number}[];
  ship:{fuel:number;max_fuel:number;hull:number;max_hull:number;cargo_capacity:number;modules:string[]};
  holdings:{credits:number;storage:{base_id:string;items:number;ships:number}[];here?:{item_id:string;quantity:number}[]};
  owes:{tax_due?:number;shipping_debt?:number;carrier_tier?:string};
  seen:{systems_and_pois:string[];bases:string[]};
  recent:{script?:string;outcome?:string;reason?:string}[];
  /** The pilot's library beside how it ran: what a rest reviews and rewrites. */
  scripts?:ScriptReview[];
  stagnation:string[];
  stances:{name:string;initial_moods:string[]}[];
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
  catch {return undefined;}
  return files.map(file=>{
    const runs=ran.get(file)??[];
    let bytes=0;
    try {bytes=statSync(join(runtime,'pilot',file)).size;} catch {/* listed, unreadable */}
    return {name:file,saved:true as const,bytes,runs:runs.length,last:runs.slice(-CAP.script_runs)};
  });
}

/** One read that is allowed to fail: the game is on the other side of a socket and a
 * reflection is worth having without every counter answering. */
async function attempt<T>(missing:string[],name:string,read:()=>Promise<T>):Promise<T|undefined> {
  try {return await read();} catch {missing.push(name);return undefined;}
}

export async function reflectReport(account:ReadinessAccount,command:ReadinessCommand,
  pilot:Pilotish,runtime?:string):Promise<ReflectReport> {
  const missing:string[]=[];
  await account.refresh();
  const {ship,player,modules}=account.state;

  // Progression desk. get_skills answers with a state section, so the account holds it
  // after the send; a reply that carries the rows directly is read from the reply.
  const skillRows=await attempt(missing,'skills',async()=>{
    const reply=details(await command('spacemolt/get_skills',{}));
    const rows=reply.skills??account.state.skills;
    // Live get_skills answers with a map keyed by skill id, not a list (C23 replay); the
    // rows inside carry their own display name, so the map's values are the rows.
    if(Array.isArray(rows))return rows as {name?:string;level?:number;max_level?:number}[];
    return rows&&typeof rows==='object'
      ?Object.values(rows) as {name?:string;level?:number;max_level?:number}[]:[];
  });
  const skills=skillRows?.filter(row=>typeof row?.level==='number')
    .sort((a,b)=>(a.level!-b.level!)||String(a.name).localeCompare(String(b.name)))
    .slice(0,CAP.skills)
    .map(row=>({name:String(row.name),level:row.level!,max_level:Number(row.max_level??0)}));

  const storage=await attempt(missing,'storage',()=>viewStorage(command));
  const tax=await attempt(missing,'tax',async()=>details(await command('spacemolt/get_tax_estimate',{})));
  const shipping=await attempt(missing,'shipping_debt',async()=>details(await command('spacemolt_shipping/profile',{})));
  const taxDue=tax===undefined?undefined
    :Number(tax.income_tax_total??0)+Number(tax.property_tax_total??0)-Number(tax.tax_prepaid??0);

  // The journal is the account of past work; the present came from the live reads above.
  // A shift now writes a line per step and per game command, so the history reflection needs
  // lives much further back than the default tail: read wide, and let the filters below
  // pick the few kinds of line that say where the pilot has been.
  const journal=runtime?readJournal(runtime,JOURNAL_SPAN):[];
  const visited=new Set<string>(),bases=new Set<string>(),chosen=new Set<string>();
  const ranJobs=new Map<string,number>(),ranScripts=new Map<string,ScriptRun[]>();
  const recent:ReflectReport['recent']=[];
  for(const entry of journal) {
    if(entry.event==='rest'&&entry.home)bases.add(String(entry.home));
    if(entry.event==='reflection'&&entry.stance)chosen.add(String(entry.stance));
    if(entry.event==='run'&&entry.phase==='ended') {
      recent.push({script:entry.script,outcome:entry.outcome,reason:entry.reason});
      const name=String(entry.script??'');
      if(name)(ranScripts.get(name)??ranScripts.set(name,[]).get(name)!)
        .push({outcome:entry.outcome,reason:String(entry.reason??'').slice(0,CAP.reason)});
      for(const job of Array.isArray(entry.jobs)?entry.jobs:[])
        if(job?.job)ranJobs.set(String(job.job),(ranJobs.get(String(job.job))??0)+1);
    }
    const result=entry.response?.result;
    if(!result||typeof result!=='object')continue;
    const system=result.system?.id??result.location?.system,poi=result.poi?.id??result.location?.poi;
    if(system)visited.add(poi?`${system}/${poi}`:String(system));
    const dock=result.docked_at?.base_id??result.location?.docked_at??result.docked_at;
    if(typeof dock==='string'&&dock)bases.add(dock);
  }

  const scripts=scriptReview(ranScripts,runtime);
  const stagnation:string[]=[];
  const runCount=recent.length;
  const kinds=[...ranJobs.entries()].sort((a,b)=>b[1]-a[1]);
  if(runCount>=3&&kinds.length===1)
    stagnation.push(`every job in the journal's span was ${kinds[0]![0]} (${kinds[0]![1]} of them)`);
  if(bases.size===1&&runCount>=2)
    stagnation.push(`the pilot has not left ${[...bases][0]} in the journal's span`);
  if(visited.size<=2&&visited.size>0)
    stagnation.push(`only ${[...visited].join(', ')} appear in the journal: the world beyond is unseen`);
  const untried=STANCES.map(stance=>stance.name).filter(name=>!chosen.has(name));
  if(untried.length)stagnation.push(`stances never chosen: ${untried.join(', ')}`);

  return {
    at_rest:true,
    ...pilot.objective?{objective:pilot.objective}:{},
    ...pilot.objective_done?{objective_done:true}:{},
    ...pilot.home?{home:pilot.home}:{},
    ...skills?.length?{skills}:{},
    ship:{fuel:ship?.fuel as number,max_fuel:ship?.max_fuel as number,hull:ship?.hull as number,
      max_hull:ship?.max_hull as number,cargo_capacity:ship?.cargo_capacity as number,
      modules:(Array.isArray(modules)?modules:[]).map(row=>String(row.type_id))},
    holdings:{credits:player?.credits??0,
      storage:(storage?.locations??[]).slice(0,CAP.bases)
        .map(row=>({base_id:row.base_id,items:row.item_count,ships:row.ship_count})),
      ...storage?.items.length?{here:storage.items.slice(0,CAP.items)
        .map(row=>({item_id:row.item_id,quantity:row.quantity}))}:{}},
    owes:{...taxDue===undefined?{}:{tax_due:taxDue},
      ...shipping===undefined?{}:{shipping_debt:Number(shipping.profile?.outstanding_debt??0),
        carrier_tier:String(shipping.profile?.tier??'unknown')}},
    seen:{systems_and_pois:[...visited].slice(-CAP.visited),bases:[...bases].slice(-CAP.bases)},
    recent:recent.slice(-CAP.runs),
    ...scripts?.length?{scripts}:{},
    stagnation,
    stances:STANCES.map(stance=>({name:stance.name,initial_moods:[...stance.initial_moods]})),
    // The ship's fit against each stance's needs has no table behind it yet: D7 names the
    // counters a stance points at, never a hull or a module a stance requires.
    missing:[...missing,'ship fit against each stance (no per-stance ship requirement exists yet)'],
  };
}
