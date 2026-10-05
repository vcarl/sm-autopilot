import type { Mood } from './mood-policy.ts';
export type StanceName = 'Prospector' | 'Industrialist' | 'Trader' | 'Carrier' | 'Hunter' | 'Scout';
export interface Stance {
    name: StanceName;
    initial_moods: Mood[];
}
export declare const STANCES: readonly Stance[];
/** The working mood a stance flies in: its first initial mood, Cautious with no stance. The mood
 * is never chosen or stored; `moodNow` turns this into Tired when a margin is crossed. */
export declare const stanceMood: (stance?: string) => Mood;
