import {evaluateRules,deniedTexts} from './rules.ts';
import {ACTIONS,type Account} from '@spacemolt/lib';
import {battleStatus,controlHunt} from './combat.ts';
import {details} from './response-details.ts';
import {type IndustryCommand} from './industry.ts';
import type {ExecutionStore,Job} from './execution-store.ts';
import {observeObligations,ObligationObservationError} from './obligations.ts';
import type {ServiceClock} from './servicing.ts';
import {verifyGatherInventory,type GatherReceipt} from './gather.ts';
import {jobSpending,jobBudget,withCraftSpendEvidence} from './spending.ts';
import {reconcileProductionAcceptance} from './shared-production.ts';

type Wire=Record<string,any>;
export function reconcileAction(action:Job['actions'][number],state:Wire,battle:Wire|null) {
  if(action.accepted_result!==undefined||action.status==='confirmed')return {resolved:true,reason:'Command response was durably recorded; objective completion still requires verification'};
  if(ACTIONS[action.action]?.kind==='query'||(action.action==='spacemolt/craft'&&!Object.keys(action.params as object).length))return {resolved:true,reason:'Read-only observation has no productive effect to replay'};
  if(!battle&&['spacemolt_battle/stance','spacemolt_battle/advance','spacemolt_battle/retreat','spacemolt_battle/target'].includes(action.action))return {resolved:true,reason:'Battle ended; this tactical instruction has no remaining effect to replay'};
  const before=action.before as Wire|undefined,location=state.location,params=action.params as Wire;
  if(!before?.ship?.id||before.ship.id!==state.ship?.id)return {resolved:false,reason:'Missing pre-action ship identity or ship changed'};
  if(typeof location?.system_id!=='string'||!location.system_id)return {resolved:false,reason:'Current location is incomplete'};
  if(location?.in_transit)return {resolved:false,reason:'Transit is still active; wait for authoritative arrival'};
  const matches:Record<string,()=>boolean>={
    'spacemolt/travel':()=>location?.system_id===before.location?.system_id&&location?.poi_id===params.id,
    'spacemolt/jump':()=>location?.system_id===params.id,
    'spacemolt/dock':()=>Boolean(before.location?.poi_id)&&Boolean(location?.docked_at)&&location?.system_id===before.location?.system_id&&location?.poi_id===before.location?.poi_id,
    'spacemolt/undock':()=>Boolean(before.location?.docked_at)&&!location?.docked_at&&location?.system_id===before.location?.system_id&&location?.poi_id===before.location?.poi_id,
    'spacemolt/hunt':()=>Boolean(battle?.participants?.some((p:Wire)=>p.player_id===params.id)),
  };
  return matches[action.action]?.()?{resolved:true,reason:'Authoritative state confirms the requested destination or active quarry'}:
    {resolved:false,reason:'No unambiguous action evidence; do not infer acceptance or absence from a balance or missing battle'};
}

export interface RecoveryOps {
  command:IndustryCommand;
  snapshot:()=>Wire;
  resetBoundary:()=>void;
  returnHome:()=>Promise<unknown>;
  uncertain:()=>boolean;
  clock?:ServiceClock;
}
/** Recovery ends the interrupted work; it never restarts the productive objective. */
export async function reconcileJob(account:Account,store:ExecutionStore,job:Job,ops:RecoveryOps) {
  const pending=job.actions.filter(a=>a.status==='pending'||a.status==='uncertain');
  const evidence:Wire={at:new Date().toISOString(),observations:{},decisions:[],outcome:'needs_reconciliation'};
  job.reconciliation??=[];job.reconciliation.push(evidence);store.save();
  const probe:IndustryCommand=async(action,params={})=>{
    // These fixed observations are separate from the failed mutation boundary.
    const [tool,name]=action.split('/');
    const value=await account.send(tool!,name!,params);
    evidence.observations[action]=value;store.save();return value;
  };
  try {
    const now=ops.clock?.now??Date.now,sleep=ops.clock?.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
    const start=now();
    while(account.authenticated===false) {
      if(now()-start>=30000)throw new Error('Library reconnect has not authenticated within 30 seconds; retry reconciliation after connection recovery');
      await sleep(1000);
    }
    await account.refresh();
    evidence.state=ops.snapshot();store.save();
    const battle=await battleStatus(probe);
    evidence.battle=battle;store.save();
    // An observed live battle warrants defensive escape even if an economic effect
    // is still unresolved. Only the defender receives a healthy command boundary here.
    if(battle) {
      ops.resetBoundary();
      evidence.defense=await controlHunt(account,ops.command,'',{observed_battle:battle,force_retreat:true,max_ticks:1,retreat_hull_fraction:0.95},ops.clock);
      store.save();
    }
    const previousBattle=[...job.actions].reverse().map(a=>details(a.accepted_result??a.result)).find(s=>s.is_participant===true&&typeof s.battle_id==='string');
    if(!battle&&previousBattle) {
      const summary=details(await probe('spacemolt_battle/summary',{id:previousBattle.battle_id}));
      evidence.battle_summary=summary;store.save();
      if(summary.battle_id!==previousBattle.battle_id||summary.status!=='completed')throw new Error('Recorded battle has no matching authoritative terminal summary');
    }
    try {evidence.obligations=await observeObligations(account,probe);}
    catch(error) {
      if(!(error instanceof ObligationObservationError))throw error;
      evidence.obligation_error=String(error);store.save();
    }
    await account.refresh();
    const state=ops.snapshot();evidence.state=state;
    for(const action of job.actions) {
      const receipt=details(action.accepted_result);
      const spending=receipt?._hermes_spending;
      const after=(account.state.player?.stats as Wire)?.credits_spent;
      if(action.action==='spacemolt/craft'&&receipt?.kind==='job'&&spending?.source==='lifetime_credits_spent_interval'&&spending.phase==='accepted'&&
        typeof spending.before==='number'&&Number.isFinite(spending.before)&&spending.before>=0&&typeof after==='number'&&Number.isFinite(after)&&after>=spending.before) {
        action.accepted_result=withCraftSpendEvidence(action.accepted_result,spending.before,after,'refreshed');
      }
    }
    if(state.ship?.id!==(job.before as Wire)?.ship?.id)throw new Error('Ship changed since job admission; reconcile loss before returning');
    if(state.location?.in_transit)throw new Error('Transit still active; do not replay movement');
    for(const action of pending) {
      const observedQuarry=battle??job.reconciliation?.map(r=>r.battle).find(b=>b?.participants?.some((p:Wire)=>p.player_id===(action.params as Wire).id));
      const decision=reconcileAction(action,state,action.action==='spacemolt/hunt'?observedQuarry??null:battle);
      evidence.decisions.push({action_index:job.actions.indexOf(action),action:action.action,...decision});
      if(decision.resolved) {action.status='confirmed';action.reconciled_by=decision.reason;}
    }
    store.save();
    if(evidence.decisions.some((d:Wire)=>!d.resolved))throw new Error('Unresolved action effect; inspect the recorded evidence before any productive retry');
    reconcileProductionAcceptance(job);store.save();
    ops.resetBoundary();
    evidence.cleanup_attempted=true;store.save();
    evidence.cleanup=await ops.returnHome();
    await account.refresh();
    job.obligations_after=await observeObligations(account,probe);
    job.obligation_verification={status:'observed',reason:'Outstanding commitments remain unfinished after recovery'};
    evidence.obligation_verification=job.obligation_verification;
    if(job.action==='gather') {
      let progress=job.result as Wire|undefined;
      while(progress?.partial)progress=progress.partial;
      // Recovery verifies custody of already recorded yield, never attributes
      // additional cargo to the interrupted mining command or restarts it.
      if(progress?.gather)verifyGatherInventory(progress.gather as GatherReceipt,account);
    }
    job.status=job.action==='return_to_base'?'returned_to_base':'interrupted';
    evidence.outcome=job.status;
  } catch(error) {
    evidence.error=String(error);
    if(!evidence.obligation_verification)job.obligation_verification={status:'unavailable',reason:'Recovery did not verify terminal obligations: '+String(error)};
    job.status=evidence.cleanup_attempted&&!ops.uncertain()?'blocked':'needs_reconciliation';
    evidence.outcome=job.status;
  } finally {
    job.after=ops.snapshot();job.cash_delta=account.credits!-(job.before as Wire).credits;
    job.spending=jobSpending(job);
    job.budget_spending=jobBudget(job,store.data.jobs);
    const decision=evaluateRules({phase:'spent',paid:true,budget:job.budget_spending,credits:account.credits});
    job.decisions??=[];job.decisions.push({phase:'spent',action:job.action,decision});
    if(!decision.allowed) {
      job.status=decision.reasons.some(reason=>reason.id==='spend.unknown')?'needs_reconciliation':'blocked';
      evidence.error=deniedTexts(decision).join('; ');
    }
    evidence.outcome=job.status;
    store.save();
  }
  return structuredClone(job);
}
