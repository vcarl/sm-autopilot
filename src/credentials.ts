/** How an account logs in: the one endpoint, and a credentials file of `Username:` and
 * `Password:` lines. The bridge reads its pilot's; the freighter host reads each freighter's. */
import {readFileSync} from 'node:fs';

/** The one endpoint this runner talks to. */
export const GAME_WS_URL='wss://game.spacemolt.com/ws/v2';

export function readCredentials(path:string):{username:string;password:string} {
  const text=readFileSync(path,'utf8');
  const username=text.match(/^Username: (.+)$/m)?.[1]?.trim();
  const password=text.match(/^Password: (.+)$/m)?.[1]?.trim();
  if(!username||!password)throw new Error(`Missing Username or Password field in credentials file ${path}`);
  return {username,password};
}
