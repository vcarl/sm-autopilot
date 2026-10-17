/** `runtime/frames.jsonl`: every frame the game sends us and every frame we send it, one JSON line
 * each, for offline replay. Not read by the pilot or the runtime. Rotated at boot with the journal
 * (`bootJournal`). */
import {appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {isRecord,journalRun} from './run-record.ts';

// The lib redacts auth frames itself (password, token, registration_code, device_code) before the
// hooks fire; this is the second wall, shallow on purpose (the payload and its structuredContent, where
// login/register put `session_id`), so it costs nothing on the frames that carry state.
const SECRET=new Set(['password','token','registration_code','device_code','session_id','session_key','session_token']);
const REDACTED='[redacted]';

function scrubRecord(record:Record<string,unknown>,secrets:string[]):Record<string,unknown> {
  let out:Record<string,unknown>|undefined;
  for(const key of Object.keys(record))
    if(SECRET.has(key)&&record[key]!==REDACTED){
      out??={...record};
      if(typeof record[key]==='string'&&record[key])secrets.push(record[key]);
      out[key]=REDACTED;
    }
  return out??record;
}

export function scrubFrame(frame:unknown):unknown {
  if(!isRecord(frame)||!isRecord(frame.payload))return frame;
  const secrets:string[]=[];
  let payload=scrubRecord(frame.payload,secrets);
  const inner=payload.structuredContent;
  if(isRecord(inner)){const scrubbed=scrubRecord(inner,secrets);if(scrubbed!==inner)payload={...payload,structuredContent:scrubbed};}
  // The rendered text of a login reply can repeat the value it just hid.
  if(secrets.length&&typeof payload.result==='string'){
    let text=payload.result;
    for(const secret of secrets)text=text.split(secret).join(REDACTED);
    payload={...payload,result:text};
  }
  return payload===frame.payload?frame:{...frame,payload};
}

const queues=new Map<string,{lines:string[];tail:Promise<void>;scheduled:boolean;failed:boolean}>();

/** Lines are buffered and appended off the socket's path, one append at a time, so the file keeps
 * the order they were taken in. A failed append is journalled once per process (`frames_failed`);
 * the next flush tries again. */
function enqueue(runtime:string,line:string):void {
  const path=join(runtime,'frames.jsonl');
  const queue=queues.get(path)??{lines:[],tail:Promise.resolve(),scheduled:false,failed:false};
  queues.set(path,queue);
  queue.lines.push(line);
  if(queue.scheduled)return;
  queue.scheduled=true;
  setImmediate(()=>{
    queue.scheduled=false;
    const text=queue.lines.join('');
    queue.lines=[];
    queue.tail=queue.tail.then(()=>appendFile(path,text,{mode:0o600})).catch((error:unknown)=>{
      if(queue.failed)return;
      queue.failed=true;
      try {journalRun(runtime,{error:error instanceof Error?error.message:String(error)},'frames_failed');}
      catch {/* the journal is as unwritable as the frames; nothing is left to tell */} // edge: logging must never reach the socket
    });
  });
}

/** Everything taken so far has reached the file (or failed trying). */
export async function flushFrames():Promise<void> {
  await new Promise(resolve=>setImmediate(resolve));
  await Promise.all([...queues.values()].map(queue=>queue.tail));
}

/** The `onSend`/`onReceive` options of an `Account`; `freighter` tags a freighter's frames. */
export function frameTap(runtime:string,freighter?:string):{onSend:(frame:unknown)=>void;onReceive:(frame:unknown)=>void} {
  const tap=(dir:'in'|'out')=>(frame:unknown)=>{
    try {enqueue(runtime,`${JSON.stringify({at:new Date().toISOString(),dir,frame:scrubFrame(frame),...freighter===undefined?{}:{freighter}})}\n`);}
    catch {/* an unserialisable frame is not worth the socket */} // edge: logging must never reach the socket
  };
  return {onSend:tap('out'),onReceive:tap('in')};
}
