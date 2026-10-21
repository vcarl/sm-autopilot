/** What the juncture's present reads beyond the ship: each active mission led by its next step, and who is fighting
 * where the ship stands. Reads only. */
import {Cause,Effect,Exit,Option} from 'effect';
import type {ReadinessAccount} from '../readiness.ts';
import {TICK_MS} from '../sighting-memory.ts';
import {readPlaces} from './places.ts';
import {Game} from './game.ts';
import {activeEffect,nextStep} from './missions.ts';
import {acct,defect} from './runtime.ts';
import {jumpsFrom,mapOf} from './exploration/exploration.ts';
import {readBooks} from './world.ts';

/** `held` is each active mission led by its next step, for the juncture's Missions block. */
export interface Held {title:string;next:string;expires_at?:string}

/** A section: whatever stops its read — the server's refusal, a lost reply, a failed re-read, or a bug — leaves it out,
 * because this is the juncture's context and a context with none is a pilot flying blind. A bug also journals a
 * `defect` line naming `fn`, so it still reaches developers. An interrupt goes up. */
const section=<A,E,R>(fn:string,read:Effect.Effect<A,E,R>)=>Effect.gen(function*() {
  const exit=yield* Effect.exit(read);
  if(Exit.isSuccess(exit))return Option.some(exit.value);
  if(Cause.hasInterruptsOnly(exit.cause))return yield* Effect.interrupt;
  defect(fn,exit.cause);
  return Option.none<A>();
});

/** The missions held, each by its next step with the jumps to a base the map and the books know. */
export const heldEffect=(runtime?:string)=>Effect.gen(function*() {
  const game=yield* Game;
  yield* section('refresh',game.refresh);
  const {location}=acct().state;
  const docked=location?.docked_at??null,here=location?.system_id;
  const map=here?Option.getOrUndefined(yield* section('spacemolt/get_map',Effect.map(game.command('spacemolt/get_map',{}),mapOf))):undefined;
  const books=readBooks(runtime),places=runtime?readPlaces(runtime):{};
  const systemOf=(base:string)=>base===docked?here:books.find(book=>book.base_id===base)?.system_id??places[base];
  const jumpsTo=(o:{system_id?:string;target_base?:string})=>{
    const system=o.system_id??systemOf(o.target_base??'');
    return system===here?0:system&&here&&map?jumpsFrom(map,here).get(system):undefined;
  };
  const mine=Option.getOrUndefined(yield* section('spacemolt/get_active_missions',activeEffect()));
  if(!mine)return {};
  return {held:{max:mine.max_missions,missions:mine.active.map((m):Held=>({title:m.title,next:nextStep(m,jumpsTo),
    ...!m.community&&m.expires_in_ticks>0?{expires_at:new Date(Date.now()+m.expires_in_ticks*TICK_MS).toISOString()}:{}}))}};
});

/** What the location section already knows about a fight at this POI: another pilot or an
 * empire patrol in combat where the ship is standing. A docked ship observes no threat.
 * ponytail: pirates present are deliberately NOT threats. `V2NearbyPirate.status` has no
 * published values to read, and a Hunter's own quarry may be a pirate. Upgrade when the spec names the statuses. */
export function threatsHere(location:ReadinessAccount['state']['location'],docked:string|null):string[] {
  if(docked||!location)return [];
  return [...(location.nearby_players??[]).filter(row=>row.in_combat).map(row=>row.username??row.player_id),
    ...(location.nearby_empire_npcs??[]).filter(row=>row.in_combat).map(row=>row.name??row.npc_id)];
}
