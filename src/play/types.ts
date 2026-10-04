/** The one return shape every library function, and every function the pilot writes, gives
 * back. Four questions, always in this order: what was done, what it cost, what is now true,
 * what to consider next. The runtime renders it to prose (DESIGN.md "Outcome and prose") and
 * streams it as a journal line the moment the function returns.
 *
 * Game state inside it is the lib's own types: `V2Ship`, `V2Location`, `V2CargoItem`,
 * `SkillProgress`. Only the wrapper is ours, because the lib has no notion of "an outcome".
 *
 * Composition rule: a function that calls other library functions returns ITS OWN Outcome.
 * `cost` and `gained` are measured by the runtime around the whole call (state before vs
 * state after), never summed by hand, so nesting cannot double-count.
 */
import type {SkillProgress,V2CargoItem,V2Location,V2Ship} from '@spacemolt/lib';
import type {Mood} from './runtime.ts';

/** An item and a count, for requests and for measured deltas: the lib's cargo row with the
 * display fields dropped. Anything the game hands back is the full `V2CargoItem`. */
export type Row=Pick<V2CargoItem,'item_id'|'quantity'>;

/** A row as a pilot asks for it, for `stow`, `withdraw` and `sell`. `quantity` is optional:
 * omit it to mean all of it — all held, or all stored. A non-finite `quantity` (`Infinity`,
 * `NaN`) is refused, with the refusal saying to omit it instead. */
export type Want=Pick<V2CargoItem,'item_id'>&{quantity?:number};

export type Status=
  /** The end state the function is named for now holds. */
  |'done'
  /** Stopped early with real work behind it: hold not full, 1 of 3 fights, stopped by the pilot. */
  |'partial'
  /** Nothing landed: the rules, the policy, the world (no such POI, not docked) or the game's own refusal said no. */
  |'refused'
  /** Something broke mid-way, or a reply was lost. `why` carries the error; the world may have moved. */
  |'failed';

export interface Outcome<Detail=unknown> {
  /** The function that answered, e.g. `gatherUntil`. Set by the runtime wrapper. */
  fn:string;
  status:Status;
  /** One past-tense sentence: "mined 112 units at X and stowed them at Y". Never a plan. */
  did:string;
  /** Present when status is not `done`: the reason, in the words of the observation. */
  why?:string;
  /** Measured deltas, spend positive. `minutes` is wall clock. */
  cost:{credits:number;fuel:number;hull:number;minutes:number};
  /** Measured gains. `xp` is per skill id, from `GameState['skills']` before and after. */
  gained:{credits:number;items:Row[];xp:Record<string,number>};
  /** What is now true, from an authoritative read at the end. */
  now:Present;
  /** Up to three short things worth considering next, from the rules and this function's own
   * knowledge ("the hold is full; sell here or stow"). Suggestions, never commands. */
  next:string[];
  /** Function-specific numbers and ids the pilot may branch on. JSON only. */
  detail:Detail;
}

/** The present, as every Outcome ends with it and as `orient()` reports it. Straight lib
 * state plus the pilot's mood, which the game does not know about. */
export interface Present {
  ship:V2Ship;
  location:V2Location;
  cargo:V2CargoItem[];
  credits:number;
  skills:Record<string,SkillProgress>;
  mood:Mood;
  /** Present only while the mood is Tired: the margin that imposed it. */
  tired_by?:string;
}
