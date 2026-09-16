/** Passenger lines: the best credits-and-reputation loop in the game once you have berths.
 * Fare = (200 + 150 × hops) × class × remoteness × surge, plus a speed bonus up to +50%;
 * first class also pays +1 empire standing per delivery. */
import type {PassengerView,StationPassengersResponse,UnloadPassengerCommandResponse,WaitingPassengerView} from '@spacemolt/lib';
import type {Outcome} from '../types.ts';

export interface Carried {
  /** What was waiting when you looked (`demand_level`, `fare_surge`, `waiting`). */
  station:StationPassengersResponse;
  loaded:WaitingPassengerView[];
  /** Each stop's unloads; the fare is in the response. */
  landed:{base_id:string;unloaded:UnloadPassengerCommandResponse[]}[];
  /** Still aboard at the end, with `ticks_remaining` on their guarantee. */
  aboard:PassengerView[];
}

/** Load everyone waiting here for `destination` (a base id) into your berths, fly there, put
 * them off, and repeat for any intermediate stop the route passes that a passenger is bound
 * for. With no `destination`, picks the destination with the highest total fare among the
 * waiting, inside the mood's fuel reserve.
 *
 * Never sends `unload_passenger` with id `all` anywhere but a passenger's own destination:
 * stranding pays nothing and costs −1 standing each. The policy validator refuses the raw
 * call on `account()` for the same reason.
 *
 * Refused without berths (`V2Ship['berths']`), with nobody waiting, or when the guarantee
 * window (`540 + 180 × hops` ticks) cannot be met. Costs fuel; pays fares measured into
 * `gained.credits`. Trains navigation, piloting. Tired: passengers already aboard are still
 * delivered (the function may only continue toward their destination); nobody new boards. */
export function carryPassengers(destination?:string):Promise<Outcome<Carried>> {throw new Error('unimplemented');}
