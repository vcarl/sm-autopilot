import { Effect } from 'effect';
import { Game, SeamFailed } from './play/game.ts';
import { type MineOptions, type MineYieldRow } from './mine.ts';
import type { Mood } from './mood-policy.ts';
import type { ReadinessAccount, ReadinessCommand } from './readiness.ts';
import { type ServiceOutcome } from './servicing.ts';
import type { SettleOutcome } from './settle-cargo.ts';
import { type TravelOptions } from './travel.ts';
import { type Reconciliation } from './reconcile.ts';
export interface GatherPlan {
    home: {
        system_id: string;
        poi_id: string;
        base_id: string;
    };
    site: {
        system_id: string;
        poi_id: string;
    };
    mood: Mood;
}
/** `blocked` is a world the pilot can answer at a juncture; `failed` needs a reading. */
export type StepOutcome = 'done' | 'blocked' | 'failed';
export type GatherStepName = 'travel' | 'mine' | 'return' | 'dock' | 'settle' | 'service' | 'verify';
export interface GatherStep {
    name: string;
    outcome: StepOutcome;
    reason?: string;
}
export interface GatherOptions extends TravelOptions {
    /** Each step as it ends, with the numbers that step moved. The job keeps no opinion about
     * what is done with them: `jobs/gather.ts` writes the run record and the journal line. */
    onStep?: (step: GatherStep, moved: {
        yield: MineYieldRow[];
        deposited?: MineYieldRow[];
    }) => void;
    /** The mining loop's own hooks: a stop reason per tick and a running-yield line. */
    mine?: MineOptions;
    /** The mood in force now, read when the service step starts. The runtime imposes Tired
     * between any two commands, so the mood the job was planned under is stale by the time the
     * ship is home — and Tired's service margin is the one a resupply needs.
     * Defaults to `plan.mood`, which is what a caller with no live pilot record has. */
    moodNow?: () => Mood;
}
export interface GatherOutcome {
    outcome: StepOutcome;
    steps: GatherStep[];
    /** The mine step's cargo delta, kept even when a later step ends the job. */
    yield: MineYieldRow[];
    /** Where this job's take ended up: `deposited` into the station store, or `held`
     * because the station has none. `sold` is always empty and the wallet never moves —
     * a gather job keeps its resources; selling is the agent's own call at its juncture. */
    settled: SettleOutcome | null;
    serviced: ServiceOutcome | null;
    /** Present when the world moved the pilot with no command behind it (C13). */
    moved?: Reconciliation;
    reason?: string;
}
/** One gather job, dock to dock: out to the site, mine the hold full, home, settle, service.
 *
 * Every step is a proven primitive and each one's own outcome decides whether the next
 * runs — a blocked step ends the job at that step with the reason, a failed step ends it
 * failed, and nothing is re-issued here (each primitive reconciles its own lost reply).
 * The end state is a claim about the world, so an authoritative read closes the job:
 * docked at home, the hold settled, serviced to the mood's margins, or it is a failure
 * naming what differed.
 *
 * `command` is a parameter only because the unconverted callees (travel, servicing,
 * reconcile) still take a Promise command; the Effect's own commands go through `Game`.
 */
export declare const gatherJobEffect: (account: ReadinessAccount, command: ReadinessCommand, plan: GatherPlan, options?: GatherOptions) => Effect.Effect<{
    reason: string;
    moved?: Reconciliation;
    outcome: "failed" | "blocked";
    steps: GatherStep[];
    yield: MineYieldRow[];
    settled: SettleOutcome | null;
    serviced: ServiceOutcome | null;
} | {
    outcome: "done";
    steps: GatherStep[];
    yield: MineYieldRow[];
    settled: null;
    serviced: null;
}, SeamFailed, Game>;
