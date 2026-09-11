import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import type {ExecutionContext,Home} from './execution-policy.ts';
import type {Account} from '@spacemolt/lib';
import {terminalStoppingReason} from './execution-stopping.ts';
import type {SpendingEvidence,BudgetSpending} from './spending.ts';
export interface Job {
  id:string; action:string; status:'running'|'completed'|'blocked'|'interrupted'|'returned_to_base'|'needs_reconciliation';
  context:ExecutionContext; started_at:string; before:unknown; after?:unknown; obligations?:unknown;
  actions:{action:string; params:unknown; status:'pending'|'confirmed'|'uncertain'; result?:unknown;before?:unknown;accepted_result?:unknown;reconciled_by?:string}[];
  obligation_admission_error?:string;
  obligations_after?:unknown;
  obligation_verification?:{status:'observed'|'unavailable';reason:string};
  result?:unknown; error?:string; cash_delta?:number; stopping_reason?:string;
  spending?:SpendingEvidence;
  budget_owner_id?:string;
  budget_spending?:BudgetSpending;
  reconciliation?:Record<string,any>[];
  defense?:Record<string,any>[];
  return_reassessments?:Record<string,any>[];
  return_plan?:{home?:Home;destination:Home;temporary:boolean;reason?:string};
}
export interface PilotRecord {pilot_id:string;home?:Home;context?:ExecutionContext;stop?:string;run_start_job:number;jobs:Job[]}
/** One bridge owns this pilot's file. Every command is checkpointed before send. */
export class ExecutionStore {
  readonly path:string;
  data:PilotRecord;
  constructor(directory:string,pilotId:string) {
    mkdirSync(directory,{recursive:true,mode:0o700});
    this.path=join(directory,encodeURIComponent(pilotId)+'.json');
    this.data=existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):{pilot_id:pilotId,jobs:[]};
    if(this.data.pilot_id!==pilotId)throw new Error('Checkpoint pilot mismatch');
    // Old checkpoints retain their admissions; reconnect is never a new grant.
    this.data.run_start_job??=0;
    if(!Number.isInteger(this.data.run_start_job)||this.data.run_start_job<0||this.data.run_start_job>this.data.jobs.length)throw new Error('Invalid operating-run checkpoint');
    for(const job of this.data.jobs)if(job.status==='running') {job.status='needs_reconciliation';job.error='Worker ended before terminal verification; inspect authoritative state before any replay';}
    this.data.stop??=this.runJobs().map(terminalStoppingReason).find(Boolean);
    this.save();
  }
  save() {writeFileSync(this.path+'.tmp',JSON.stringify(this.data,null,2),{mode:0o600});renameSync(this.path+'.tmp',this.path);}
  unresolved() {return this.data.jobs.find(j=>j.status==='needs_reconciliation');}
  runJobs() {return this.data.jobs.slice(this.data.run_start_job);}
  /** Only the host configure/new_run path calls this, before an executor exists. */
  async startNewRun(account:Pick<Account,'refresh'|'ship'|'location'>) {
    await account.refresh();
    const ship=account.ship,location=account.location;
    const ready=ship&&ship.id&&!ship.incapacitated&&[ship.hull,ship.max_hull,ship.fuel,ship.max_fuel,ship.shield,ship.max_shield].every(value=>Number.isFinite(value)&&value>=0)
      &&ship.hull===ship.max_hull&&ship.fuel===ship.max_fuel&&ship.shield===ship.max_shield;
    if(this.unresolved()||this.data.jobs.some(job=>job.status==='running')||!location?.docked_at||location.in_transit||!ready)throw new Error('Cannot start a new run before reconciled, docked and fully serviced state');
    this.data.run_start_job=this.data.jobs.length;
    delete this.data.stop;this.save();
  }
}
