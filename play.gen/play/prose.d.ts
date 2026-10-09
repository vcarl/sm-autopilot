/** `prose(outcome)`: the report at the end of a flight, static text assembled from the value.
 * No model, no per-function template (DESIGN.md "Outcome and prose"). */
import type { Call } from './runtime.ts';
import type { Outcome } from './types.ts';
/** The run's headline from its work, not its last call. Live 2026-10-01 (kvothe 15:25Z): two
 * tradeRun calls earned 5,071 and 2,452 cr, the third lap was cut at the cap, and the run read
 * "nothing; did not reach nova_terra_central"; 09-30 run 8e0abef8 mined 27 items and read `refused`
 * "serviced nothing" from a trailing service() off a station. The pilot read both as the loop dying.
 * The rule, mechanical: when `main()` returned a library call's Outcome (not one it composed with
 * `outcome()`, nor the runtime's broke/stopped/cap) and some top-level call gained credits or items,
 * the run takes the status of the call that gained the most credits (then items), its did leads
 * with the run's totals and that call's did, and the last call follows as a clause. Every call
 * keeps its own status in `calls`; a run whose returned call is its only earner is left as it is. */
export declare function ofTheRun(result: Outcome<unknown>, calls: Call[]): Outcome<unknown>;
/** `lost`: the ship the flight took off in is gone (run.ts), said plainly under the headline. */
export declare function prose(outcome: Outcome<unknown>, calls?: Call[], lost?: string): string;
