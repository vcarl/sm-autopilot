import { validateAction, catalog } from './policy.ts';
import { Account } from '@spacemolt/lib';
import { sendAndRefresh } from './execute.ts';
import { CommandBoundary } from './command-boundary.ts';
import { industry } from './industry.ts';
import { industryCatalog } from './industry-metadata.ts';
import { miningExperiment, type MiningExperimentParams } from './mining-experiment.ts';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';

const credentialPath = process.env.SPACEMOLT_CREDENTIALS_FILE ?? '/Users/vcarl/workspace/testbench/roci-testing/players/kvothe/me/credentials.txt';
const credentialsText = readFileSync(credentialPath, 'utf8');
const password = credentialsText.match(/^Password: (.+)$/m)?.[1]?.trim();
const username = credentialsText.match(/^Username: (.+)$/m)?.[1]?.trim();
if (!password || !username) throw new Error('Missing Username or Password field in credentials file');
const credentials = () => ({kind: 'login' as const, username, password});
const account = new Account({url:'wss://game.spacemolt.com/ws/v2', reconnect:true, credentials});
mkdirSync(new URL('../runtime/', import.meta.url), {recursive:true});
const state = () => ({credits:account.credits, ship:account.ship, cargo:account.cargo,
  modules:account.state.modules, skills:account.state.skills,
  location:account.location && {system_id:account.location.system_id, poi_id:account.location.poi_id,
    docked_at:account.location.docked_at, connections:account.location.connections,
    resources:account.location.resources, security_status:account.location.security_status,
    in_transit:account.location.in_transit, transit_dest_system_id:account.location.transit_dest_system_id,
    transit_dest_poi_id:account.location.transit_dest_poi_id, transit_arrival_tick:account.location.transit_arrival_tick}, missions:account.state.missions});
const emit = (data: unknown) => console.log(JSON.stringify(data));
await account.connect();
await account.authenticate(credentials());
emit({event:'ready', state:state()});
const input = createInterface({input:process.stdin, terminal:false});
try {
  for await (const line of input) {
    let request: {id?:string; action:string; params?:Record<string,unknown>} | undefined;
    const boundary = new CommandBoundary();
    try {
      request = JSON.parse(line);
      if (!request) throw new Error('Missing request');
      let result:unknown;
      if (request.action === 'state') { await account.refresh(); result = state(); }
      else if (request.action === 'catalog') result = {...catalog(),...industryCatalog};
      else if (request.action in industryCatalog) {
        let step = 0;
        const command = (action:string,params?:Record<string,unknown>) => boundary.run(async (markSent,markCompleted) => {
          validateAction(action,params);
          const subrequest = {id:`${request!.id}/${++step}`,action,params};
          appendFileSync(new URL('../runtime/gameplay.jsonl', import.meta.url), JSON.stringify({at:new Date().toISOString(),event:'requested',request:subrequest})+'\n',{mode:0o600});
          markSent();
          const value = await sendAndRefresh(account,action,params,markCompleted);
          appendFileSync(new URL('../runtime/gameplay.jsonl', import.meta.url), JSON.stringify({at:new Date().toISOString(),request:subrequest,ok:true,result:value,state:state()})+'\n',{mode:0o600});
          return value;
        });
        result = request.action === 'industry/mine'
          ? await miningExperiment(request.params as unknown as MiningExperimentParams,account,command)
          : await industry(request.action.split('/')[1]!,request.params??{},account,command);
        boundary.assertHealthy();
      }
      else {
        validateAction(request.action, request.params);
        appendFileSync(new URL('../runtime/gameplay.jsonl', import.meta.url), JSON.stringify({at:new Date().toISOString(),event:'requested',request})+'\n', {mode:0o600});
        result = await boundary.run(async (markSent,markCompleted) => {
          markSent();
          return sendAndRefresh(account, request!.action, request!.params, markCompleted);
        });
      }
      const response = {id:request.id, ok:true, result, state:state()};
      appendFileSync(new URL('../runtime/gameplay.jsonl', import.meta.url), JSON.stringify({at:new Date().toISOString(),request,...response})+'\n', {mode:0o600});
      emit(response);
    } catch(error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
      const response = {id:request?.id,ok:false,error:error instanceof Error ? error.message : String(error),code,state:state(),...boundary.status(error)};
      emit(response);
      try { appendFileSync(new URL('../runtime/gameplay.jsonl', import.meta.url), JSON.stringify({at:new Date().toISOString(),event:'error',request,...response})+'\n', {mode:0o600}); }
      catch(logError) { console.error('Could not record gameplay error'); break; }
      if (response.fatal) break;
    }
  }
} finally { account.close(); }
