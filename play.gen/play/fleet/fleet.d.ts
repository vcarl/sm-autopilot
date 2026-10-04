/** More than one hull. One character flies one ship; the rest sit parked at stations, safe
 * from your death, and `switch_ship` at a shipyard swaps which one you fly. Several ships
 * flying at once is several characters: a freighter is one, flying a circuit on its own account
 * from this pilot's process (`assign`). */
import type { ListShipsResponse, StoredShip, SwitchShipResponse, V2Ship } from '@spacemolt/lib';
import { Effect } from 'effect';
import { type Holding } from '../freighter/index.ts';
import type { FreighterRow } from '../freighter/host.ts';
import { Game } from '../game.ts';
import { type Circuit } from '../trading/trading.ts';
import type { Outcome } from '../types.ts';
/** Every ship you own and where it is parked (`ship/list_ships`), with the active one
 * marked and, for each parked hull, the base's shipyard service (needed to switch). Reads
 * only. `next` says which parked hull would suit the current stance. */
export declare function ships(): Promise<Outcome<ListShipsResponse & {
    active: V2Ship;
    parked: (StoredShip & {
        base_id: string;
        shipyard: boolean;
    })[];
}>>;
/** Swap to a hull parked at the station you are docked at. Needs a shipyard service here.
 * The hold moves to this base's store first (`stow`), modules stay on their own hulls, and
 * the new hull is serviced and insured before the
 * function returns. Refused undocked, without a shipyard, or when `minimum_crew` is unmet.
 * Costs the service; trains nothing. */
export declare function switchShip(shipId: string): Promise<Outcome<{
    switched: SwitchShipResponse;
    ship: V2Ship;
}>>;
/** ponytail: the most credits a freighter may keep aboard to trade with; everything above its float
 * goes home at every stop. A cap on what one lost freighter can cost, not a measured number. Tunable. */
export declare const FLOAT_MAX = 30000;
type Hand = {
    freighter: FreighterRow | null;
};
/** What of `holding` `circuit` never sells; undefined when the circuit sells all of it. Said, never
 * refused: the freighter stows it at the first stop, cheapest first, only down to `FREE_HOLD` free,
 * and sells the rest at cost wherever a bid covers it. */
export declare function tiedUp(holding: Holding, circuit: Circuit): string | undefined;
/** Hand `circuit` to the freighter `name`: another account, whose login the operator has put at
 * `freighters/<name>.txt` in this runtime, flies it lap after lap from this process, keeping
 * `caps.float` credits aboard and depositing the rest to you at every stop. Returns at once; the
 * freighter flies on. Refused unless the circuit is closed, of 2+ bases this pilot has read books
 * at, buys somewhere everything it sells, and every hop (the last back to the first too) is on the
 * map; refused over `FLOAT_MAX`, or while `name` is flying (recall it first). Cargo aboard the circuit
 * never sells is not refused: the `why` says how much of the hold it ties up. Nor is a circuit whose
 * every stop's book is older than `IGNORE_TICKS`: the `why` says its first lap buys only what fresh
 * books justify. */
export declare function assign(name: string, circuit: Circuit, caps: {
    float: number;
}): Promise<Outcome<{
    freighter: FreighterRow | null;
}>>;
/** `assign` as an Effect, for `edge` and for `reassign`; never in a barrel. A failed `get_map` or ledger read ends the job
 * `refused` or `failed` through `jobEffect`, in the server's own code. Nothing here is a game mutation. */
export declare const assignEffect: (name: string, circuit: Circuit, caps: {
    float: number;
}) => Effect.Effect<Outcome<Hand>, never, Game | import("../runtime.ts").Run>;
/** Put the parked freighter `name` on a new circuit: `routes({circuit: {hold}})` for its hold,
 * within the scope its circuit was planned in (`circuit.scope`: maxStops, maxLegJumps, maxJumps),
 * which passes over the rings a freighter drained within `REST_TICKS`, then `assign` of the top
 * row at its float. Refused when no circuit pays, or wherever `routes` or `assign` refuse (not
 * docked; still flying). Cargo aboard the new circuit sells rides into it at its cost; the rest is
 * stowed at its first stop down to `FREE_HOLD` free, and the `why` says so. */
export declare function reassign(name: string): Promise<Outcome<{
    freighter: FreighterRow | null;
}>>;
/** `reassign` as an Effect; never in a barrel. */
export declare const reassignEffect: (name: string) => Effect.Effect<Outcome<Hand>, never, Game | import("../runtime.ts").Run>;
/** Ask the freighter `name` home: it finishes the stop it is on, buying nothing more, deposits its profit, and parks
 * docked there with its cargo aboard. With `{after:'lap'}` it finishes the lap it is on instead, selling and buying
 * as usual, then parks. Either way it is not re-planned; `assign` or `reassign` sets it flying again. */
export declare function recall(name: string, opts?: {
    after?: 'lap';
}): Promise<Outcome<{
    freighter: FreighterRow | null;
}>>;
/** Every freighter assigned from here: state, laps, the stop, its wallet, what it has sent home,
 * the last lap's net against the lap_net predicted, the cargo aboard at cost, a stop after the lap
 * scheduled, its auto-reassigns, the cargo it stowed and where, and why it parked or waits. Reads only. */
export declare function freighters(): Promise<Outcome<{
    freighters: FreighterRow[];
}>>;
export {};
