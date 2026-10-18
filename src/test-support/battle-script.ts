import {SpacemoltError} from '@spacemolt/lib';
import {battleStirred} from '../travel.ts';
import type {bridgeWorld} from './bridge-world.ts';

/** One logged `battle/status` poll. `theirs` is the quarry's hull_pct; `flee_required: null` omits it (escape blocked);
 * `combat_state: false` omits the whole object. */
export interface ScriptedPoll {hull:number;theirs:number;zone:string;distance:number;reach?:number;shield?:number;
  ourZone?:string;stance?:string;target?:string;flee_counter?:number;flee_required?:number|null;combat_state?:false;
  /** `combat_state.can_escape`, when the poll carries it (false: the crew is incapacitated, or the escape is pinned). */
  can_escape?:boolean;
  /** Our own row's hull_pct, when it must differ from `hull` over the ship's max_hull (a max_hull the state never read). */
  hull_pct?:number;
  /** More standing enemies on their side, as [player_id, hull_pct]. */
  others?:[string,number][]}

/** `game.command` with `spacemolt_battle/status` answered from `polls` in order (setting the ship's hull to each `hull`),
 * `no_active_battle` after the last; once a `stance flee` is sent, `onFlee` is played instead when given. `spacemolt/hunt`
 * and `spacemolt/attack` are accepted without starting the world's own battle. Every other call goes to `game.command`.
 * The quarry is `quarry` (default `{id:'c1',name:'Veil-Ray'}`), our row is `player_id:'ship'`. */
export function scriptedBattle(game:ReturnType<typeof bridgeWorld>,polls:ScriptedPoll[],
  opts:{quarry?:{id:string;name:string};onFlee?:ScriptedPoll[]}={}):{command:typeof game.command;sent:{action:string;params:any}[]} {
  const quarry=opts.quarry??{id:'c1',name:'Veil-Ray'};
  const sent:{action:string;params:any}[]=[];
  let fled=false,at=0,afterFlee=0;
  const status=(poll:ScriptedPoll,tick:number)=>{
    const ship=game.account.server.ship;
    ship.hull=poll.hull;
    const state=poll.combat_state===false?{}:{combat_state:{max_weapon_reach:poll.reach??2,flee_counter:poll.flee_counter??0,
      ...poll.flee_required===null?{}:{flee_required:poll.flee_required??3},
      ...poll.can_escape===undefined?{}:{can_escape:poll.can_escape}}};
    return {structuredContent:{battle_id:'battle-1',is_participant:true,system_id:'sol',tick_duration:tick,...state,
      participants:[{player_id:'ship',kind:'player',side_id:2,...poll.stance?{stance:poll.stance}:{},...poll.target?{target_id:poll.target}:{},
        hull_pct:poll.hull_pct??Math.round(100*poll.hull/ship.max_hull),shield_pct:poll.shield??0,zone:poll.ourZone??poll.zone,zone_distance:poll.distance},
      {player_id:quarry.id,kind:'creature',is_npc:true,side_id:1,username:quarry.name,hull_pct:poll.theirs,zone:poll.zone,zone_distance:poll.distance},
      ...(poll.others??[]).map(([player_id,hull_pct])=>({player_id,kind:'creature',is_npc:true,side_id:1,username:player_id,
        hull_pct,zone:poll.zone,zone_distance:poll.distance}))]}};
  };
  const command:typeof game.command=async(action,params)=>{
    sent.push({action,params:structuredClone(params)});
    if(action==='spacemolt/hunt'||action==='spacemolt/attack'){battleStirred();return {delta:{details:{command:'attack',message:'Engaging.',pending:true}}};}
    if(action==='spacemolt_battle/stance'&&params?.id==='flee')fled=true;
    if(action!=='spacemolt_battle/status')return game.command(action,params);
    const script=fled&&opts.onFlee?opts.onFlee:polls,index=fled&&opts.onFlee?afterFlee++:at++;
    const poll=script[index];
    if(!poll)throw new SpacemoltError('no_active_battle','No active battle. Use attack to engage a target.');
    return status(poll,at+afterFlee);
  };
  return {command,sent};
}
