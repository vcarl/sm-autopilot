import { Effect } from 'effect';
import { Game } from './play/game.ts';
import type { ReadinessAccount } from './readiness.ts';
/** One run as the review reads it: how it ended and what it said. */
export interface ScriptRun {
    outcome?: string;
    reason?: string;
}
/** A file of the pilot's own under `pilot/`, with its size and how its runs ended. */
export interface ScriptReview {
    name: string;
    saved?: true;
    bytes?: number;
    runs: number;
    last?: ScriptRun[];
}
export interface Pilotish {
    objective?: string;
    objective_done?: boolean;
    goal?: string;
}
export interface ReflectReport {
    objective?: string;
    objective_done?: boolean;
    /** The lowest-levelled skills first: what training would move (N7). `was`/`since` are the
     * level this skill stood at in the earliest reflection the journal still holds, so an
     * objective phrased as movement ("raise the lowest by two levels") is judged against a number
     * rather than asserted. Absent when no earlier reflection is in the span, or when nothing moved. */
    skills?: {
        name: string;
        level: number;
        max_level: number;
        was?: number;
        since?: string;
    }[];
    ship: {
        fuel: number;
        max_fuel: number;
        hull: number;
        max_hull: number;
        cargo_capacity: number;
        modules: string[];
    };
    holdings: {
        credits: number;
        storage: {
            base_id: string;
            items: number;
            ships: number;
        }[];
        here?: {
            item_id: string;
            quantity: number;
        }[];
    };
    owes: {
        tax_due?: number;
        shipping_debt?: number;
        carrier_tier?: string;
    };
    recent: {
        script?: string;
        outcome?: string;
        reason?: string;
    }[];
    /** The pilot's library beside how it ran: what a rest reviews and rewrites. */
    scripts?: ScriptReview[];
    stagnation: string[];
    stances: string[];
    /** Named, never guessed: the inputs this report could not read this time. */
    missing: string[];
}
export declare const reflectReportEffect: (account: Pick<ReadinessAccount, "state">, pilot: Pilotish, runtime?: string) => Effect.Effect<ReflectReport, import("./play/game.ts").SeamFailed, Game>;
