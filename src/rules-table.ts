// The stances: which career README a pilot carries, and the mood each flies in. Nothing here
// decides what to do next, and nothing here talks to the game.
import type {Mood} from './mood-policy.ts';

export type StanceName='Prospector'|'Industrialist'|'Trader'|'Carrier'|'Hunter'|'Scout';
export interface Stance {name:StanceName;initial_moods:Mood[]}
export const STANCES:readonly Stance[]=Object.freeze([
  {name:'Prospector',initial_moods:['Focused','Opportunistic']},
  {name:'Industrialist',initial_moods:['Cautious','Focused']},
  {name:'Trader',initial_moods:['Opportunistic','Cautious']},
  {name:'Carrier',initial_moods:['Cautious','Focused']},
  {name:'Hunter',initial_moods:['Focused','Aggressive']},
  {name:'Scout',initial_moods:['Cautious','Opportunistic']},
] as const satisfies readonly Stance[]);

/** The working mood a stance flies in: its first initial mood, Cautious with no stance. The mood
 * is never chosen or stored; `moodNow` turns this into Tired when a margin is crossed. */
export const stanceMood=(stance?:string):Mood=>STANCES.find(row=>row.name===stance)?.initial_moods[0]??'Cautious';
