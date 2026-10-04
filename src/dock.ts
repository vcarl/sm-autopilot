import {SpacemoltError,type GameState} from '@spacemolt/lib';
import {Data,Effect,Result} from 'effect';
import {Game,attempt} from './play/game.ts';
import type {ReadinessAccount} from './readiness.ts';
import {travelStep,waitForArrival,type TravelOptions} from './travel.ts';

/** `message` is what the pilot is told; `gather-job.ts` reads it and checks `instanceof`. */
export class DockBlocked extends Data.TaggedError('DockBlocked')<{readonly message:string}> {}
export interface DockResult {docked:true;docked_at:string;already_docked:boolean}

const settled=(state:GameState)=>Boolean(state.location?.system_id&&!state.location.in_transit);

/** One dock path. A lost reply is reconciled by a live read in either direction — never re-sent
 * blind, and never re-sent at all while the mutation is queued. The one re-send is of a dock a live
 * read showed did not land (dock is idempotent, and was re-observed first). `already_docked` has no
 * tag (no evidence, codes.ts): it is a `Rejected` read by its code. The re-read is the account's
 * own, not `Game.refresh`, so it adds no re-read of its own to a dropped connection the caller's
 * command path already handled. */
export const dockAtEffect=(account:ReadinessAccount,baseId?:string,options:TravelOptions={})=>Effect.gen(function*() {
  const game=yield* Game;
  const refresh=attempt('refresh',()=>account.refresh());
  yield* travelStep('travel/arrival',()=>waitForArrival(account,settled,options)); // bridge: U09 (travel's conversion calls its Effect twin)
  const confirm=(already:boolean):Effect.Effect<DockResult|null,DockBlocked>=>{
    const docked=account.state.location?.docked_at;
    if(!docked)return Effect.succeed(null);
    if(baseId&&docked!==baseId)return Effect.fail(new DockBlocked({message:`Docked at ${docked}, not ${baseId}; undock before docking elsewhere`}));
    return Effect.succeed({docked:true,docked_at:docked,already_docked:already});
  };
  const existing=yield* confirm(true);
  if(existing)return existing;
  if(!account.state.location?.poi_id)return yield* new DockBlocked({message:'No station here to dock at; travel to a station first'});
  let reissues=1;
  while(true) {
    const sent=yield* Effect.result(game.command('spacemolt/dock',{}));
    if(Result.isSuccess(sent)) {
      yield* refresh;
      const landed=yield* confirm(false);
      if(!landed)return yield* new DockBlocked({message:'Dock not confirmed by a live read; reconcile before further movement'});
      return landed;
    }
    const error=sent.failure;
    const already=error._tag==='Rejected'&&error.code==='already_docked';
    if(!already&&error._tag!=='ReplyLost')return yield* error;
    yield* refresh;
    const landed=yield* confirm(already);
    if(landed)return landed;
    const queued=error._tag==='ReplyLost'&&error.cause instanceof SpacemoltError&&Boolean(error.cause.pendingCommand);
    if(already||queued||reissues--<=0)return yield* error;
  }
});
