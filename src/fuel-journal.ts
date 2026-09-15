import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {resolveFuelReserve,type Mood} from './mood-policy.ts';
import type {GameState} from '@spacemolt/lib';
import type {FuelRouteEvidence} from './travel.ts';

export interface PilotFuelState {
  mood:Mood;
  stance:string|null;
  objective:unknown;
  home:unknown;
  obligations:unknown[];
}
export interface FuelTransition {
  mood:'Tired';priorMood:Exclude<Mood,'Tired'>;reason:string;rule:'D3.fuel';
  evidence:FuelRouteEvidence;
  station:ServicedStation;
}
/** D3: resupply clears Tired and restores the mood held at the crossing. Recorded, not latched. */
export interface FuelRestoration {
  mood:Exclude<Mood,'Tired'>;priorMood:'Tired';reason:string;rule:'D3.resupply';
  observed:{ship:GameState['ship'];location:GameState['location']};
}
export type FuelJournalEntry=FuelTransition|FuelRestoration;

/** The mood a resupply restores: the one held at the most recent crossing. */
export function moodBeforeTired(transitions:readonly FuelJournalEntry[]):Exclude<Mood,'Tired'>|undefined {
  for(let i=transitions.length-1;i>=0;i--) {
    const entry=transitions[i];
    if(entry.rule==='D3.fuel')return entry.priorMood;
  }
  return undefined;
}
/** Supplied by the runner from observed station service data, never directory presence alone. */
export interface ServicedStation {
  base_id:string;poi_id:string;system_id:string;
  services:{refuel:boolean};
  observation:{source:string;observedAt:string};
}
interface JournalData {version:1;pilotId:string;state:PilotFuelState;transitions:FuelJournalEntry[]}

/** One runner owns this per-pilot journal, just as it owns the account connection. */
export class FuelJournal {
  readonly path:string;
  private data:JournalData;
  private failure:Error|undefined;
  private constructor(path:string,data:JournalData){this.path=path;this.data=data;}
  static async open(runtimePath:string,pilotId:string,initial:PilotFuelState) {
    if(!runtimePath||!pilotId)throw new Error('Explicit runtime path and pilot identity required');
    const path=join(runtimePath,`fuel-${createHash('sha256').update(pilotId).digest('hex')}.json`);
    let data:JournalData;
    try {data=JSON.parse(await readFile(path,'utf8'));}
    catch(error) {
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      if(initial.mood==='Tired')throw new Error('Initial Tired requires prior-mood evidence');
      resolveFuelReserve(initial.mood);
      data={version:1,pilotId,state:structuredClone(initial),transitions:[]};
      const journal=new FuelJournal(path,data);await journal.write(data);return journal;
    }
    if(data.version!==1||data.pilotId!==pilotId||!data.state||!Array.isArray(data.transitions))throw new Error('Invalid fuel journal identity or version');
    resolveFuelReserve(data.state.mood);
    if(data.state.mood==='Tired') {
      const prior=moodBeforeTired(data.transitions);
      if(!prior)throw new Error('Tired journal lacks prior mood');
      resolveFuelReserve(prior);
    }
    return new FuelJournal(path,data);
  }
  get snapshot(){return structuredClone(this.data);}
  assertReady(){if(this.failure)throw this.failure;}
  private async write(data:JournalData) {
    const directory=dirname(this.path);
    await mkdir(directory,{recursive:true,mode:0o700});
    const temporary=`${this.path}.${randomUUID()}.tmp`;
    try {
      const file=await open(temporary,'wx',0o600);
      try {await file.writeFile(JSON.stringify(data)+'\n');await file.sync();}finally {await file.close();}
      await rename(temporary,this.path);
      const dir=await open(directory,'r');try {await dir.sync();}finally {await dir.close();}
    } finally {
      await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});
    }
  }
  async record(transition:FuelTransition) {
    this.assertReady();
    if(this.data.state.mood==='Tired')return;
    if(transition.priorMood!==this.data.state.mood||transition.evidence.kind!=='available_fuel'||transition.evidence.shortfall<=0)throw new Error('Invalid fuel transition');
    await this.commit('Tired',transition);
  }
  /** Nobody clears Tired by hand: the restoration is decided from a verified post-state. */
  async restore(restoration:FuelRestoration) {
    this.assertReady();
    if(this.data.state.mood!=='Tired')return;
    if(restoration.priorMood!=='Tired'||restoration.mood!==moodBeforeTired(this.data.transitions))throw new Error('Invalid fuel restoration');
    await this.commit(restoration.mood,restoration);
  }
  private async commit(mood:Mood,entry:FuelJournalEntry) {
    const next=structuredClone(this.data);
    next.state.mood=mood;next.transitions.push(structuredClone(entry));
    try {await this.write(next);}
    catch(error) {
      // A failed directory sync can leave the rename visible but durability unknown.
      // Only reopening/reconciling the journal may resume this execution owner.
      this.failure=new Error('Fuel journal persistence unresolved; reopen before further travel',{cause:error});
      throw this.failure;
    }
    this.data=next;
  }
}
