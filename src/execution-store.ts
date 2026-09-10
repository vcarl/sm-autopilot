import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import type {ExecutionContext,Home} from './execution-policy.ts';
export interface Job {
  id:string; action:string; status:'running'|'completed'|'blocked'|'interrupted'|'returned_to_base'|'needs_reconciliation';
  context:ExecutionContext; started_at:string; before:unknown; after?:unknown; obligations?:unknown;
  actions:{action:string; params:unknown; status:'pending'|'confirmed'|'uncertain'; result?:unknown;before?:unknown;accepted_result?:unknown;reconciled_by?:string}[];
  obligation_admission_error?:string;
  obligations_after?:unknown;
  obligation_verification?:{status:'observed'|'unavailable';reason:string};
  result?:unknown; error?:string; cash_delta?:number;
  reconciliation?:Record<string,any>[];
  return_plan?:{home?:Home;destination:Home;temporary:boolean;reason?:string};
}
export interface PilotRecord {pilot_id:string;home?:Home;context?:ExecutionContext;stop?:string;jobs:Job[]}
/** One bridge owns this pilot's file. Every command is checkpointed before send. */
export class ExecutionStore {
  readonly path:string;
  data:PilotRecord;
  constructor(directory:string,pilotId:string) {
    mkdirSync(directory,{recursive:true,mode:0o700});
    this.path=join(directory,encodeURIComponent(pilotId)+'.json');
    this.data=existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):{pilot_id:pilotId,jobs:[]};
    if(this.data.pilot_id!==pilotId)throw new Error('Checkpoint pilot mismatch');
    for(const job of this.data.jobs)if(job.status==='running') {job.status='needs_reconciliation';job.error='Worker ended before terminal verification; inspect authoritative state before any replay';}
    this.save();
  }
  save() {writeFileSync(this.path+'.tmp',JSON.stringify(this.data,null,2),{mode:0o600});renameSync(this.path+'.tmp',this.path);}
  unresolved() {return this.data.jobs.find(j=>j.status==='needs_reconciliation');}
}
