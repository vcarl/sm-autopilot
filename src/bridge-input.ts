import type {Interface} from 'node:readline';
/** Control has no response frame and no game commands; normal requests remain serialized. */
export async function serveInput(input:Interface,dispatch:(line:string)=>Promise<void>,signal:(reason:string)=>void,afterStop?:()=>Promise<void>) {
  let pending=Promise.resolve();
  for await(const line of input) {
    let request;
    try {request=JSON.parse(line);}catch { /* The normal dispatcher reports malformed requests. */ }
    if(request?.action==='control/stop') {signal(String(request.params?.reason??'Tired'));if(afterStop)pending=pending.then(afterStop);continue;}
    pending=pending.then(()=>dispatch(line));
  }
  await pending;
}
