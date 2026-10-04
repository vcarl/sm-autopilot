declare const fuelReserves: Readonly<{
    Relaxed: 30;
    Cautious: 30;
    Focused: 24;
    Opportunistic: 20;
    Aggressive: 12;
    Tired: 0;
}>;
export type Mood = keyof typeof fuelReserves;
export declare function resolveServiceSpend(mood: Mood): number;
export declare function resolveWalkAway(mood: Mood): number;
export declare function resolveFuelReserve(mood: Mood): number;
/** The margin a mood's ship has crossed, if any: fuel under the reserve, hull under the walk-away
 * line. Credits are not a margin: resupply spends them, so a Tired only earning could clear —
 * with work refused under Tired — would strand the pilot by construction. `credit_reserve` is a
 * spend limit on the buys that enforce it, nothing more.
 *
 * This is the only place the fuel reserve binds. Travel keeps nothing back — a leg is flown when
 * the tank covers its route (operator's decision, 2026-09-26) — so a leg that takes fuel under the
 * reserve lands here, and Tired's rules send the pilot to service. ponytail: the fuel line is a
 * flat reserve, not a route home; `serviceElsewhere` (play/service.ts) prices the route when a
 * service is refused.
 * ponytail: `crossed` has no hysteresis. A ship sitting exactly on a line flips per command; add a
 * band if the journal ever shows it chattering. */
export declare function crossed(mood: Mood, ship: {
    fuel: number;
    hull: number;
    max_hull: number;
} | undefined): string | null;
/** The mood, derived and never stored: the working mood the caller names (the stance's own), or
 * Tired while the ship is past that mood's margins. Resupply clears it by changing the facts. */
export declare function moodNow(working: Mood, ship: {
    fuel: number;
    hull: number;
    max_hull: number;
} | undefined): {
    mood: Mood;
    tired_by?: string;
};
export {};
