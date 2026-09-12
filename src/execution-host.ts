import type {Account} from '@spacemolt/lib';
import {Execution,type ExecutionDeps} from './execution.ts';
import {ExecutionStore} from './execution-store.ts';
import {resolveHostContext} from './execution-policy.ts';
import {details} from './industry.ts';

/**
 * Player chat is reached ONLY through these bounded host operations; `policy.allowed`
 * deliberately still rejects spacemolt_social on the raw command path, so the guardrails
 * below cannot be bypassed by asking the bridge for the command directly.
 * One bounded message per call. Long-form belongs in notes, not in another player's chat.
 */
export const maxChatContent=500;
const chatTargets=['system','local','faction','private'];
const historyTargets=[...chatTargets,'emergency'];

/** Shared bridge routing, including the host-only operating-run reset. */
export class ExecutionHost {
  execution?:Execution;
  readonly account:Account;
  readonly directory:string;
  readonly deps:ExecutionDeps;
  constructor(account:Account,directory:string,deps:ExecutionDeps={}) {this.account=account;this.directory=directory;this.deps=deps;}
  async dispatch(action:string,params:Record<string,any>={}) {
    if(action==='execution/configure') {
      if(this.execution)throw new Error('Execution already configured');
      const context=resolveHostContext(params);
      const store=new ExecutionStore(this.directory,this.account.state.player!.id);
      if(params.new_run===true)await store.startNewRun(this.account);
      this.execution=new Execution(this.account,store,context,this.deps);
      return this.execution.handoff();
    }
    const execution=this.execution;
    if(!execution)throw new Error('Configure execution first');
    if(action.startsWith('job/'))return execution.dispatch(action.slice(4),params);
    const control:Record<string,(params:Record<string,any>)=>unknown>={
      'execution/reconcile':()=>execution.reconcile(),
      'execution/handoff':()=>execution.handoff(),
      'social/send':params=>this.send(params),
      'social/inbox':params=>this.inbox(params),
    };
    if(!control[action])throw new Error('Unsupported execution control');
    return control[action]!(params);
  }
  /**
   * A receipt records what was sent. A delivered message is never evidence that another
   * player read it, agreed to it, or will act on it.
   */
  private async send(params:Record<string,any>) {
    if(Object.keys(params).some(key=>!['content','target','target_id'].includes(key)))throw new Error('Chat takes only content, target and target_id');
    const content=typeof params.content==='string'?params.content.trim():'';
    if(!content)throw new Error('Chat content must be a nonempty message');
    if(content.length>maxChatContent)throw new Error(`Chat content exceeds ${maxChatContent} characters`);
    if(!chatTargets.includes(params.target))throw new Error('target must be system, local, faction or private');
    const target_id=typeof params.target_id==='string'?params.target_id.trim():undefined;
    if(params.target==='private'&&!target_id)throw new Error('Private chat requires the recipient target_id');
    const secret=Object.entries(process.env).find(([,value])=>typeof value==='string'&&value.length>=8&&content.includes(value));
    if(secret)throw new Error('Chat content repeats an environment value; messages never carry credentials or configuration');
    const request={content,target:params.target,...(target_id?{target_id}:{})};
    const sent_at=new Date().toISOString();
    const result=details(await this.account.send('spacemolt_social','chat',request));
    return {status:'sent',...request,sent_at,result};
  }
  private async inbox(params:Record<string,any>) {
    if(Object.keys(params).some(key=>!['target','limit'].includes(key)))throw new Error('Inbox takes only target and limit');
    if(!historyTargets.includes(params.target))throw new Error('target must be system, local, faction, private or emergency');
    const limit=params.limit??20;
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('limit must be an integer 1..100');
    const request={target:params.target,limit};
    const reply=details(await this.account.send('spacemolt_social','get_chat_history',request));
    const rows:any[]=Array.isArray(reply.messages)?reply.messages:Array.isArray(reply)?reply:[];
    return {target:params.target,observed_at:new Date().toISOString(),messages:rows.map(row=>({
      sender:row.sender??row.sender_name??row.from??row.player_id??null,
      target:row.target??row.channel??params.target,
      content:row.content??row.message??'',
      timestamp:row.timestamp??row.sent_at??row.created_at??null,
    }))};
  }
}
