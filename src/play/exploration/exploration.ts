/** Exploration trains only by the first visit to a system, and circuit missions ("visit four
 * stations", 10,000–20,000 cr) stack under any cargo. Scouting is knowledge, which is the
 * first word of the objective. */
import type {FindRouteResponse,MapSystemInfo,SystemInfo} from '@spacemolt/lib';
import type {Outcome} from '../types.ts';

export interface Explored {
  /** Each system entered, with what `get_system` said on arrival. */
  visited:(SystemInfo&{first_visit:boolean;route:FindRouteResponse})[];
  /** Systems still unvisited within reach, for next time. */
  unvisited:MapSystemInfo[];
  ended:'asked'|'fuel'|'no_go'|'stopped'|'tired';
}

/** Visit up to `systems` (default 2) unvisited systems within `jumps` (default 2) of here,
 * docking at each one's first station to read its board and market, then come home. Picks
 * the loop that visits the most unvisited systems inside the mood's fuel reserve, skipping
 * `permissions.no_go` and (Cautious, Focused) police 0. Trains exploration (first visits),
 * navigation, piloting; scanning when `survey:true` runs a `survey_system` in each. Costs
 * fuel. Every system entered lands in the scout cache, so `scout(id)` answers from it
 * afterwards. Tired turns for home at the next system. */
export function exploreNearby(opts?:{systems?:number;jumps?:number;survey?:boolean}):Promise<Outcome<Explored>> {throw new Error('unimplemented');}
