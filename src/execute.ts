import { ACTIONS } from '@spacemolt/lib';
import {commandSpend,isPaidCommand,withCraftSpendEvidence} from './spending.ts';

interface GameAccount {
  readonly state?:{player?:{stats?:unknown}};
  send(tool:string, action:string, params?:Record<string,unknown>):Promise<unknown>;
  refresh():Promise<unknown>;
}

export async function sendAndRefresh(account:GameAccount, key:string, params:Record<string,unknown> | undefined, executed:(result?:unknown)=>void) {
  const [tool,action] = key.split('/');
  const stats=account.state?.player?.stats;
  const before=stats&&typeof stats==='object'&&'credits_spent' in stats?stats.credits_spent:undefined;
  let result:any = await account.send(tool!,action!,key === 'spacemolt/craft' ? {...params, source:'storage', deliver_to:'storage'} : params);
  if(key==='spacemolt/buy'&&result&&typeof result==='object') {
    const receipt=result.structuredContent??result.delta?.details??result;
    if(receipt&&typeof receipt==='object') {
      // Capture before refresh can fail; never replace the server's market subtotal.
      const priced={...receipt,_hermes_spending:{source:'lifetime_credits_spent_interval',before,
        after:result.delta?.player?.stats?.credits_spent,market_subtotal:receipt.total_cost}};
      result=result.structuredContent?{...result,structuredContent:priced}:
        result.delta?.details?{...result,delta:{...result.delta,details:priced}}:priced;
    }
  }
  const pendingCraft=key==='spacemolt/craft'&&isPaidCommand(key,params)&&commandSpend(key,result,params)===null;
  if(pendingCraft)result=withCraftSpendEvidence(result,before);
  executed(result);
  // Dock outcomes omit mission changes on the live server.
  if (ACTIONS[key]?.kind === 'mutation' || key === 'spacemolt/get_status') await account.refresh();
  if(pendingCraft) {
    const refreshed=account.state?.player?.stats;
    const after=refreshed&&typeof refreshed==='object'&&'credits_spent' in refreshed?refreshed.credits_spent:undefined;
    result=withCraftSpendEvidence(result,before,after,'refreshed');
    executed(result);
  }
  return result;
}
