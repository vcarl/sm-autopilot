import { ACTIONS } from '@spacemolt/lib';

interface GameAccount {
  send(tool:string, action:string, params?:Record<string,unknown>):Promise<unknown>;
  refresh():Promise<unknown>;
}

export async function sendAndRefresh(account:GameAccount, key:string, params:Record<string,unknown> | undefined, executed:(result?:unknown)=>void) {
  const [tool,action] = key.split('/');
  const result = await account.send(tool!,action!,key === 'spacemolt/craft' ? {...params, source:'storage', deliver_to:'storage'} : params);
  executed(result);
  // Dock outcomes omit mission changes on the live server.
  if (ACTIONS[key]?.kind === 'mutation' || key === 'spacemolt/get_status') await account.refresh();
  return result;
}
