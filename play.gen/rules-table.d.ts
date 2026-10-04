import { type Mood } from './mood-policy.ts';
export type StanceName = 'Prospector' | 'Industrialist' | 'Trader' | 'Carrier' | 'Hunter' | 'Scout';
/** D7 section 3. Four of them can come back empty; the menu says so (D7 decision). */
export type CounterName = 'Market' | 'Workshop / recipes' | 'Boards — missions' | 'Boards — shipping' | 'Storage' | 'Hangar / refit' | 'Comms / news' | 'Services' | 'Obligations desk' | 'Home desk' | 'Progression desk' | 'Citizenship / empire' | 'Facilities desk' | 'Distress';
export interface Stance {
    name: StanceName;
    /** Playtested first (D7). A flag on the data: no code branches on it. */
    active_first: boolean;
    jobs: string[];
    counters: CounterName[];
    initial_moods: Mood[];
}
export declare const STANCES: readonly Stance[];
/** The working mood a stance flies in: its first initial mood, Cautious with no stance. The mood
 * is never chosen or stored; `moodNow` turns this into Tired when a margin is crossed. */
export declare const stanceMood: (stance?: string) => Mood;
export interface Site {
    poi_id: string;
    quoted_fuel: number;
    resource?: string;
    serviced_base?: boolean;
}
export interface Facts {
    stance?: StanceName;
    mood: Mood;
    place: {
        kind: 'base' | 'poi' | 'space';
        base_id?: string;
        counters?: CounterName[];
        workshop?: boolean;
        service_prices?: {
            fuel?: number;
            hull?: number;
        };
        sites?: Site[];
        board?: {
            contracts?: {
                id: string;
                cargo: number;
                liability: number;
            }[];
            passengers?: number;
        };
    };
    holdings: {
        fuel: number;
        max_fuel: number;
        hull: number;
        max_hull: number;
        cargo_free: number;
        credits: number;
        inputs?: string[];
    };
    obligations: {
        contracts?: string[];
        passengers?: number;
    };
    permissions: {
        max_liability?: number;
        credit_reserve?: number;
    };
    observed: {
        threats?: string[];
        targets?: string[];
        spread?: {
            item_id: string;
            base_id: string;
            margin: number;
            age: number;
        };
    };
}
export interface Bounds {
    spend: number;
    fuelReserve: number;
    walkAway: number;
}
/** Resolved from the mood alone (D2/R7). Never passed per call, never per option. */
export declare const resolveBounds: (mood: Mood) => Bounds;
/** `safety` survives danger; `safety` and `resupply` survive Tired — resupply is what clears it. */
type Tag = 'safety' | 'resupply' | 'shared' | 'stance';
/** `play` is the exact line from the `play` barrel an option would be taken with, so the pilot
 * is never left to invent parameters (playtest 2026-09-15: a gather dispatched twice at the
 * station the ship was already docked at). It is what the pilot pastes, which is why it is a
 * barrel call and not an MCP tool name — this field used to hold `{tool,params}`, a shape no
 * consumer ever read and no pilot could use.
 *
 * A verdict the rules refuse carries none: handing back a call the same build just refused is
 * how a menu contradicts itself. A verdict with **no** `play` has no barrel primitive behind it
 * at all, and the menu leaves it unoffered rather than inventing one — the three `safety` rows
 * are the standing cases. */
export interface Verdict {
    job: string;
    reason: string;
    admissible: boolean;
    tag: Tag;
    play?: string;
}
/** The rules between one job and the next, from the same two rules the menu applies to
 * stance work: a threat seen, or a mood that may not initiate a job. A run asks this before
 * every job, so what the menu refuses mid-script is what the runner refuses too (R5). */
export declare function jobStop(facts: Facts): string | null;
/** Danger first, then the mood block on stance jobs, then Tired's own filter. */
export declare function evaluateMenu(facts: Facts): Verdict[];
export {};
