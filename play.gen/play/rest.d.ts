/** Rest: dock at a base and bring the ship up. It ends nothing and opens nothing — the goal and
 * the stance are the pilot's to set with `spacemolt_reflect`, and no state waits on a rest.
 *
 * `reflection()` is the read a script takes when it wants to branch on how its runs have gone.
 */
import { type ReflectReport } from '../reflect.ts';
import { type Serviced } from './service.ts';
import type { Outcome } from './types.ts';
/** The stagnation signals, the skills that would move, what is held and what is owed, as a read. */
export declare function reflection(): Promise<Outcome<ReflectReport>>;
/** Put in and bring the ship up: `goTo(base)` first when a base is named, then `service()` at the
 * counter the ship is docked at. Not docked and no base named: `service` says so. */
export declare function rest(base?: string): Promise<Outcome<Serviced>>;
