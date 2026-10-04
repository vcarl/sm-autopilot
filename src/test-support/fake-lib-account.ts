import type {GameState} from '@spacemolt/lib';

export interface RecordedCall {
  tool:string;
  action:string;
  payload:Record<string,unknown>|undefined;
}
export type FakeCommandHandler=(payload?:Record<string,unknown>)=>unknown|Promise<unknown>;
export type FakeCommandHandlers=Record<string,Record<string,FakeCommandHandler>>;

/** Adapted from setpoint (removed from this repo; see git history), tests/dispatcher/lib-fakes.ts.
 * Only the consumed account surface is ported. Scenarios own server changes and
 * cache pushes; sending a command never implies an authoritative refresh.
 */
export class FakeLibGoalAccount<S extends object> {
  readonly server:S;
  state:GameState;
  readonly calls:RecordedCall[]=[];
  readonly refreshes:number[]=[];
  private readonly handlers:FakeCommandHandlers;
  private readonly now:()=>number;

  constructor(initial:S,handlers:FakeCommandHandlers={},now:()=>number=Date.now) {
    this.server=structuredClone(initial);
    // Sparse fixtures deliberately supply only the state consumed by their path.
    this.state=structuredClone(initial) as GameState;
    this.handlers=handlers;
    this.now=now;
  }

  async send(tool:string,action:string,payload?:Record<string,unknown>):Promise<unknown> {
    this.calls.push({tool,action,payload:structuredClone(payload)});
    const group=Object.hasOwn(this.handlers,tool)?this.handlers[tool]:undefined;
    const handler=group&&Object.hasOwn(group,action)?group[action]:undefined;
    if(!handler)throw new Error(`Unregistered command: ${tool}/${action}`);
    return handler(payload);
  }

  private readonly listeners=new Map<string,((payload:Record<string,unknown>)=>void)[]>();
  /** The lib's push subscription: a handler per frame type. */
  on(type:string,handler:(payload:Record<string,unknown>)=>void):()=>void {
    const list=this.listeners.get(type)??[];
    this.listeners.set(type,[...list,handler]);
    return ()=>{this.listeners.set(type,(this.listeners.get(type)??[]).filter(fn=>fn!==handler));};
  }
  /** A frame from the server, as the socket would deliver it. */
  push(type:string,payload:unknown):void {
    for(const fn of this.listeners.get(type)??[])fn(payload as Record<string,unknown>);
  }

  async refresh():Promise<GameState> {
    this.refreshes.push(this.now());
    this.state=structuredClone(this.server) as GameState;
    return this.state;
  }
}
