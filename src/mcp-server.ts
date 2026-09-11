/**
 * A single-owner MCP boundary for the SpaceMolt execution host.
 *
 * Hermes starts one instance of this process for a profile. The process owns
 * one bridge (and therefore one controller lock); Discord sessions and cron
 * sessions only submit serialized high-level execution requests through it.
 * Credentials stay in the bridge environment and are never part of tool input.
 */
import {spawn,type ChildProcess} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

type Json=Record<string,any>;
type Tool={name:string;description:string;inputSchema:Json};

const HERE=dirname(fileURLToPath(import.meta.url));
const TOOLS:Tool[]=[
  {name:'spacemolt_observe',description:'Observe the authoritative SpaceMolt state and outstanding obligations.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'spacemolt_plan',description:'Set the host-approved SpaceMolt stance, mood, objective and observed home; requires a handoff.',inputSchema:{type:'object',properties:{stance:{type:'string'},mood:{type:'string'},objective:{type:'string'},home_base_id:{type:'string'},home_rationale:{type:'string'}},additionalProperties:false}},
  {name:'spacemolt_assess',description:'Assess current SpaceMolt logistics opportunities or fitting.',inputSchema:{type:'object',properties:{kind:{type:'string'},shipment_id:{type:'string'},destination:{type:'string'}},additionalProperties:false}},
  {name:'spacemolt_prepare',description:'Run verified servicing or passenger-cabin preparation.',inputSchema:{type:'object',properties:{kind:{type:'string'}},additionalProperties:false}},
  {name:'spacemolt_transport',description:'Execute or resume one verified freight or passenger transport job.',inputSchema:{type:'object',properties:{kind:{type:'string'},shipment_id:{type:'string'},destination:{type:'string'},resume_job_id:{type:'string'}},additionalProperties:false}},
  {name:'spacemolt_return',description:'Stop productive work and return to the remembered home or documented fallback.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'spacemolt_reconcile',description:'Reconcile an unfinished SpaceMolt job without replaying uncertain mutations.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'spacemolt_stop',description:'Signal Tired to the active SpaceMolt scripts and let them perform owned cleanup.',inputSchema:{type:'object',properties:{reason:{type:'string'}},additionalProperties:false}},
];

class Bridge {
  private readonly child:ChildProcess;
  private readonly pending=new Map<number,{resolve:(value:Json)=>void;reject:(error:Error)=>void}>();
  private nextId=0;
  private readonly ready:Promise<void>;
  constructor() {
    this.child=spawn(process.env.SPACEMOLT_NODE??'node',[join(HERE,'bridge.ts')],{stdio:['pipe','pipe','inherit'],env:process.env});
    const input=createInterface({input:this.child.stdout});
    let readyResolve!:()=>void,readyReject!:(error:Error)=>void;
    this.ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
    input.on('line',line=>{
      let message:Json;
      try {message=JSON.parse(line);} catch {return;}
      if(message.event==='ready'){readyResolve();return;}
      const id=Number(message.id),waiter=this.pending.get(id);
      if(!waiter)return;
      this.pending.delete(id);
      if(message.ok===false)waiter.reject(new Error(message.error??'SpaceMolt bridge request failed'));
      else waiter.resolve(message);
    });
    const failed=(error:Error)=>{readyReject(error);for(const waiter of this.pending.values())waiter.reject(error);this.pending.clear();};
    this.child.once('error',failed);this.child.once('exit',code=>{if(code!==0)failed(new Error(`SpaceMolt bridge exited with code ${code??'unknown'}`));});
  }
  async request(action:string,params:Json={}):Promise<Json> {
    await this.ready;
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.child.stdin.write(JSON.stringify({id,action,params})+'\n');});
  }
  stop(reason:string) {
    this.child.stdin.write(JSON.stringify({action:'control/stop',params:{reason}})+'\n');
  }
  close() {this.child.stdin.end();}
}

const bridge=new Bridge();
let configured=false;
async function ensureConfigured() {
  if(configured)return;
  await bridge.request('execution/configure',{stance:process.env.SPACEMOLT_STANCE??'Logistics',mood:process.env.SPACEMOLT_MOOD??'Focused',objective:process.env.SPACEMOLT_OBJECTIVE??'Respond to the next verified SpaceMolt objective',wildlife:false,lock_stance:false,lock_mood:false});
  configured=true;
}
async function dispatch(name:string,args:Json) {
  if(name==='spacemolt_stop'){bridge.stop(String(args.reason??'Tired'));return {status:'stop_requested',reason:String(args.reason??'Tired')};}
  await ensureConfigured();
  if(name==='spacemolt_plan') {
    const observed=await bridge.request('job/observe');
    const planned=await bridge.request('job/plan',args);
    const handed=await bridge.request('execution/handoff');
    return {observed:observed.result,plan:planned.result,handoff:handed.result};
  }
  const actions:Record<string,string>={spacemolt_observe:'job/observe',spacemolt_assess:'job/assess',spacemolt_prepare:'job/prepare',spacemolt_transport:'job/transport',spacemolt_return:'job/return_to_base',spacemolt_reconcile:'execution/reconcile'};
  const action=actions[name];if(!action)throw new Error(`Unknown SpaceMolt MCP tool ${name}`);
  return (await bridge.request(action,args)).result;
}

async function reply(id:unknown,result:Json|unknown,error?:Error) {
  const response:Json={jsonrpc:'2.0',id};
  if(error)response.error={code:-32000,message:error.message};
  else response.result=result;
  process.stdout.write(JSON.stringify(response)+'\n');
}
const input=createInterface({input:process.stdin});
input.on('line',line=>{void (async()=>{
  let message:Json;try{message=JSON.parse(line);}catch{return;}
  if(message.method==='notifications/initialized')return;
  if(message.method==='initialize')return reply(message.id,{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'hermes-spacemolt',version:'0.1.0'}});
  if(message.method==='tools/list')return reply(message.id,{tools:TOOLS});
  if(message.method==='tools/call') {
    try {const result=await dispatch(String(message.params?.name??''),message.params?.arguments??{});return reply(message.id,{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result});}
    catch(error){return reply(message.id,{content:[{type:'text',text:String(error)}]},error instanceof Error?error:new Error(String(error)));}
  }
  if(message.id!==undefined)return reply(message.id,undefined,new Error(`Unsupported MCP method ${String(message.method)}`));
})();});
const shutdown=()=>{bridge.close();};
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
