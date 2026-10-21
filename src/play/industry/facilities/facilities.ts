/** Owning production. Not a separate specialty: the stage the Industry career grows into once
 * a bench's margins are proven, so the pilot who already stands at the counter keeps the fee
 * instead of paying it. A build grants corporation_management xp once, and a facility bills rent
 * every cycle (100 ticks, ~17 min) from your wallet, everywhere it stands, whether or not you
 * are there to see it.
 */
import {Effect,Option,Result,Schema,Struct} from 'effect';
import type {FacilityTypeSummary,OwnedFacilityEntry} from '@spacemolt/lib';
import * as Wire from '../../../wire.gen.ts';
import {Game,field,type GameError} from '../../game.ts';
import {tickNow} from '../../market.ts';
import {acct,admit,edge,jobEffect,pilot,runtimeDir} from '../../runtime.ts';
import {rememberFacilities} from '../../world.ts';
import type {Outcome} from '../../types.ts';
import {replyBody} from '../../../storage.ts';
import {miningInventory} from '../../../mining-inventory.ts';

/** A refusal or a lost reply as the pilot reads it: the action and the server's code, or that the reply is gone. */
const told=(error:GameError|Schema.SchemaError)=>error._tag==='SchemaError'?error.message
  :error._tag==='ReplyLost'?`reply lost on ${error.action}`:`${error.action}: ${error.code} — ${error.message}`;
/** Fallback only: a live `owned` read carries its own `grace_cycles`; this is what to assume
 * the one time it does not. */
const DEFAULT_GRACE_CYCLES=260;

/** The owned entry beside the one number the game does not compute: how many cycles the
 * wallet covers at the TOTAL rent across every facility you own, everywhere — not this one's
 * rent alone, because the wallet that pays it is the same wallet for all of them. */
export type Owned=OwnedFacilityEntry&{runway_cycles:number};

/** A facility at this station worth queuing a job at: yours, or public with a fee. `id` is
 * what the owner verbs below and a bench's `at` option take. */
export interface Rentable {
  id:string;type:string;name:string;recipe_id?:string;labour?:number;fee_per_run?:number;public:boolean;
}

const decodeStore=Schema.decodeUnknownEffect(Wire.ViewStorageResponse.mapFields(Struct.pick(['items'])));
const decodeOwned=Schema.decodeUnknownEffect(Wire.FacilityOwnedResponse.mapFields(Struct.pick(['facilities','rent'])));
// buildFacility never reads the rent summary, so its decode does not require it.
const decodeOwnedList=Schema.decodeUnknownEffect(Wire.FacilityOwnedResponse.mapFields(Struct.pick(['facilities'])));
/** The entry as this reads it: the spec's own fields, picked, so a reply's other fields never fail it. */
const Entry=Wire.FacilityEntry_1.mapFields(fields=>({...Struct.pick(fields,['facility_id','type','name','recipe_id','labor_per_cycle']),
  production:Schema.optionalKey(Schema.NullOr(Wire.FacilityProduction_1.mapFields(Struct.pick(['public','rental_fee_per_run']))))}));
const decodeList=Schema.decodeUnknownEffect(Wire.FacilityListResponse.mapFields(()=>{
  const rows=Schema.Array(Entry);
  return {station_facilities:rows,player_facilities:rows,faction_facilities:rows,public_facilities:Schema.optionalKey(Schema.NullOr(rows))};
}));
const decodeTypes=Schema.decodeUnknownEffect(Wire.FacilityTypeListResponse.mapFields(Struct.pick(['types'])));
const decodeTyped=Schema.decodeUnknownEffect(Wire.FacilityTypeDetailResponse.mapFields(fields=>({...Struct.pick(fields,['build_cost','category']),
  build_materials:Schema.optionalKey(Schema.NullOr(Schema.Array(Wire.ItemQuantity_14.mapFields(Struct.pick(['item_id','quantity'])))))})));
// Both build replies carry the id the same way, so one pick reads either.
const decodeBuilt=Schema.decodeUnknownOption(Wire.FacilityBuildResponse.mapFields(Struct.pick(['facility_id'])));

/** This base's store, item rows only — `buildFacility` takes materials from here, then the hold. */
const storeRows=Effect.gen(function*() {
  const reply=yield* (yield* Game).command('spacemolt_storage/view',{});
  const {items}=yield* decodeStore(replyBody(reply)).pipe(Effect.orDie);
  return items.map(row=>({item_id:row.item_id,quantity:row.quantity}));
});

type Facilities={owned:Owned[];here:Rentable[];buildable:FacilityTypeSummary[]};

/** Your facilities everywhere, what is rentable at this station, and what you could build
 * here. Reads only (`facility/owned`, `facility/list`, `facility/types` for the production and
 * personal categories); the public facilities here go into the facility book `trace()` and `catalog()` read — never `job_list`, which fails for a facility you are not docked at.
 * Each read is independent: one the game refuses, loses or answers off-spec does not fail the
 * others, and `did` says which (a bug still does).
 * `next` warns when the rent runway is under the game's own grace period. */
export function facilities():Promise<Outcome<Facilities>> {return edge(facilitiesEffect());}

/** `facilities` as an Effect, for `edge` and for converted callers; never in a barrel. A read the
 * game refuses or loses, or whose reply is not the spec's, is named in `failed` and the others go on. */
export const facilitiesEffect=()=>jobEffect('facilities','',Effect.gen(function*() {
  const game=yield* Game;
  const failed:string[]=[];
  let owned:Owned[]=[],graceCycles=DEFAULT_GRACE_CYCLES,runwayCycles=Infinity;
  const ownedRead=yield* Effect.result(game.command('spacemolt_facility/owned',{}).pipe(Effect.flatMap(reply=>decodeOwned(replyBody(reply)))));
  if(Result.isFailure(ownedRead))failed.push(`owned: ${told(ownedRead.failure)}`);
  else {
    const reply=ownedRead.success;
    const totalRent=reply.rent.total_rent_per_cycle;
    graceCycles=reply.rent.grace_cycles??DEFAULT_GRACE_CYCLES;
    runwayCycles=totalRent>0?Math.floor((acct().state.player?.credits??0)/totalRent):Infinity;
    owned=reply.facilities.map(entry=>({...entry,runway_cycles:runwayCycles}));
  }

  const docked=acct().state.location?.docked_at;
  const here:Rentable[]=[];
  if(docked) {
    const listRead=yield* Effect.result(game.command('spacemolt_facility/list',{}).pipe(
      Effect.tap(reply=>Effect.sync(()=>rememberFacilities(runtimeDir(),docked,acct().state.location?.system_id,reply,tickNow()))),
      Effect.flatMap(reply=>decodeList(replyBody(reply)))));
    if(Result.isFailure(listRead))failed.push(`here: ${told(listRead.failure)}`);
    else {
      const reply=listRead.success;
      const mine=new Set(reply.player_facilities.map(entry=>entry.facility_id));
      const seen=new Set<string>();
      for(const entry of [...reply.station_facilities,...reply.player_facilities,
        ...reply.faction_facilities,...reply.public_facilities??[]]) {
        if(seen.has(entry.facility_id))continue;
        seen.add(entry.facility_id);
        const fee=entry.production?.rental_fee_per_run;
        const isPublic=entry.production?.public===true;
        // L5 station facilities (repair, market...) carry no fee and are not public: skip
        // them unless they are mine — owning one still belongs in the count.
        if(!mine.has(entry.facility_id)&&!(isPublic&&fee))continue;
        here.push({id:entry.facility_id,type:entry.type,name:entry.name,...entry.recipe_id===undefined?{}:{recipe_id:entry.recipe_id},
          ...entry.labor_per_cycle===undefined?{}:{labour:entry.labor_per_cycle},...fee===undefined?{}:{fee_per_run:fee},public:isPublic});
      }
    }
  }

  // ponytail: two category reads (production, personal) rather than one unfiltered browse.
  // An unfiltered `types` answers the discovery view (categories and pagination, no rows),
  // and this pilot can build neither an infrastructure, faction, nor service type anyway.
  const buildable:FacilityTypeSummary[]=[];
  for(const category of ['production','personal'] as const) {
    const typesRead=yield* Effect.result(game.command('spacemolt_facility/types',{category,per_page:50}).pipe(Effect.flatMap(reply=>decodeTypes(replyBody(reply)))));
    if(Result.isFailure(typesRead))failed.push(`${category} types: ${told(typesRead.failure)}`);
    else buildable.push(...typesRead.success.types.filter(type=>type.buildable!==false));
  }

  const did=[owned.length?`${owned.length} facilit${owned.length===1?'y':'ies'} owned`:'none owned',
    docked?`${here.length} rentable here`:'not docked: here is empty',
    `${buildable.length} buildable here`,...failed].join('; ');
  return {status:'done' as const,did,detail:{owned,here,buildable},
    next:owned.length&&runwayCycles<graceCycles
      ?[`rent runway ${runwayCycles} cycles is under the ${graceCycles}-cycle grace; earn or pay down arrears`]:[]};
}));

export interface Built {facility_id:string;rent_per_cycle:number;ready_tick?:number}

/** Build a facility of `type` at this station: quarters first if the game asks for them, then
 * a workshop of your own. Owned already here → `done`, nothing sent. Refused, naming the
 * shortfall, when this station's store and the hold together are short a build material (the game
 * takes packages, then the store, then the hold). Costs the build price at commit; construction pauses rent until it
 * completes; the build grants corporation_management xp once. */
export function buildFacility(type:string):Promise<Outcome<Built>> {return edge(buildFacilityEffect(type));}

/** `buildFacility` as an Effect, for `edge` and for converted callers; never in a barrel. The
 * build command's own refusal or lost reply is a `failed` Outcome naming it; the reads before and
 * after it end the flight as they always have. A build reply without its id is found in owned() by type. */
export const buildFacilityEffect=(type:string)=>jobEffect('buildFacility',type,Effect.gen(function*() {
  const game=yield* Game;
  const none={facility_id:'',rent_per_cycle:0};
  const refuse=(why:string,next:string[]=[])=>({status:'refused' as const,did:`did not build ${type}`,why,detail:none,next});
  const blocked=yield* admit('buildFacility');
  if(blocked)return refuse(blocked);

  const owned=game.command('spacemolt_facility/owned',{}).pipe(Effect.flatMap(reply=>decodeOwnedList(replyBody(reply)).pipe(Effect.orDie)));
  const docked=acct().state.location?.docked_at;
  const before=(yield* owned).facilities;
  const mine=before.find(entry=>entry.type===type&&entry.base_id===docked);
  if(mine)return {status:'done' as const,did:`${type} already owned at ${docked} as ${mine.facility_id}`,
    detail:{facility_id:mine.facility_id,rent_per_cycle:mine.rent_per_cycle}};
  if(!docked)return refuse('buildFacility happens at a station and the ship is not docked');

  const typedReply=yield* game.command('spacemolt_facility/types',{facility_type:type});
  // Anything but the detail view is the game saying it has no such type.
  if(field(replyBody(typedReply),'kind')!=='detail')return refuse(`no facility type '${type}'`);
  const typed=yield* decodeTyped(replyBody(typedReply)).pipe(Effect.orDie);

  const store=yield* storeRows,aboard=miningInventory(acct().state);
  const held=(item:string)=>(store.find(row=>row.item_id===item)?.quantity??0)+(aboard[item]??0);
  const short=(typed.build_materials??[]).map(row=>({...row,have:held(row.item_id)}))
    .filter(row=>row.have<row.quantity);
  if(short.length)
    return refuse(`${type} needs ${short.map(row=>`${row.item_id} ${row.have} of ${row.quantity}`).join(', ')} in ${docked}'s store and your hold`,
      short.map(row=>`buy('${row.item_id}', ${row.quantity-row.have}, {deliverTo:'storage'}) or stow it there`));

  const action=typed.category==='personal'?'spacemolt_facility/personal_build':'spacemolt_facility/build';
  const commit=yield* Effect.result(game.command(action,{facility_type:type}));
  if(Result.isFailure(commit))
    return {status:'failed' as const,did:`did not build ${type}`,why:`${type} was not built at ${docked}: ${told(commit.failure)}`,detail:none};
  // A reply with no id still reads back from owned() by type, as it always did.
  const built=decodeBuilt(replyBody(commit.success));

  const after=(yield* owned).facilities;
  const landed=after.find(entry=>Option.isSome(built)&&entry.facility_id===built.value.facility_id)??after.find(entry=>entry.type===type&&entry.base_id===docked);
  if(!landed)
    return {status:'failed' as const,did:`did not build ${type}`,why:`${type} was committed at ${docked} but does not show in owned() yet`,detail:none};
  return {status:'done' as const,did:`${type} built at ${docked} as ${landed.facility_id}, ${landed.rent_per_cycle} cr/cycle rent`,
    detail:{facility_id:landed.facility_id,rent_per_cycle:landed.rent_per_cycle}};
}));

/** The faction-build workflow's steps, in order, as the game words each refusal (gameserver
 * handlers/facility.go handleBuildFactionFacility; game/station_economy.go BuildFactionFacility,
 * which answers `build_failed` with prose). The first that matches names the step that is missing. */
const FACTION_STEPS:[RegExp,string,string][]=[
  [/^no_faction\b/,'faction: join or found one','spacemolt_faction.get_invites() then accept_invite({id}), or create({id, text})'],
  [/^not_docked\b/,'docked: dock at the station to build at','goTo(base)'],
  [/^no_permission\b/,'permission: ManageFacilities','a leader promotes you to a role that has it'],
  [/Faction Storage facility|faction storage facility/,'faction storage: a finished faction_lockbox here first',"buildFactionFacility('faction_lockbox'), or wait out its construction"],
  [/must build a \w+ facility at this station first|facility is still under construction/,'prerequisite: the facility this one requires, finished here','spacemolt_facility.types({facility_type}) names it'],
  [/this is an upgrade/,'upgrade: build the facility it upgrades, then upgrade it','spacemolt_facility.faction_upgrade({facility_id, facility_type})'],
  [/Corporation Management skill level/,'skill: corporation_management at the facility level','train corporation_management'],
  [/^build_failed: need \d+ credits/,'credits: treasury and wallet together short','deposit credits to the treasury, or earn them'],
  [/^build_failed: need \d+ x /,'materials: the store here and the hold together short','stow or carry the materials here'],
];

/** Build faction facility `type` at the station you are docked at, in one call. The game checks
 * each step in order — a faction, docked, ManageFacilities, a finished `faction_lockbox` here, the
 * facility it requires, the skill, the credits (treasury, then your wallet; a lockbox is your wallet
 * alone), the materials (the faction's store here, then your hold; a lockbox, your own store) — and
 * a refusal comes back `refused` with the missing step in `why` and the call that supplies it in
 * `next`. A lost reply is `failed`. */
export function buildFactionFacility(type:string):Promise<Outcome<Built>> {return edge(buildFactionFacilityEffect(type));}

export const buildFactionFacilityEffect=(type:string)=>jobEffect('buildFactionFacility',type,Effect.gen(function*() {
  const none={facility_id:'',rent_per_cycle:0},did=`did not build ${type}`;
  const sent=yield* Effect.result((yield* Game).command('spacemolt_facility/faction_build',{facility_type:type}));
  if(Result.isFailure(sent)) {
    const error=sent.failure;
    if(error._tag==='ReplyLost')return {status:'failed' as const,did,why:told(error),detail:none};
    const said=`${error.code}: ${error.message}`,step=FACTION_STEPS.find(([match])=>match.test(said));
    return {status:'refused' as const,did,why:step?`${step[1]} (${error.message})`:told(error),detail:none,next:step?[step[2]]:[]};
  }
  const body=replyBody(sent.success),facility_id=String(field(body,'facility_id')??''),rent=Number(field(body,'rent_per_cycle')??0);
  const state=field(body,'under_construction')===true?'under construction':'built and active';
  return {status:'done' as const,did:`${type} ${state} at ${String(field(body,'base_id')??'?')} as ${facility_id}`,
    detail:{facility_id,rent_per_cycle:rent}};
}));
