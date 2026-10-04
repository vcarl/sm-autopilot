/** Passenger lines: the best credits-and-reputation loop in the game once you have berths.
 * Fare = (200 + 150 × hops) × class × remoteness × surge, plus a speed bonus up to +50%;
 * first class also pays +1 empire standing per delivery. */
import type { PassengerView, StationPassengersResponse, UnloadPassengerCommandResponse } from '@spacemolt/lib';
import { Effect } from 'effect';
import { Game } from '../game.ts';
import type { Outcome } from '../types.ts';
export interface Carried {
    /** What was waiting when you looked (`demand_level`, `fare_surge`, `waiting`). */
    station: StationPassengersResponse;
    /** Who boarded, as `load_passenger` reported them (with the `berth_class` it assigned). */
    loaded: PassengerView[];
    /** Each stop's unloads; the fare is in the response. */
    landed: {
        base_id: string;
        unloaded: UnloadPassengerCommandResponse[];
    }[];
    /** Still aboard at the end, with `ticks_remaining` on their guarantee. */
    aboard: PassengerView[];
}
/** Load everyone waiting here for `destination` (a base id) into your berths, fly there, and
 * put off only the passengers whose destination is that stop.
 *
 * With no `destination`, the destination with the highest total estimated fare among the
 * waiting is taken. `load_passenger` boards by destination, so the class ordering inside one
 * call is the server's; `loaded` reports the `berth_class` it assigned.
 *
 * Never sends `unload_passenger` with id `all` anywhere: it would strand everyone aboard
 * whose stop this is not, at −1 standing each, and unloading one passenger explicitly is
 * also what applies that passenger's own +1. The policy validator refuses the literal on
 * `account()` for the same reason.
 *
 * Refused without berths (`V2Ship['berths']`) or undocked; nobody waiting is `done`. Costs
 * fuel; pays fares measured into `gained.credits`. Trains navigation, piloting. Tired: a
 * passenger already aboard bound for `destination` is still delivered — nobody new boards.
 * A reply lost on the boarding or on an unload is never re-sent: the manifest is re-read,
 * and an unload that may have landed leaves the trip `partial`. */
export declare function carryPassengers(destination?: string): Promise<Outcome<Carried>>;
/** `carryPassengers` as an Effect, for `edge` and for converted callers; never in a barrel. A refusal ends it naming the
 * action and the code; a lost reply on the boarding or an unload is never re-sent, and the manifest is re-read. */
export declare const carryPassengersEffect: (destination?: string) => Effect.Effect<Outcome<Carried>, never, Game | import("../runtime.ts").Run>;
