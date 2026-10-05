/** The mission board at the base you are docked at. The cheapest credits and skill xp in the
 * intro stage: difficulty-1 missions map onto gather, hunt and goTo trips you were making
 * anyway, and pay 1,000–3,500 cr plus 20–50 xp. Max 5 active at once (`V2Missions.max_missions`). */
import type {AbandonMissionResponse,AcceptMissionResponse,ActiveMissionInfo,CompleteMissionResponse,MissionInfo,ObjectiveProgressInfo,V2Missions} from '@spacemolt/lib';
import {Effect,Option,Result,Schema,Struct} from 'effect';
import {journalRun} from '../run-record.ts';
import {TICK_MS} from '../sighting-memory.ts';
import {replyBody} from '../storage.ts';
import * as Wire from '../wire.gen.ts';
import {counterEffect} from './counter.ts';
import {Game,field,type GameError} from './game.ts';
import {Stopped,acct,admit,edge,jobEffect,runtimeDir,step,stopped} from './runtime.ts';
import {withdrawEffect} from './storage.ts';
import {kept} from './rows.ts';
import type {Outcome,Want} from './types.ts';

/** The counter, or why the job broke: a dock that was blocked is the job's failure, as a throw always was. */
const atCounter=()=>counterEffect().pipe(Effect.catchTag('DockBlocked',blocked=>Effect.succeed({broke:blocked.message})));

// The frozen surface promises the lib's types; a live row is decoded only for the fields read, because the server omits spec fields.
// oxlint-disable-next-line typescript/consistent-type-assertions
const asMission=(row:unknown)=>row as MissionInfo; // cast: frozen surface (MissionInfo)
// oxlint-disable-next-line typescript/consistent-type-assertions
const asActive=(row:unknown)=>row as ActiveMissionInfo; // cast: frozen surface (ActiveMissionInfo)
// oxlint-disable-next-line typescript/consistent-type-assertions
const asAccepted=(body:unknown)=>body as AcceptMissionResponse; // cast: frozen surface (AcceptMissionResponse)
// oxlint-disable-next-line typescript/consistent-type-assertions
const asAbandoned=(body:unknown)=>body as AbandonMissionResponse; // cast: frozen surface (AbandonMissionResponse)
// oxlint-disable-next-line typescript/consistent-type-assertions
const asCompleted=(body:unknown)=>body as CompleteMissionResponse; // cast: frozen surface (CompleteMissionResponse)

/** What is read of a board row, an active row and a reply: the fields the code reads, nothing the spec adds. */
const decodeOffer=Schema.decodeUnknownOption(Wire.MissionInfo.mapFields(fields=>({mission_id:fields.mission_id,title:Schema.optionalKey(fields.title),type:Schema.optionalKey(fields.type),
  template_id:fields.template_id,provided_items:fields.provided_items,
  rewards:Schema.optionalKey(Schema.NullOr(Wire.MissionRewardsInfo_1.mapFields(Struct.pick(['credits','skill_xp'])))),
  objectives:Schema.optionalKey(Schema.NullOr(Schema.Array(Wire.ObjectiveInfo_2.mapFields(Struct.pick(['description','item_id','quantity','target_base_id','target_base_name','system_id','system_name'])))))})));
// A listed mission is kept on its id alone: a row missing a title, a count or a progress field still holds a slot, so it is
// counted, not dropped. A field that is there must still read.
const decodeActive=Schema.decodeUnknownOption(Wire.ActiveMissionInfo.mapFields(fields=>({mission_id:fields.mission_id,title:Schema.optionalKey(fields.title),
  rewards:Schema.optionalKey(Schema.NullOr(Wire.MissionRewardsInfo_1.mapFields(Struct.pick(['credits'])))),expires_in_ticks:Schema.optionalKey(fields.expires_in_ticks),percent_complete:Schema.optionalKey(fields.percent_complete),
  community:fields.community,community_percent:fields.community_percent,
  objectives:Schema.optionalKey(Schema.NullOr(Schema.Array(Wire.ObjectiveProgressInfo.mapFields(fields=>({completed:Schema.optionalKey(fields.completed),
    current:Schema.optionalKey(fields.current),required:Schema.optionalKey(fields.required),description:Schema.optionalKey(fields.description),
    type:Schema.optionalKey(fields.type),item_id:fields.item_id,item_name:fields.item_name,in_cargo:fields.in_cargo,in_storage:fields.in_storage,
    target_base:fields.target_base,target_base_name:fields.target_base_name})))))})));
const decodeTitle=Schema.decodeUnknownOption(Wire.AcceptMissionResponse.mapFields(Struct.pick(['title'])));
const decodeAbandoned=Schema.decodeUnknownOption(Wire.AbandonMissionResponse.mapFields(Struct.pick(['title'])));
const decodeEarned=Schema.decodeUnknownOption(Wire.CompleteMissionResponse.mapFields(Struct.pick(['credits_earned'])));
const missionId=(row:unknown)=>field(row,'mission_id');


/** A board entry, with the 21 KB of dialog dropped and one line we compute for it. */
export type Offer=Omit<MissionInfo,'dialog'|'description'>&{
  /** What it wants, in one line from `objectives`: "20 aluminum_ore to frontier_station". */
  wants:string;
  /** Which library call would satisfy it: `gatherUntil`, `hunt`, `goTo`, `haul`, or none. */
  fits?:'gatherUntil'|'hunt'|'goTo'|'haul';
};

function offer(mission:MissionInfo):Offer {
  const {dialog:_d,description:_s,...rest}=mission;
  const wants=(mission.objectives??[]).map(o=>o.description||[o.quantity,o.item_id,o.target_base_name??o.target_base_id??o.system_name??o.system_id].filter(Boolean).join(' ')).join('; ');
  const text=`${mission.type??''} ${wants}`.toLowerCase();
  const fits:Offer['fits']|undefined=/mine|ore|gather|deliver/.test(text)&&(mission.objectives??[]).some(o=>o.item_id)?'gatherUntil'
    :/kill|hunt|creature|destroy/.test(text)?'hunt':/visit|explore|survey|travel|scout/.test(text)?'goTo':/shipment|package|haul|courier/.test(text)?'haul':undefined;
  return {...rest,wants,...fits?{fits}:{}};
}

/** Every mission id seen active in this process, so a gone-but-real id can be told from one
 * the account never had. ponytail: process memory, not account history — after a restart a
 * forgotten id reads as unknown, which is the safe direction. */
const known=new Set<string>();
/** Each personal mission last seen active and unexpired, with when its deadline falls. */
const running=new Map<string,{title:string;due:number}>();

/** A `mission` `expired` line for each mission seen running that is now expired: listed at zero
 * ticks, or gone once its deadline has passed. Observed on reads the code makes anyway; nothing
 * is polled. A mission gone before its deadline was turned in or dropped, and says so itself. */
function noteExpiries(now:ActiveMissionInfo[]):void {
  const at=Date.now(),runtime=runtimeDir();
  for(const [id,{title,due}] of running) {
    const row=now.find(m=>m.mission_id===id);
    if(row&&!expired(row))continue;
    running.delete(id);
    if((row||at>=due)&&runtime)journalRun(runtime,{verb:'expired',mission_id:id,title},'mission');
  }
  for(const m of now)if(!m.community&&!expired(m))running.set(m.mission_id,{title:m.title,due:at+m.expires_in_ticks*TICK_MS});
}

/** Active missions from the state section `get_active_missions` refreshes. */
export const activeEffect=()=>Effect.gen(function*() {
  const body=replyBody(yield* (yield* Game).command('spacemolt/get_active_missions',{}));
  // The reply itself is the section on a server that answers it flat; the cache is the last
  // resort, and a stale cache is how a full board looks like a free slot.
  const section=field(body,'missions')??(Array.isArray(field(body,'active'))?body:acct().state.missions);
  const max=field(section,'max_missions');
  const mine:V2Missions={active:kept('spacemolt/get_active_missions','active',field(section,'active'),decodeActive,missionId).map(asActive),
    max_missions:typeof max==='number'?max:5};
  for(const m of mine.active)known.add(m.mission_id);
  noteExpiries(mine.active);
  return mine;
});
/** Turnable in now. `percent_complete` is the personal measure; a community mission carries
 * `community_percent` instead and leaves `percent_complete` at whatever this player did. */
const completable=(m:ActiveMissionInfo):boolean=>
  m.community?(m.community_percent??0)>=100:m.percent_complete>=100;
/** Expired, per `expires_in_ticks` counting down to zero. Still listed; no longer winnable. */
const expired=(m:ActiveMissionInfo):boolean=>!m.community&&m.expires_in_ticks<=0;

const here=()=>acct().state.location?.docked_at??'';
const shortfall=(o:ObjectiveProgressInfo)=>Math.max(0,(o.required??0)-(o.current??0));
/** The base an objective names, when it names one that is not where the ship is docked. */
const elsewhere=(o:ObjectiveProgressInfo)=>{
  const target=o.target_base??o.target_base_name;
  return target&&here()&&target!==here()?target:undefined;
};
/** One line of progress per mission: "12/20 ore; visit Deep Range" for a personal mission,
 * the shared percent for a community one. The board's `did` is counts; this is the row. */
function progress(m:ActiveMissionInfo):string {
  if(m.community)return `${m.community_percent??0}% community`;
  const parts=(m.objectives??[]).map(o=>o.item_id||o.required
    ?`${o.current??0}/${o.required??0} ${o.item_name??o.item_id??o.description??''}`.trim()
    :o.description??'');
  return parts.filter(Boolean).join('; ')||`${m.percent_complete}%`;
}
/** Why this mission cannot be turned in from this dock, or undefined when it can — counting
 * a store withdrawal here as reachable, because `completeMissions` will make it. The three
 * ways a slot stays locked: the clock ran out, the goods are somewhere this trip is not, or
 * the pilot simply does not have them yet. */
export function stuck(m:ActiveMissionInfo):string|undefined {
  if(expired(m))return 'expired';
  if(completable(m))return undefined;
  if(m.community)return undefined; // shared, and it holds no personal slot
  for(const o of m.objectives??[]) {
    if(o.completed)continue;
    const away=elsewhere(o);
    if(away)return `${o.description||o.item_id||o.type} wants ${away}; docked at ${here()||'nowhere'}`;
    const short=shortfall(o);
    if(!short)continue;
    if(!o.item_id)return `${o.description||o.type}: ${o.current??0} of ${o.required??0}`;
    if((o.in_cargo??0)+(o.in_storage??0)<(o.required??0))return `needs ${short} more ${o.item_name??o.item_id}`;
  }
  return undefined;
}
/** The rows a `deliver N of item` objective is short by that the store at this base holds:
 * withdraw them and the mission completes here. Empty when no withdrawal would finish it. */
function fillable(m:ActiveMissionInfo):Want[] {
  if(m.community||expired(m)||completable(m))return [];
  const rows:Want[]=[];
  for(const o of m.objectives??[]) {
    if(o.completed)continue;
    if(elsewhere(o))return [];
    const short=shortfall(o);
    if(!short)continue;
    if(!o.item_id||(o.in_storage??0)<short)return [];
    rows.push({item_id:o.item_id,quantity:short});
  }
  return rows;
}

/** The one thing to do next for a mission: its first objective not yet met, where it is, and how far when `jumps` knows.
 * The game lists objectives in order with a `completed` flag each and says nothing of whether order is enforced, so
 * the first not completed is next (`current < required` where the flag is missing). Live 2026-10-04 (kvothe 22:02Z,
 * run 8389807d): a five-stop circuit, every objective dumped at once, was flown out of order into the run cap. */
export function nextStep(m:ActiveMissionInfo,jumps?:(o:ObjectiveProgressInfo)=>number|undefined):string {
  if(m.community)return `${m.community_percent??0}% community`;
  if(expired(m))return 'expired';
  if(completable(m))return 'turn in: completeMissions()';
  const all=m.objectives??[],at=all.findIndex(o=>!(o.completed??(o.current??0)>=(o.required??0)));
  const o=all[at];
  if(!o)return `${m.percent_complete}%`;
  const target=o.target_base??o.target_base_name,n=jumps?.(o);
  return `${o.description||o.type}`+((o.required??0)>1?` (${o.current??0}/${o.required}${o.in_cargo?`, ${o.in_cargo} aboard`:''})`:'')
    +(target?` → ${target}${n===undefined?'':n?`, ${n} jump${n===1?'':'s'}`:', this system'}`:'')+(all.length>1?` [${at+1} of ${all.length}]`:'');
}

/** An active mission led by its next step, with the lines the board could not read off it: where its objectives
 * stand, and why it cannot be turned in here. */
export type Active=ActiveMissionInfo&{next:string;progress:string;stuck?:string};
const seen=(m:ActiveMissionInfo):Active=>{const why=stuck(m);return {next:nextStep(m),...m,progress:progress(m),...why?{stuck:why}:{}};};
/** Each held mission as `title — next: …`, for a report's prose. */
const nextLines=(rows:Active[])=>rows.map(r=>`${r.title} — next: ${r.next}`).join('; ');

/** Why `active.length` can exceed `max_missions`, the only two ways the lib's types allow:
 * `community: true` (faction-wide, shared, not a personal slot) and `expires_in_ticks <= 0`
 * (run out, still in the list). The counts go in the `did` so a full board names its own cause. */
function census(mine:V2Missions) {
  const shared=mine.active.filter(m=>m.community),dead=mine.active.filter(expired);
  const ready=mine.active.filter(completable);
  const holding=mine.active.length-shared.length-dead.length;
  const notes=[shared.length?`${shared.length} community`:'',dead.length?`${dead.length} expired`:'',
    ready.length?`${ready.length} completable now`:''].filter(Boolean);
  return {free:Math.max(0,mine.max_missions-holding),ready,notes};
}

/** The board here and your active missions, compact. Over `get_missions` +
 * `get_active_missions` it adds: dialog and description dropped, one `wants` line and a
 * `fits` guess per offer. Reads only. `next` names the offers that fit the intro loops. */
export const missionsEffect=()=>jobEffect<{board:Offer[];active:Active[];max:number;slots_free:number}>('missions','',Effect.gen(function*() {
  const none={board:[],active:[],max:0,slots_free:0};
  const at=yield* atCounter();
  if('broke' in at)return {status:'failed' as const,did:'missions broke',why:at.broke,detail:none};
  if('refused' in at)return {status:'refused' as const,did:'read no board',why:at.refused,detail:none};
  const board=kept('spacemolt/get_missions','missions',field(replyBody(yield* (yield* Game).command('spacemolt/get_missions',{})),'missions'),decodeOffer,missionId).map(asMission);
  const mine=yield* activeEffect();
  const offers=board.map(offer);
  const fitting=offers.filter(o=>o.fits);
  // The slots are the constraint, so they are the first thing said: a board of 15 with
  // none free is 15 refusals waiting to happen.
  const {free,ready,notes}=census(mine);
  const rows=mine.active.map(seen),blocked=rows.filter(r=>r.stuck);
  return {status:'done' as const,
    did:`${free} slot(s) free: ${mine.active.length} of ${mine.max_missions} active${notes.length?` (${notes.join(', ')})`:''}; ${offers.length} on the board, ${fitting.length} fit a library call`
      +(rows.length?`. Held: ${nextLines(rows)}`:''),
    detail:{board:offers,active:rows,max:mine.max_missions,slots_free:free},
    next:free?fitting.slice(0,Math.min(3,free)).map(o=>`acceptMission('${o.mission_id}') — ${o.title??o.mission_id}, ${o.rewards?.credits??0} cr, fits ${o.fits}`)
      :[ready.length?`completeMissions() turns in ${ready.length} finished mission(s) and frees the slot(s)`
        :'every slot is taken: completeMissions() at the base that wants them',
      ...blocked.slice(0,2).map(r=>`abandonMission('${r.mission_id}') frees a slot — ${r.title}: ${r.stuck}`)]};
}));
export function missions():Promise<Outcome<{board:Offer[];active:Active[];max:number;slots_free:number}>> {return edge(missionsEffect());}

/** Accept one mission by `mission_id`. Over `accept_mission` it adds: refused when
 * `max_missions` are active, when a `provided_items` load will not fit the hold, when the
 * mission names a no-go system, or under Tired/Relaxed. Costs nothing. */
export const acceptMissionEffect=(id:string)=>jobEffect<AcceptMissionResponse>('acceptMission',id,Effect.gen(function*() {
  const game=yield* Game;
  const none=asAccepted({});
  const stop=yield* admit('acceptMission');
  if(stop)return {status:'refused',did:`did not accept ${id}`,why:stop,detail:none};
  const at=yield* atCounter();
  if('broke' in at)return {status:'failed',did:'acceptMission broke',why:at.broke,detail:none};
  if('refused' in at)return {status:'refused',did:`did not accept ${id}`,why:at.refused,detail:none};
  const mine=yield* activeEffect();
  if(mine.active.some(m=>m.mission_id===id)) {
    const runtime=runtimeDir();
    if(runtime)journalRun(runtime,{verb:'already_active',mission_id:id},'mission');
    return {status:'done',did:`${id} is already active`,detail:none};
  }
  // Refused here, with nothing sent: the game's own refusal costs a round trip to learn
  // what `missions().detail.slots_free` already said.
  if(!census(mine).free)return {status:'refused',did:`did not accept ${id}`,why:`no slot free: ${mine.active.length} of ${mine.max_missions} missions already active`,detail:none};
  const board=kept('spacemolt/get_missions','missions',field(replyBody(yield* game.command('spacemolt/get_missions',{})),'missions'),decodeOffer,missionId).map(asMission);
  const wanted=board.find(m=>m.mission_id===id||m.template_id===id);
  if(!wanted)return {status:'refused',did:`did not accept ${id}`,why:'not on the board here',detail:none};
  const load=Object.values(wanted.provided_items??{}).reduce((sum,q)=>sum+q,0);
  const free=(acct().state.ship?.cargo_capacity??0)-(acct().state.ship?.cargo_used??0);
  if(load>free)return {status:'refused',did:`did not accept ${id}`,why:`provides ${load} units of cargo; the hold has ${free} free`,detail:none};
  // A refusal or a lost reply goes up to the job, named; the accept is never re-sent after a lost reply.
  const reply=replyBody(yield* game.command('spacemolt/accept_mission',{id:wanted.mission_id}));
  const title=decodeTitle(reply);
  return {status:'done',did:`accepted "${Option.isSome(title)?title.value.title:wanted.title??wanted.mission_id}": ${wanted.rewards?.credits??0} cr${wanted.rewards?.skill_xp?` + ${Object.entries(wanted.rewards.skill_xp).map(([s,x])=>`${x} ${s} xp`).join(', ')}`:''}`,detail:asAccepted(reply)};
}));
export function acceptMission(id:string):Promise<Outcome<AcceptMissionResponse>> {return edge(acceptMissionEffect(id));}

/** Give up one active mission and free its slot. Over `abandon_mission` it adds: the
 * idempotent case (a mission seen active and now gone is `done`, nothing sent; an id this
 * account never had active is `refused`, so a placeholder cannot read as a success), and a refusal when
 * the mission could be turned in right here — the slot is about to free itself and pay for
 * it. Pass `{force:true}` to drop it anyway. Costs nothing but the mission. */
export const abandonMissionEffect=(id:string,opts:{force?:boolean}={})=>jobEffect<AbandonMissionResponse>('abandonMission',id,Effect.gen(function*() {
  const none=asAbandoned({});
  const mine=yield* activeEffect();
  const mission=mine.active.find(m=>m.mission_id===id);
  if(!mission)return known.has(id)?{status:'done',did:`${id} is not active`,detail:none}
    :{status:'refused',did:`did not abandon ${id}`,
      why:`no such mission: ${id} was never active on this account; active ids are ${mine.active.map(m=>m.mission_id).join(', ')||'none'}`,detail:none};
  if(!opts.force&&completable(mission))
    return {status:'refused',did:`kept "${mission.title}"`,
      why:`it is completable here: completeMissions() turns it in and frees the slot, or abandonMission('${id}', {force:true}) to drop it unpaid`,detail:none};
  // A refusal or a lost reply goes up to the job, named; the abandon is never re-sent after a lost reply.
  const reply=replyBody(yield* (yield* Game).command('spacemolt/abandon_mission',{id}));
  const after=yield* activeEffect(),{free}=census(after);
  const still=after.active.some(m=>m.mission_id===id);
  const title=decodeAbandoned(reply);
  return {status:still?'partial':'done',
    did:`abandoned "${Option.isSome(title)?title.value.title:mission.title}"${mission.expires_in_ticks<=0?' (expired)':''}; ${after.active.length} of ${after.max_missions} active, ${free} slot(s) free`,
    ...still?{why:'the server still lists it as active'}:{},detail:asAbandoned(reply)};
}));
export function abandonMission(id:string,opts:{force?:boolean}={}):Promise<Outcome<AbandonMissionResponse>> {return edge(abandonMissionEffect(id,opts));}

/** Turn in every active mission that can be completed at this dock. Over `complete_mission`
 * it adds: the loop over the active list, a `withdraw` from the store here for a `deliver N
 * of item` objective the store can cover, and one line per mission saying what happened.
 * Never abandons: a mission it cannot finish is left in `remaining` with its `stuck` reason. */
export const completeMissionsEffect=()=>jobEffect<{completed:CompleteMissionResponse[];remaining:Active[]}>('completeMissions','',Effect.gen(function*() {
  const game=yield* Game;
  const mine=yield* activeEffect();
  const completed:CompleteMissionResponse[]=[],failed:{id:string;error:GameError}[]=[],said:string[]=[];
  let earnedTotal=0;
  for(const mission of mine.active) {
    if(stopped())return yield* Effect.fail(new Stopped());
    const rows=fillable(mission);
    if(!completable(mission)&&!rows.length)continue;
    if(rows.length) {
      const out=yield* withdrawEffect(rows);
      if(out.status==='refused'){said.push(`${mission.title}: ${out.why??'withdrawal refused'}`);continue;}
      // A withdraw that failed or came up partial is said as that; complete is still sent, as it always was.
      said.push(out.status==='done'?`${mission.title}: withdrew ${rows.map(r=>`${r.quantity} ${r.item_id}`).join(', ')} from the store here`
        :`${mission.title}: withdraw ${out.status}: ${out.why??'no reason given'}`);
    }
    // A refused complete is that mission's line and the loop goes on; a lost reply is never re-sent, and the re-read below says where it stands.
    const sent=yield* Effect.result(game.command('spacemolt/complete_mission',{id:mission.mission_id}));
    if(Result.isFailure(sent)) {
      const error=sent.failure;
      failed.push({id:mission.mission_id,error});
      continue;
    }
    const reply=replyBody(sent.success),earned=decodeEarned(reply);
    if(Option.isNone(earned))step(`spacemolt/complete_mission: ${mission.mission_id} reply had no credits_earned; counted as 0 cr`);
    const credits=Option.isSome(earned)?earned.value.credits_earned:0;
    earnedTotal+=credits;
    completed.push(asCompleted(reply));step(`completed ${mission.mission_id} +${credits} cr`);
    said.push(`${mission.title}: completed for ${credits} cr`);
  }
  const after=yield* activeEffect(),{free,notes}=census(after);
  const rest=after.active.map(seen),blocked=rest.filter(r=>r.stuck);
  const tail=`${after.active.length} remain, ${free} slot(s) free${notes.length?` (${notes.join(', ')})`:''}`;
  const lines=failed.map(f=>`${f.id}: ${f.error._tag==='ReplyLost'?`reply lost on ${f.error.action}; state re-read`:`${f.error.code} — ${f.error.message}`}`
    +(after.active.some(m=>m.mission_id===f.id)?'':'; no longer active'));
  // Nothing turned in is not a mission done: `done` here put "missions done" in the run
  // summary and the pilot carried it forward into the next script as work already paid for.
  const lost=failed.some(f=>f.error._tag==='ReplyLost');
  const status=lost?(completed.length?'partial' as const:'failed' as const)
    :completed.length?(failed.length?'partial' as const:'done' as const):'refused' as const;
  // What is still held is said once, by its next step: the refusal's why, else the did's tail.
  const why=failed.length?lines.join('; ')
    :completed.length?'':blocked.length?nextLines(blocked)
      :'no active mission is completable at this dock';
  const held=completed.length&&blocked.length?`. Held: ${nextLines(blocked)}`:'';
  return {status,
    did:(completed.length?`completed ${completed.length} mission(s) for ${earnedTotal} cr`:'nothing completable')
      +`; ${tail}${said.length?`. ${said.join('. ')}`:''}${held}`,
    ...why?{why}:{},
    detail:{completed,remaining:rest},
    next:free?[]:blocked.slice(0,3).map(r=>`abandonMission('${r.mission_id}') frees a slot — ${r.title}: ${r.stuck}`)};
}));
export function completeMissions():Promise<Outcome<{completed:CompleteMissionResponse[];remaining:Active[]}>> {return edge(completeMissionsEffect());}
