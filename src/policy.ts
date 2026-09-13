import { ACTIONS } from '@spacemolt/lib';
import {evaluateRules,requireAllowed} from './rules.ts';
export {allowed,combatActions} from './rules-actions.ts';
export function validateAction(action: string, params: Record<string, unknown> = {}) {
  return requireAllowed(evaluateRules({phase:'raw',action,params,raw:{known:action in ACTIONS}}));
}
export function catalog() {
  return Object.fromEntries(Object.entries(ACTIONS).filter(([key]) => evaluateRules({phase:'raw',action:key,raw:{known:true,catalog:true}}).allowed).map(([key,value]) => {
    const forbidden = key.startsWith('spacemolt_storage/') ? ['target','source','credits','message'] : ['spacemolt/refuel','spacemolt/repair'].includes(key) ? ['target'] : [];
    const craftFields = ['id','quantity','dry_run','preset','facility_id','job_id','source','deliver_to'];
    return [key, {...value, summary:key === 'spacemolt/craft' ? 'Quote (dry_run=true) or queue one recipe by id using personal station storage. quantity is output count. No id lists queued jobs; job_id cancels that job. Output arrives later in storage; never resubmit pending work.' : key.startsWith('spacemolt_storage/') ? 'Manage your personal items at station storage' : value.summary, params:value.params.filter(p => !forbidden.includes(p.name) && (key !== 'spacemolt/craft' || craftFields.includes(p.name)))}];
  }));
}
