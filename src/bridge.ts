import {controllerLock} from './controller-lock.ts';
import {createHash} from 'node:crypto';
import {Execution} from './execution.ts';
import {ExecutionStore} from './execution-store.ts';
import {resolveContext} from './execution-policy.ts';
import {serveInput} from './bridge-input.ts';
import {fileURLToPath} from 'node:url';
import { validateAction, catalog } from './policy.ts';
import { Account } from '@spacemolt/lib';
import { sendAndRefresh } from './execute.ts';
import { CommandBoundary } from './command-boundary.ts';
import { industry } from './industry.ts';
import { industryCatalog } from './industry-metadata.ts';
import { combat } from './combat.ts';
import { combatCatalog } from './combat-metadata.ts';
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
const unlock=controllerLock(fileURLToPath(new URL('../runtime/controller-'+createHash('sha256').update(username).digest('hex').slice(0,16)+'.lock',import.meta.url)));
try {
await account.connect();
await account.authenticate(credentials());
let execution:Execution|undefined;
let fatal=false;
emit({event:'ready', state:state()});
const input = createInterface({input:process.stdin, terminal:false});
try {
  await serveInput(input,async(line)=>{
    if(fatal)return;
    let request: {id?:string; action:string; params?:Record<string,unknown>} | undefined;
    const boundary = new CommandBoundary();
    try {
      request = JSON.parse(line);
      if (!request) throw new Error('Missing request');
      let result:unknown;
      if(request.action==='execution/configure') {
        if(execution)throw new Error('Execution already configured');
        const context=resolveContext(request.params??{});
        context.permissions={wildlife:request.params?.wildlife===true};
        context.authority={stance:request.params?.lock_stance===true?context.stance:undefined,mood:request.params?.lock_mood===true?context.mood:undefined};
        const store=new ExecutionStore(fileURLToPath(new URL('../runtime/pilots/',import.meta.url)),account.state.player!.id);
        if(request.params?.new_run===true&&store.data.stop) {
          await account.refresh();
          const ship=account.ship;
          if(store.unresolved()||!account.location?.docked_at||account.location.in_transit||!ship||ship.hull!==ship.max_hull||ship.fuel!==ship.max_fuel||ship.shield!==ship.max_shield)throw new Error('Cannot clear stop before reconciled, docked and fully serviced state');
          delete store.data.stop;store.save();
        }
        execution=new Execution(account,store,context);
        result=execution.handoff();
      }
      else if(request.action==='execution/handoff') {if(!execution)throw new Error('Configure execution first');result=execution.handoff();}
      else if(request.action.startsWith('job/')) {if(!execution)throw new Error('Configure execution first');result=await execution.dispatch(request.action.slice(4),request.params??{});}
      else if (request.action === 'state') { await account.refresh(); result = state(); }
      else if(execution)throw new Error('Legacy commands unavailable in execution sessions');
      else if (request.action === 'catalog') result = {...catalog(),...industryCatalog,...combatCatalog};
      else if (request.action in industryCatalog || request.action in combatCatalog) {
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
        result = request.action in combatCatalog
          ? await combat(request.action.split('/')[1]!,request.params??{},account,command)
          : request.action === 'industry/mine'
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
      catch(logError) { console.error('Could not record gameplay error'); fatal=true;input.close(); }
      if (response.fatal) {fatal=true;input.close();}
    }
  },reason=>execution?.signal(reason),async()=>{
    if(execution) {
      try {await execution.dispatch('return_to_base');}
      catch(error) {appendFileSync(new URL('../runtime/gameplay.jsonl',import.meta.url),JSON.stringify({event:'control_return_blocked',error:String(error)})+'\n',{mode:0o600});}
    }
  });
} finally { account.close(); }
} finally {account.close();unlock();}
