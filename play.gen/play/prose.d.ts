/** `prose(outcome)`: the report at the end of a run, static text assembled from the value.
 * No model, no per-function template (DESIGN.md "Outcome and prose"). */
import type { Call } from './runtime.ts';
import type { Outcome } from './types.ts';
export declare function prose(outcome: Outcome<unknown>, calls?: Call[]): string;
