import {PolicyDenied} from './rules.ts';
import {controllerLock} from './controller-lock.ts';
import {createHash} from 'node:crypto';
import {Execution} from './execution.ts';
import {ExecutionHost} from './execution-host.ts';
import {BridgeQueue,serveInput} from './bridge-input.ts';
import {watchDefense} from './defense-events.ts';
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

const credentialPath = process.env.SPACEMOLT_CREDENTIALS_FILE;
if (!credentialPath) throw new Error('SPACEMOLT_CREDENTIALS_FILE must name a credentials file');
const credentialsText = readFileSync(credentialPath, 'utf8');
const password = credentialsText.match(/^Password: (.+)$/m)?.[1]?.trim();
const username = credentialsText.match(/^Username: (.+)$/m)?.[1]?.trim();
if (!password || !username) throw new Error('Missing Username or Password field in credentials file');
const credentials = () => ({kind: 'login' as const, username, password});
const account = new Account({url:'wss://game.spacemolt.com/ws/v2', reconnect:true, credentials});
const runtimeDirectory=process.env.SPACEMOLT_RUNTIME_DIR??fileURLToPath(new URL('../runtime/', import.meta.url));
mkdirSync(runtimeDirectory, {recursive:true});
const runtimePath=(name:string)=>runtimeDirectory+'/'+name;
const state = () => ({credits:account.credits, ship:account.ship, cargo:account.cargo,
  modules:account.state.modules, skills:account.state.skills,
  location:account.location && {system_id:account.location.system_id, poi_id:account.location.poi_id,
    docked_at:account.location.docked_at, connections:account.location.connections,
    resources:account.location.resources, security_status:account.location.security_status,
    in_transit:account.location.in_transit, transit_dest_system_id:account.location.transit_dest_system_id,
    transit_dest_poi_id:account.location.transit_dest_poi_id, transit_arrival_tick:account.location.transit_arrival_tick}, missions:account.state.missions});
const emit = (data: unknown) => console.log(JSON.stringify(data));
const unlock=controllerLock(runtimePath('controller-'+createHash('sha256').update(username).digest('hex').slice(0,16)+'.lock'));
try {
await account.connect();
await account.authenticate(credentials());
let execution:Execution|undefined;
const executionHost=new ExecutionHost(account,runtimePath('pilots/'));
let fatal=false;
emit({event:'ready', state:state()});
const input = createInterface({input:process.stdin, terminal:false});
const queue=new BridgeQueue();
let stopDefense:(()=>void)|undefined;
let closing=false;
try {
  await serveInput(input,async(line)=>{
    if(fatal)return;
    let request: {id?:string; action:string; params?:Record<string,unknown>} | undefined;
    const boundary = new CommandBoundary();
    try {
      request = JSON.parse(line);
      if (!request) throw new Error('Missing request');
      let result:unknown;
      if(request.action.startsWith('execution/')||request.action.startsWith('job/')) {
        result=await executionHost.dispatch(request.action,request.params);
        execution=executionHost.execution;
        if(request.action==='execution/configure'&&!closing)stopDefense=watchDefense(account,execution!,queue,error=>{
          appendFileSync(runtimePath('gameplay.jsonl'),JSON.stringify({at:new Date().toISOString(),event:'defense_blocked',error:String(error)})+'\n',{mode:0o600});
        });
      }
      else if (request.action === 'state') { await account.refresh(); result = state(); }
      else if(execution)throw new Error('Legacy commands unavailable in execution sessions');
      else if (request.action === 'catalog') result = {...catalog(),...industryCatalog,...combatCatalog};
      else if (request.action in industryCatalog || request.action in combatCatalog) {
        let step = 0;
        const command = (action:string,params?:Record<string,unknown>) => boundary.run(async (markSent,markCompleted) => {
          validateAction(action,params);
          const subrequest = {id:`${request!.id}/${++step}`,action,params};
          appendFileSync(runtimePath('gameplay.jsonl'), JSON.stringify({at:new Date().toISOString(),event:'requested',request:subrequest})+'\n',{mode:0o600});
          markSent();
          const value = await sendAndRefresh(account,action,params,markCompleted);
          appendFileSync(runtimePath('gameplay.jsonl'), JSON.stringify({at:new Date().toISOString(),request:subrequest,ok:true,result:value,state:state()})+'\n',{mode:0o600});
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
        appendFileSync(runtimePath('gameplay.jsonl'), JSON.stringify({at:new Date().toISOString(),event:'requested',request})+'\n', {mode:0o600});
        result = await boundary.run(async (markSent,markCompleted) => {
          markSent();
          return sendAndRefresh(account, request!.action, request!.params, markCompleted);
        });
      }
      const response = {id:request.id, ok:true, result, state:state()};
      appendFileSync(runtimePath('gameplay.jsonl'), JSON.stringify({at:new Date().toISOString(),request,...response})+'\n', {mode:0o600});
      emit(response);
    } catch(error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
      const response = {id:request?.id,ok:false,error:error instanceof Error ? error.message : String(error),code,state:state(),...(error instanceof PolicyDenied?{policy_decision:error.decision}:{}),...boundary.status(error)};
      emit(response);
      try { appendFileSync(runtimePath('gameplay.jsonl'), JSON.stringify({at:new Date().toISOString(),event:'error',request,...response})+'\n', {mode:0o600}); }
      catch(logError) { console.error('Could not record gameplay error'); fatal=true;input.close(); }
      if (response.fatal) {fatal=true;input.close();}
    }
  },reason=>execution?.signal(reason),async()=>{
    if(execution) {
      try {await execution.dispatch('return_to_base');}
      catch(error) {appendFileSync(runtimePath('gameplay.jsonl'),JSON.stringify({event:'control_return_blocked',error:String(error)})+'\n',{mode:0o600});}
    }
  },queue);
} finally { closing=true;stopDefense?.();await queue.drain();account.close(); }
} finally {account.close();unlock();}
