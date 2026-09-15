import {gatherJob,type GatherOutcome,type GatherPlan,type StepOutcome} from './gather-job.ts';
import type {MineYieldRow} from './mine.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import type {TravelOptions} from './travel.ts';

/** The jobs the agent may compose. One entry per job the runner knows how to execute. */
const RUNNERS={gather:gatherJob};
export interface ChainJob {job:keyof typeof RUNNERS;params:GatherPlan}
/** Jobs composed at a juncture: a sequence, a loop of one job, or one job then ask. */
export interface Chain {kind:'sequence'|'loop'|'once';jobs:ChainJob[];length?:number}

/** A job's outcome as the agent sees it: did it end, and did the thing happen. The step
 * log stays in the job's own receipt, so a long chain leaves the agent's context small. */
export interface ChainJobOutcome {
  job:ChainJob['job'];
  outcome:StepOutcome;
  yield:MineYieldRow[];
  /** The wallet delta the job's settlement actually cleared. Never a reply's claim. */
  cleared:number;
  reason?:string;
}
/** The chain's own definition and where it had got to: plain data, so a restart can read
 * it back (N22). Resuming from it is not this module's business. */
export interface ChainRecord {
  kind:Chain['kind'];
  jobs:ChainJob[];
  length:number;
  /** Jobs finished so far, which is the index of the job about to run. */
  position:number;
  ended:boolean;
}
export interface ChainOutcome {
  outcome:StepOutcome;
  jobs:ChainJobOutcome[];
  /** The one moment the agent is consulted: at the end of the chain, never between jobs. */
  juncture:{reason:string};
}
export interface ChainOptions extends TravelOptions {
  onProgress?:(record:ChainRecord)=>void;
  /** Restart the chain at this position, resuming the job that was in flight there (N22).
   * Only that job resumes; the ones after it are ordinary trips out and back. */
  resumeAt?:number;
}

/** How many jobs the chain will run if nothing stops it. A loop counts its length. */
function length(chain:Chain):number {
  const {kind,jobs}=chain??{};
  if(!Array.isArray(jobs)||!jobs.length)throw new Error('A chain needs at least one job');
  if(!jobs.every(entry=>Object.hasOwn(RUNNERS,entry?.job)))throw new Error('Unknown job in the chain');
  if(kind==='sequence')return jobs.length;
  if(jobs.length!==1)throw new Error(`A ${kind} chain carries exactly one job`);
  if(kind==='once')return 1;
  if(kind!=='loop')throw new Error(`Unknown chain kind: ${String(kind)}`);
  if(!Number.isInteger(chain.length)||(chain.length as number)<1)
    throw new Error('A loop chain needs a whole positive length');
  return chain.length as number;
}

const compact=(job:ChainJob,result:GatherOutcome):ChainJobOutcome=>({
  job:job.job,outcome:result.outcome,yield:result.yield,
  cleared:result.settled?result.settled.credits_after-result.settled.credits_before:0,
  ...result.reason===undefined?{}:{reason:result.reason}});

/** Run a chain of jobs under one juncture.
 *
 * Jobs run one after another with nothing asked of the agent between them: the chain ends,
 * and raises its single juncture, when the last job finishes or when a job comes back
 * blocked or failed. The chain's outcome is then that job's outcome, and the reason names
 * which job of how many it was. The record is offered before every job and once at the end
 * so the runner can see where the chain was without the agent being consulted.
 */
export async function runChain(account:ReadinessAccount,command:ReadinessCommand,
  chain:Chain,options:ChainOptions={}):Promise<ChainOutcome> {
  const total=length(chain);
  const {onProgress,resumeAt,...jobOptions}=options;
  const start=resumeAt===undefined?0:resumeAt;
  if(!Number.isInteger(start)||start<0||start>=total)throw new Error(`A chain cannot resume at job ${start} of ${total}`);
  const record:ChainRecord={kind:chain.kind,jobs:chain.jobs,length:total,position:start,ended:false};
  const jobs:ChainJobOutcome[]=[];

  for(let position=start;position<total;position++) {
    onProgress?.({...record,position});
    const job=chain.kind==='loop'?chain.jobs[0]!:chain.jobs[position]!;
    const result=await RUNNERS[job.job](account,command,job.params,
      {...jobOptions,...position===start&&resumeAt!==undefined?{resume:true}:{}});
    jobs.push(compact(job,result));
    if(result.outcome!=='done') {
      onProgress?.({...record,position:position+1,ended:true});
      return {outcome:result.outcome,jobs,
        juncture:{reason:`chain ${result.outcome} at job ${position+1} of ${total}: ${result.reason}`}};
    }
  }
  onProgress?.({...record,position:total,ended:true});
  return {outcome:'done',jobs,juncture:{reason:`chain done: ${total} of ${total} jobs`}};
}
