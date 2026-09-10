import type {Interface} from 'node:readline';
/** The bridge owns one lane for requests, cleanup, and unsolicited defense. */
export class BridgeQueue {
  private pending=Promise.resolve();
  private errors:unknown[]=[];
  enqueue(task:()=>Promise<unknown>) {
    this.pending=this.pending.then(task).then(()=>undefined,error=>{this.errors.push(error);});
  }
  async drain() {
    let pending;
    do {pending=this.pending;await pending;}while(pending!==this.pending);
    if(this.errors.length)throw new AggregateError(this.errors.splice(0),'Bridge work failed');
  }
}
/** Control has no response frame and no game commands; normal requests remain serialized. */
export async function serveInput(input:Interface,dispatch:(line:string)=>Promise<void>,signal:(reason:string)=>void,afterStop?:()=>Promise<void>,sharedQueue?:BridgeQueue) {
  const queue=sharedQueue??new BridgeQueue();
  for await(const line of input) {
    let request;
    try {request=JSON.parse(line);}catch { /* The normal dispatcher reports malformed requests. */ }
    if(request?.action==='control/stop') {signal(String(request.params?.reason??'Tired'));if(afterStop)queue.enqueue(afterStop);continue;}
    queue.enqueue(()=>dispatch(line));
  }
  // An external owner unsubscribes event producers before draining its shared lane.
  if(!sharedQueue)await queue.drain();
}
