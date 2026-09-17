/** The mission board at the base you are docked at. The cheapest credits and skill xp in the
 * intro stage: difficulty-1 missions map onto gather, hunt and goTo trips you were making
 * anyway, and pay 1,000–3,500 cr plus 20–50 xp. Max 5 active at once (`V2Missions.max_missions`). */
import type {AbandonMissionResponse,AcceptMissionResponse,ActiveMissionInfo,CompleteMissionResponse,GetMissionsResponse,MissionInfo,ObjectiveProgressInfo,V2Missions} from '@spacemolt/lib';
import {details} from '../response-details.ts';
import {acct,admit,checkStop,command,job,pilot,step} from './runtime.ts';
import {withdraw} from './storage.ts';
import type {Outcome,Want} from './types.ts';

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
  const text=`${mission.type} ${wants}`.toLowerCase();
  const fits:Offer['fits']|undefined=/mine|ore|gather|deliver/.test(text)&&(mission.objectives??[]).some(o=>o.item_id)?'gatherUntil'
    :/kill|hunt|creature|destroy/.test(text)?'hunt':/visit|explore|survey|travel|scout/.test(text)?'goTo':/shipment|package|haul|courier/.test(text)?'haul':undefined;
  return {...rest,wants,...fits?{fits}:{}};
}

/** Every mission id seen active in this process, so a gone-but-real id can be told from one
 * the account never had. ponytail: process memory, not account history — after a restart a
 * forgotten id reads as unknown, which is the safe direction. */
const known=new Set<string>();

/** Active missions from the state section `get_active_missions` refreshes. */
export async function active():Promise<V2Missions> {
  const reply=details(await command('spacemolt/get_active_missions',{})) as {missions?:V2Missions}&Partial<V2Missions>;
  // The reply itself is the section on a server that answers it flat; the cache is the last
  // resort, and a stale cache is how a full board looks like a free slot.
  const section=reply.missions??(Array.isArray(reply.active)?reply as V2Missions:acct().state.missions as V2Missions|undefined);
  const mine={active:section?.active??[],max_missions:section?.max_missions??5};
  for(const m of mine.active)known.add(m.mission_id);
  return mine;
}

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

/** An active mission with the two lines the board could not read off it: where its objectives
 * stand, and why it cannot be turned in here. */
export type Active=ActiveMissionInfo&{progress:string;stuck?:string};
const seen=(m:ActiveMissionInfo):Active=>{const why=stuck(m);return {...m,progress:progress(m),...why?{stuck:why}:{}};};

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
export function missions():Promise<Outcome<{board:Offer[];active:Active[];max:number;slots_free:number}>> {
  return job('missions','',async()=>{
    if(!acct().state.location?.docked_at)return {status:'refused' as const,did:'read no board',why:'not docked; the board is a station counter',detail:{board:[],active:[],max:0,slots_free:0}};
    const board=(details(await command('spacemolt/get_missions',{})) as GetMissionsResponse).missions??[];
    const mine=await active();
    const offers=board.map(offer);
    const fitting=offers.filter(o=>o.fits);
    // The slots are the constraint, so they are the first thing said: a board of 15 with
    // none free is 15 refusals waiting to happen.
    const {free,ready,notes}=census(mine);
    const rows=mine.active.map(seen),blocked=rows.filter(r=>r.stuck);
    return {status:'done' as const,
      did:`${free} slot(s) free: ${mine.active.length} of ${mine.max_missions} active${notes.length?` (${notes.join(', ')})`:''}; ${offers.length} on the board, ${fitting.length} fit a library call`
        +(blocked.length?`; stuck here: ${blocked.map(r=>`${r.title} (${r.stuck})`).join(', ')}`:''),
      detail:{board:offers,active:rows,max:mine.max_missions,slots_free:free},
      next:free?fitting.slice(0,Math.min(3,free)).map(o=>`acceptMission('${o.mission_id}') — ${o.title}, ${o.rewards?.credits??0} cr, fits ${o.fits}`)
        :[ready.length?`completeMissions() turns in ${ready.length} finished mission(s) and frees the slot(s)`
          :'every slot is taken: completeMissions() at the base that wants them',
        ...blocked.slice(0,2).map(r=>`abandonMission('${r.mission_id}') frees a slot — ${r.title}: ${r.stuck}`)]};
  });
}

/** Accept one mission by `mission_id`. Over `accept_mission` it adds: refused when
 * `max_missions` are active, when a `provided_items` load will not fit the hold, when the
 * mission names a no-go system, or under Tired/Relaxed. Costs nothing. */
export function acceptMission(id:string):Promise<Outcome<AcceptMissionResponse>> {
  return job<AcceptMissionResponse>('acceptMission',id,async()=>{
    const none={} as AcceptMissionResponse;
    const stop=admit('acceptMission');
    if(stop)return {status:'refused',did:`did not accept ${id}`,why:stop,detail:none};
    if(!acct().state.location?.docked_at)return {status:'refused',did:`did not accept ${id}`,why:'not docked',detail:none};
    const mine=await active();
    if(mine.active.some(m=>m.mission_id===id))return {status:'done',did:`${id} is already active`,detail:none};
    // Refused here, with nothing sent: the game's own refusal costs a round trip to learn
    // what `missions().detail.slots_free` already said.
    if(!census(mine).free)return {status:'refused',did:`did not accept ${id}`,why:`no slot free: ${mine.active.length} of ${mine.max_missions} missions already active`,detail:none};
    const board=(details(await command('spacemolt/get_missions',{})) as GetMissionsResponse).missions??[];
    const wanted=board.find(m=>m.mission_id===id||m.template_id===id);
    if(!wanted)return {status:'refused',did:`did not accept ${id}`,why:'not on the board here',detail:none};
    const noGo=pilot().permissions?.no_go??[];
    const away=(wanted.objectives??[]).find(o=>o.system_id&&noGo.includes(o.system_id));
    if(away)return {status:'refused',did:`did not accept ${id}`,why:`objective in no-go system ${away.system_id}`,detail:none};
    const load=Object.values(wanted.provided_items??{}).reduce((sum,q)=>sum+q,0);
    const free=(acct().state.ship?.cargo_capacity??0)-(acct().state.ship?.cargo_used??0);
    if(load>free)return {status:'refused',did:`did not accept ${id}`,why:`provides ${load} units of cargo; the hold has ${free} free`,detail:none};
    const reply=details(await command('spacemolt/accept_mission',{id:wanted.mission_id})) as AcceptMissionResponse;
    return {status:'done',did:`accepted "${reply.title??wanted.title}": ${wanted.rewards?.credits??0} cr${wanted.rewards?.skill_xp?` + ${Object.entries(wanted.rewards.skill_xp).map(([s,x])=>`${x} ${s} xp`).join(', ')}`:''}`,detail:reply};
  });
}

/** Give up one active mission and free its slot. Over `abandon_mission` it adds: the
 * idempotent case (a mission seen active and now gone is `done`, nothing sent; an id this
 * account never had active is `refused`, so a placeholder cannot read as a success), and a refusal when
 * the mission could be turned in right here — the slot is about to free itself and pay for
 * it. Pass `{force:true}` to drop it anyway. Costs nothing but the mission. */
export function abandonMission(id:string,opts:{force?:boolean}={}):Promise<Outcome<AbandonMissionResponse>> {
  return job<AbandonMissionResponse>('abandonMission',id,async()=>{
    const none={} as AbandonMissionResponse;
    const mine=await active();
    const mission=mine.active.find(m=>m.mission_id===id);
    if(!mission)return known.has(id)?{status:'done',did:`${id} is not active`,detail:none}
      :{status:'refused',did:`did not abandon ${id}`,
        why:`no such mission: ${id} was never active on this account; active ids are ${mine.active.map(m=>m.mission_id).join(', ')||'none'}`,detail:none};
    if(!opts.force&&completable(mission))
      return {status:'refused',did:`kept "${mission.title}"`,
        why:`it is completable here: completeMissions() turns it in and frees the slot, or abandonMission('${id}', {force:true}) to drop it unpaid`,detail:none};
    const reply=details(await command('spacemolt/abandon_mission',{id})) as AbandonMissionResponse;
    const after=await active(),{free}=census(after);
    const still=after.active.some(m=>m.mission_id===id);
    return {status:still?'partial':'done',
      did:`abandoned "${reply.title??mission.title}"${mission.expires_in_ticks<=0?' (expired)':''}; ${after.active.length} of ${after.max_missions} active, ${free} slot(s) free`,
      ...still?{why:'the server still lists it as active'}:{},detail:reply};
  });
}

/** Turn in every active mission that can be completed at this dock. Over `complete_mission`
 * it adds: the loop over the active list, a `withdraw` from the store here for a `deliver N
 * of item` objective the store can cover, and one line per mission saying what happened.
 * Never abandons: a mission it cannot finish is left in `remaining` with its `stuck` reason. */
export function completeMissions():Promise<Outcome<{completed:CompleteMissionResponse[];remaining:Active[]}>> {
  return job('completeMissions','',async()=>{
    const mine=await active();
    const completed:CompleteMissionResponse[]=[],failed:string[]=[],said:string[]=[];
    for(const mission of mine.active) {
      checkStop();
      const rows=fillable(mission);
      if(!completable(mission)&&!rows.length) {
        const why=stuck(mission);
        if(why)said.push(`${mission.title}: ${why}`);
        continue;
      }
      if(rows.length) {
        const out=await withdraw(rows);
        if(out.status==='refused'){said.push(`${mission.title}: ${out.why??'withdrawal refused'}`);continue;}
        said.push(`${mission.title}: withdrew ${rows.map(r=>`${r.quantity} ${r.item_id}`).join(', ')} from the store here`);
      }
      try {
        const reply=details(await command('spacemolt/complete_mission',{id:mission.mission_id})) as CompleteMissionResponse;
        completed.push(reply);step(`completed ${mission.mission_id} +${reply.credits_earned??0} cr`);
        said.push(`${mission.title}: completed for ${reply.credits_earned??0} cr`);
      } catch(error){failed.push(`${mission.mission_id}: ${(error as Error).message}`);}
    }
    const after=await active(),{free,notes}=census(after);
    const rest=after.active.map(seen),blocked=rest.filter(r=>r.stuck);
    const tail=`${after.active.length} remain, ${free} slot(s) free${notes.length?` (${notes.join(', ')})`:''}`;
    return {status:failed.length?'partial' as const:'done' as const,
      did:(completed.length?`completed ${completed.length} mission(s) for ${completed.reduce((s,r)=>s+(r.credits_earned??0),0)} cr`:'nothing completable')
        +`; ${tail}${said.length?`. ${said.join('. ')}`:''}`,
      ...failed.length?{why:failed.join('; ')}:{},
      detail:{completed,remaining:rest},
      next:free?[]:blocked.slice(0,3).map(r=>`abandonMission('${r.mission_id}') frees a slot — ${r.title}: ${r.stuck}`)};
  });
}
