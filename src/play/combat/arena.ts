/** The arena: consequence-free matches on the normal battle engine — ship and crew restored after, only ammo and fuel
 * spent. Live (kvothe 2026-10-09..13): 13 matches, 0 won, 12 ended by our own flee — 11 of them the run's close
 * disengaging a match the program had returned from, which forfeits it. Every one was a hand-written loop; this is the
 * one the library owns. */
import type {ArenaObjective} from '@spacemolt/lib';
import {Effect,Result} from 'effect';
import {replyBody,rows as listOf} from '../../storage.ts';
import {Game,field,type GameError} from '../game.ts';
import {catalogClassEffect} from '../hangar.ts';
import {foldArenaEnded} from '../../combat-memory.ts';
import {acct,edge,jobEffect,runtimeDir,step} from '../runtime.ts';
import type {Outcome} from '../types.ts';
import {FIGHT_CEILING_MS,battleEffect,loadoutEffect,pace,type Battled} from './hunting.ts';

/** One arena match, as the loop fought it and as `arena.status` scored it. */
export interface ArenaMatch {
  /** The NPC challenge (`arena.challenges`), or the duel's own challenge id. */
  challenge_id:string;name:string;
  /** How the challenge is won beyond knocking out every enemy; absent for a duel, which has none. */
  objective?:ArenaObjective;
  battle:Battled;
  /** Lifetime `arena_wins`/`arena_losses`, read before the match and after it. No `battle_ended` push has been seen
   * for an arena battle, so this delta is the only score there is. */
  record:{before:{wins:number;losses:number};after:{wins:number;losses:number}};
  /** The delta read as one word: `neither` when both stood still — a stalemate counts for neither. */
  result:'win'|'loss'|'neither';
}

// oxlint-disable-next-line typescript/consistent-type-assertions
const asObjective=(value:unknown)=>value as ArenaObjective|undefined; // cast: frozen surface (ArenaObjective), as the server sent it
const num=(value:unknown)=>Number(value??0)||0;
const told=(error:GameError)=>error._tag==='ReplyLost'?`reply lost on ${error.action}`:`${error.action}: ${error.code} — ${error.message}`;

const statusEffect=()=>Effect.gen(function*() {
  return replyBody(yield* (yield* Game).command('spacemolt_arena/status',{}));
});
const scoreOf=(status:unknown)=>({wins:num(field(status,'arena_wins')),losses:num(field(status,'arena_losses'))});

/** The loop with loss not fatal (fleeing forfeits, and the match costs nothing to lose), then the score. The record is read
 * again one tick later when it has not moved, in case the server books the result a tick behind the battle's end. */
const fightTo=(head:{challenge_id:string;name:string;objective?:ArenaObjective;boss?:string},before:{wins:number;losses:number})=>Effect.gen(function*() {
  const deadline=num(head.objective?.survive_ticks)||num(head.objective?.time_limit_ticks);
  const battle=yield* battleEffect({lossFatal:false,...head.boss?{boss:head.boss}:{},
    ceilingMs:Math.max(FIGHT_CEILING_MS,2*deadline*pace.tickMs)});
  let after=scoreOf(yield* statusEffect());
  if(after.wins===before.wins&&after.losses===before.losses&&battle.outcome==='ended') {
    yield* Effect.sleep(pace.tickMs);
    after=scoreOf(yield* statusEffect());
  }
  const result=after.wins>before.wins?'win' as const:after.losses>before.losses?'loss' as const:'neither' as const;
  // Into combat.json beside the hunts, marked with the challenge: the fold the battle pushes opened is closed here.
  if(battle.battle_id)foldArenaEnded(runtimeDir(),{battle_id:battle.battle_id,challenge_id:head.challenge_id,opponent:head.boss??head.name,
    result,dealt:battle.dealt,taken:battle.taken,ticks:battle.polls});
  const {boss:_,...rest}=head;
  const match:ArenaMatch={...rest,battle,record:{before,after},result};
  const did=`${head.name}: ${result} (arena record ${after.wins}-${after.losses}), ${battle.polls} round(s), `
    +`dealt ${battle.dealt??'?'} taken ${battle.taken??'?'}`;
  return battle.outcome==='ended'?{status:'done' as const,did,detail:match}
    :{status:'partial' as const,did,detail:match,why:'the match had not ended at the ceiling: it still holds the ship, and the run\'s close leaves an arena match to finish'};
});

/** Fight an NPC arena challenge to its end. `challenge` names one from `arena.challenges`; without it, the first
 * unlocked one held here that is not yet won, else the first unlocked one here. A match already holding the ship is
 * fought as it stands. The rules it can check before spending the call are checked — ship tier against
 * `max_ship_tier`/`min_ship_tier` — and a ship that breaks one is `refused` naming the rule, as the server would; an
 * empty magazine is reloaded from the hold first. Then `fight`, and `fightBattle`'s loop with loss not fatal: no danger
 * line, no flee, because fleeing forfeits and nothing is lost by losing. The result is the `arena.status` record before
 * against after. */
export function arena(opts:{challenge?:string}={}):Promise<Outcome<ArenaMatch>> {return edge(arenaEffect(opts));}

export const arenaEffect=(opts:{challenge?:string}={})=>jobEffect<ArenaMatch>('arena',opts.challenge??'',Effect.gen(function*() {
  const game=yield* Game;
  const status=yield* statusEffect();
  const before=scoreOf(status);
  const empty={challenge_id:opts.challenge??'',name:opts.challenge??'',
    battle:{outcome:'ended' as const,polls:0,hull_before:0,hull_after:0},record:{before,after:before},result:'neither' as const};
  // A match already on: fight it where it stands.
  if(field(status,'battle_id')) {
    const live=field(status,'match');
    const challenge_id=String(field(live,'challenge_id')??'duel'),name=String(field(live,'name')??challenge_id);
    const objective=asObjective(field(live,'objective'));
    step(`a match is already on (${String(field(status,'battle_id'))}): fighting it as it stands`);
    return yield* fightTo({challenge_id,name,...objective?{objective}:{}},before);
  }
  const listed=listOf(field(replyBody(yield* game.command('spacemolt_arena/challenges',{})),'challenges'));
  const open=(row:unknown)=>field(row,'at_this_arena')===true&&field(row,'locked')!==true;
  const pick=opts.challenge!==undefined?listed.find(row=>field(row,'challenge_id')===opts.challenge)
    :listed.find(row=>open(row)&&!num(field(row,'wins')))??listed.find(open);
  if(!pick&&opts.challenge===undefined) {
    const where=[...new Set(listed.map(row=>String(field(row,'poi_name')??field(row,'poi_id')??'')).filter(Boolean))];
    return {status:'refused',did:'fought nothing',detail:empty,
      why:`no unlocked challenge is held where the ship stands${where.length?`; challenges are held at ${where.join(', ')}`:''} (undocked there to start one)`};
  }
  const challenge_id=opts.challenge??String(field(pick,'challenge_id'));
  const rules=field(pick,'rules');
  // The tier rule, checked before the call: live, `rule_ship_tier` refused a tier-2 hull after the fight was sent.
  const max=num(field(rules,'max_ship_tier')),min=num(field(rules,'min_ship_tier'));
  if(max||min) {
    const classId=acct().state.ship?.class_id??'';
    const klass=yield* catalogClassEffect(classId).pipe(Effect.catchTags({Rejected:()=>Effect.void,InBattle:()=>Effect.void,ReplyLost:()=>Effect.void}));
    const tier=klass?.tier;
    if(tier!==undefined&&((max&&tier>max)||(min&&tier<min)))
      return {status:'refused',did:'fought nothing',detail:{...empty,challenge_id},
        why:`rule_ship_tier: ${classId} is tier ${tier}, and ${challenge_id} takes tier ${min||0}-${max||5}`,
        next:['switchShip(id) to a hull inside the rule, then arena() again']};
    if(tier===undefined)step(`${classId}: tier not in the catalogue; the server checks the rule`);
  }
  const gap=yield* loadoutEffect();
  if(gap)step(`${gap} — fighting anyway: the arena restores the ship`);
  const sent=yield* Effect.result(game.command('spacemolt_arena/fight',{id:challenge_id}));
  if(Result.isFailure(sent)) {
    if(sent.failure._tag==='Rejected')return {status:'refused',did:'fought nothing',detail:{...empty,challenge_id},why:told(sent.failure)};
    return yield* sent.failure;
  }
  const fight=replyBody(sent.success);
  const name=String(field(fight,'name')??field(pick,'name')??challenge_id);
  const objective=asObjective(field(fight,'objective')??field(pick,'objective'));
  // "Your ship opens targeting the boss when there is one" (ArenaEnemyInfo.is_boss); the loop keeps it focused.
  const boss=listOf(field(fight,'enemies')).find(row=>field(row,'is_boss')===true);
  step(`arena: ${name} (${String(field(fight,'battle_id')??'?')}) begins${boss?`, boss ${String(field(boss,'name'))}`:''}`);
  return yield* fightTo({challenge_id,name,...objective?{objective}:{},...boss?{boss:String(field(boss,'name'))}:{}},before);
}));

/** Challenge a player to a duel and fight it if they accept. `challenge` then `arena.status` once a tick for up to
 * `waitMs` (default two minutes): a `battle_id` there is the accept; the outgoing challenge gone without one is a
 * decline or a lapse. Not accepted in time, the challenge is withdrawn (`cancel`) and the outcome is `partial`. Then the
 * same loop as `arena()`: loss not fatal, no flee. */
export function duel(opts:{player:string;max_side_size?:number;waitMs?:number}):Promise<Outcome<ArenaMatch>> {
  return edge(jobEffect<ArenaMatch>('duel',opts.player,Effect.gen(function*() {
    const game=yield* Game;
    const before=scoreOf(yield* statusEffect());
    const sent=replyBody(yield* game.command('spacemolt_arena/challenge',{id:opts.player,
      ...opts.max_side_size===undefined?{}:{max_side_size:opts.max_side_size}}));
    const challenge_id=String(field(sent,'challenge_id')??'');
    const name=`duel with ${String(field(sent,'target_name')??opts.player)}`;
    const empty={challenge_id,name,battle:{outcome:'ended' as const,polls:0,hull_before:0,hull_after:0},
      record:{before,after:before},result:'neither' as const};
    const waitMs=opts.waitMs??120_000;
    for(let waited=0;;waited+=pace.tickMs) {
      const status=yield* statusEffect();
      if(field(status,'battle_id'))break;
      if(!field(status,'outgoing'))return {status:'partial',did:`challenged ${opts.player}`,detail:empty,
        why:'the challenge is gone without a match: declined, or it lapsed'};
      if(waited>=waitMs) {
        const withdrawn=yield* Effect.result(game.command('spacemolt_arena/cancel',{}));
        return {status:'partial',did:`challenged ${opts.player}`,detail:empty,
          why:`not accepted in ${Math.round(waitMs/1000)}s; ${Result.isSuccess(withdrawn)?'withdrawn':`the withdraw failed (${told(withdrawn.failure)})`}`};
      }
      yield* Effect.sleep(pace.tickMs);
    }
    step(`${opts.player} accepted: fighting`);
    return yield* fightTo({challenge_id,name},before);
  })));
}
