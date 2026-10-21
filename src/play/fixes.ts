/** What fixes a refused call, from what we know without the server saying it: the call's own params, words the server
 * formats the same way every time, and our own reads. Few codes, each one the pilot repeated after the game named the
 * fix (kvothe's journal, 09-30..10-21, `command` refusals and their repeats of the same call and words). A fix is a
 * call: `first` sent before the refused call goes again, or `params` it goes again with. Prose is never parsed. */
import {Effect,Result} from 'effect';
import {NOT_THE_PILOTS} from '../failures.ts';
import {replyBody} from '../storage.ts';
import {hereEffect} from './counter.ts';
import {Game,field} from './game.ts';
import {buildFactionFacilityEffect} from './industry/facilities/facilities.ts';
import {literal} from './rows.ts';
import type {Run} from './runtime.ts';
import {goToEffect} from './travel.ts';
import type {Outcome} from './types.ts';

/** The refused call: what was sent, and what the game said. */
export interface Refused {action:string;params:Record<string,unknown>;code:string;message:string}
/** `choice` is what the pilot reads, and says what it spends; `call` is the fix to paste. */
export interface Fix {id:string;choice:string;call:string;first?:Effect.Effect<Outcome<unknown>,never,Game|Run>;params?:Record<string,unknown>}

/** A raw command as the pilot writes it. */
export const rawCall=(action:string,params:Record<string,unknown>)=>{
  const [tool='',name='']=action.split('/');
  return `account().commands.${tool}.${name}(${literal(params)})`;
};
const dockAt=(base:string):Fix=>({id:`goTo:${base}`,choice:`goTo('${base}') to dock there, then send it again`,
  call:`goTo('${base}')`,first:goToEffect(base,{ask:false})});
/** `Specify a recipe_id: %v` of a Go []string: `[a b c]` (gameserver handlers/crafting.go:510). */
const RECIPES=/Specify a recipe_id: \[([^\]]*)\]/;

const FIXES:Record<string,(refused:Refused)=>Effect.Effect<Fix[],never,Game|Run>>={
  // 21 refused, 11 of them repeats: the base at this POI, when there is one.
  not_docked:()=>Effect.gen(function*() {
    const here=yield* Effect.result(hereEffect());
    const base=Result.isSuccess(here)?here.success.row?.base_id:undefined;
    return base?[dockAt(base)]:[];
  }),
  // 10, 9 repeats: `inspect` of a base the ship is not docked at names the base itself.
  not_docked_at_base:({params})=>Effect.succeed(typeof params.id==='string'?[dockAt(params.id)]:[]),
  // 34, 6 naming the recipes that make the item asked for: the call again with each.
  invalid_recipe:({action,params,message})=>Effect.sync(()=>{
    const key='recipe_id' in params?'recipe_id':'id';
    return (RECIPES.exec(message)?.[1]??'').split(' ').filter(Boolean).map(id=>{
      const again={...params,[key]:id};
      return {id,choice:`send it again with ${key} ${id}`,call:rawCall(action,again),params:again};
    });
  }),
  // 7, 6 repeats: a faction deposit where the faction has no storage. A finished faction_lockbox is that storage.
  no_faction_storage:()=>Effect.gen(function*() {
    const read=yield* Effect.result((yield* Game).command('spacemolt_facility/types',{facility_type:'faction_lockbox'}));
    const cost=Result.isSuccess(read)?field(replyBody(read.success),'build_cost'):undefined;
    return typeof cost==='number'?[{id:'faction_lockbox',choice:`buildFactionFacility('faction_lockbox') here for ${cost} cr, then send it again`,
      call:`buildFactionFacility('faction_lockbox')`,first:buildFactionFacilityEffect('faction_lockbox')}]:[];
  }),
};

/** The fixes for a refusal; none for a code not in the table, or for the runtime's own sends. */
export const fixesFor=(refused:Refused):Effect.Effect<Fix[],never,Game|Run>=>
  NOT_THE_PILOTS.has(refused.action)?Effect.succeed([]):FIXES[refused.code]?.(refused)??Effect.succeed([]);
