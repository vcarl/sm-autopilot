/** What a job is handed, and what it gives back.
 *
 * A script composes jobs in ordinary TypeScript; the runner builds this once per run and
 * passes it to the script, which passes it to every job it calls. Everything a job is
 * allowed to know about the pilot is here — the account it reads and commands, the bounds
 * the mood and the operator's permissions set, where the journal lives, and the rules check
 * that stands between one job and the next.
 */
import type {MineYieldRow} from '../mine.ts';
import type {Mood} from '../mood-policy.ts';
import type {ReadinessAccount,ReadinessCommand} from '../readiness.ts';
import type {Reconciliation} from '../reconcile.ts';
import type {Facts} from '../rules-table.ts';

/** The rules said stop. Thrown by `ctx.check`, caught by the runner, reported as `blocked`:
 * a world the pilot can answer at its juncture, not a broken script. */
export class Blocked extends Error {}

/** A job's outcome as the agent sees it: did it end, and did the thing happen. The step log
 * stays in the job's own receipt, so a long script leaves the agent's context small.
 *
 * A script gives back the same shape under its own name, which is what makes a script
 * composable exactly like a job: `(ctx,params)=>Promise<JobOutcome>` either way, so a script
 * may be called from another script and its outcome read like any job's. A script's outcome
 * never overrides the run cap, a throw, or a job that did not finish — the runner's
 * precedence decides that, and the script only speaks for its own run.
 *
 * When a script calls another script, ONE outcome goes to `ctx.jobs` for that call — the
 * inner script's own, under its own name. The inner script's jobs are not the outer run's
 * job list; they travel inside that one outcome, under `result.jobs`, so a reader of the run
 * sees the step it asked for and can still open it. */
export interface JobOutcome {
  job:string;
  outcome:'done'|'blocked'|'failed';
  yield?:MineYieldRow[];
  /** The world moved the pilot with no command behind it, and this job stopped for it (C13). */
  moved?:Reconciliation;
  reason?:string;
  /** Whatever numbers or ids this job or script wants read at the juncture, beyond its
   * sentence. Carried to the run outcome's `result`, so JSON only. */
  result?:Record<string,unknown>;
}

export interface Ctx {
  readonly account:ReadinessAccount;
  readonly command:ReadinessCommand;
  readonly mood:Mood;
  /** The base the pilot stows at when a job is not told one. */
  readonly home?:string;
  readonly permissions:Facts['permissions'];
  /** Where run.json and the journal live. A runner with nowhere to write has none. */
  readonly runtime?:string;
  /** The hold the pilot already had when the run started — cabins, fitted spares. Never
   * moved by a job. Read at the start and kept in the record, because a run re-run after a
   * restart never saw the departure that proved which cargo was the pilot's own. */
  readonly keep:string[];
  /** Every job's outcome, in order, as the runner reports them. */
  readonly jobs:JobOutcome[];
  /** The rules between jobs (R5): a threat seen, or a mood that may not start work, throws
   * `Blocked` and the script ends there with the jobs it had already run. */
  check(job:string):Promise<void>;
  /** Where the run has got to, persisted so a restart can say what it was doing. */
  progress(update:{last_job?:string;last_step?:string}):void;
  /** True exactly once, for the first job of a run re-run after a restart: that job
   * re-enters at the step the live world implies instead of starting over. */
  resuming():boolean;
}
