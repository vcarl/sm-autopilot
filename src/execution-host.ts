import type {Account} from '@spacemolt/lib';
import {Execution,type ExecutionDeps} from './execution.ts';
import {ExecutionStore} from './execution-store.ts';
import {resolveHostContext} from './execution-policy.ts';

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
    const control:Record<string,()=>unknown>={
      'execution/reconcile':()=>execution.reconcile(),
      'execution/handoff':()=>execution.handoff(),
    };
    if(!control[action])throw new Error('Unsupported execution control');
    return control[action]();
  }
}
