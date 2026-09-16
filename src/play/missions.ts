/** The mission board at the base you are docked at. The cheapest credits and skill xp in the
 * intro stage: difficulty-1 missions map onto gather, hunt and goTo trips you were making
 * anyway, and pay 1,000–3,500 cr plus 20–50 xp. Max 5 active at once (`V2Missions.max_missions`). */
import type {AcceptMissionResponse,ActiveMissionInfo,CompleteMissionResponse,GetMissionsResponse,MissionInfo,V2Missions} from '@spacemolt/lib';
import {details} from '../response-details.ts';
import {acct,admit,checkStop,command,job,pilot,step} from './runtime.ts';
import type {Outcome} from './types.ts';

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

/** Active missions from the state section `get_active_missions` refreshes. */
async function active():Promise<V2Missions> {
  const reply=details(await command('spacemolt/get_active_missions',{})) as {missions?:V2Missions}&Partial<V2Missions>;
  // The reply itself is the section on a server that answers it flat; the cache is the last
  // resort, and a stale cache is how a full board looks like a free slot.
  const section=reply.missions??(Array.isArray(reply.active)?reply as V2Missions:acct().state.missions as V2Missions|undefined);
  return {active:section?.active??[],max_missions:section?.max_missions??5};
}

/** The board here and your active missions, compact. Over `get_missions` +
 * `get_active_missions` it adds: dialog and description dropped, one `wants` line and a
 * `fits` guess per offer. Reads only. `next` names the offers that fit the intro loops. */
export function missions():Promise<Outcome<{board:Offer[];active:ActiveMissionInfo[];max:number;slots_free:number}>> {
  return job('missions','',async()=>{
    if(!acct().state.location?.docked_at)return {status:'refused' as const,did:'read no board',why:'not docked; the board is a station counter',detail:{board:[],active:[],max:0,slots_free:0}};
    const board=(details(await command('spacemolt/get_missions',{})) as GetMissionsResponse).missions??[];
    const mine=await active();
    const offers=board.map(offer);
    const fitting=offers.filter(o=>o.fits);
    // The slots are the constraint, so they are the first thing said: a board of 15 with
    // none free is 15 refusals waiting to happen.
    const free=Math.max(0,mine.max_missions-mine.active.length);
    return {status:'done' as const,
      did:`${free} slot(s) free: ${mine.active.length} of ${mine.max_missions} active; ${offers.length} on the board, ${fitting.length} fit a library call`,
      detail:{board:offers,active:mine.active,max:mine.max_missions,slots_free:free},
      next:free?fitting.slice(0,Math.min(3,free)).map(o=>`acceptMission('${o.mission_id}') — ${o.title}, ${o.rewards?.credits??0} cr, fits ${o.fits}`)
        :['every slot is taken: completeMissions() at the base that wants them, or abandon one with account()']};
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
    if(mine.active.length>=mine.max_missions)return {status:'refused',did:`did not accept ${id}`,why:`no slot free: ${mine.active.length} of ${mine.max_missions} missions already active`,detail:none};
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

/** Complete every active mission whose `percent_complete` is 100 here. Over
 * `complete_mission` it adds: the loop over the active list and the idempotent empty case.
 * Never abandons: an active mission not yet complete is left in `remaining`. */
export function completeMissions():Promise<Outcome<{completed:CompleteMissionResponse[];remaining:ActiveMissionInfo[]}>> {
  return job('completeMissions','',async()=>{
    const mine=await active();
    const completed:CompleteMissionResponse[]=[],failed:string[]=[];
    for(const mission of mine.active.filter(m=>m.percent_complete>=100)) {
      checkStop();
      try {
        const reply=details(await command('spacemolt/complete_mission',{id:mission.mission_id})) as CompleteMissionResponse;
        completed.push(reply);step(`completed ${mission.mission_id} +${reply.credits_earned??0} cr`);
      } catch(error){failed.push(`${mission.mission_id}: ${(error as Error).message}`);}
    }
    const after=await active();
    return {status:failed.length?'partial' as const:'done' as const,
      did:completed.length?`completed ${completed.length} mission(s) for ${completed.reduce((s,r)=>s+(r.credits_earned??0),0)} cr; ${after.active.length} remain`:`nothing completable; ${after.active.length} active remain`,
      ...failed.length?{why:failed.join('; ')}:{},
      detail:{completed,remaining:after.active},
      next:after.active.slice(0,3).map(m=>`${m.mission_id}: ${m.percent_complete}% — ${m.objectives?.[0]?.description??''}`)};
  });
}
