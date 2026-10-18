/** `runtime/frames.jsonl`: every frame the game sends us and every frame we send it, one JSON line
 * each, for offline replay. Not read by the pilot or the runtime. Rotated at boot with the journal
 * (`bootJournal`).
 *
 * ponytail: rotation only at boot, no size roll, so a bridge that stays up for days grows one file.
 * Add a size check in `enqueue` (rotate when the file passes a few hundred MB) if that happens. */
import type {AccountOptions,InboundFrame,RawFrame} from '@spacemolt/lib';
import {appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {isRecord,journalRun} from './run-record.ts';

// The lib redacts auth frames itself (password, token, registration_code, device_code) before the
// hooks fire; this is the second wall, over the whole frame (login/register put `session_id` in
// structuredContent, an error can echo a secret in `details`).
const SECRET=new Set(['password','token','registration_code','device_code','user_code','verification_uri_complete',
  'session_id','session_key','session_token']);
const REDACTED='[redacted]';
/** Lines taken but not yet on disk, per file. A hung disk drops frames past this rather than grow the heap. */
export const FRAMES_QUEUE_BYTES=32*1024*1024;

/** `value` with every secret key's value hidden (and, when `text`, every collected secret hidden inside
 * strings too). Copy on write: an untouched branch is returned as is, and the input is never mutated. */
function redact(value:unknown,secrets:Set<string>,text:boolean):unknown {
  if(typeof value==='string'){
    if(!text)return value;
    let out=value;
    for(const secret of secrets)if(out.includes(secret))out=out.split(secret).join(REDACTED);
    return out;
  }
  if(Array.isArray(value)){
    let out:unknown[]|undefined;
    value.forEach((item,i)=>{const next=redact(item,secrets,text);if(next!==item){out??=[...value];out[i]=next;}});
    return out??value;
  }
  if(!isRecord(value))return value;
  let out:Record<string,unknown>|undefined;
  for(const [key,item] of Object.entries(value)){
    let next:unknown;
    if(SECRET.has(key)){
      // A short value would shred ordinary text when hunted for in strings.
      if(!text&&typeof item==='string'&&item.length>=4&&item!==REDACTED)secrets.add(item);
      next=REDACTED;
    } else next=redact(item,secrets,text);
    if(next!==item){out??={...value};out[key]=next;}
  }
  return out??value;
}

export function scrubFrame(frame:unknown):unknown {
  const secrets=new Set<string>();
  const keyed=redact(frame,secrets,false);
  return secrets.size?redact(keyed,secrets,true):keyed;
}

interface Queue {lines:string[];bytes:number;dropped:number;tail:Promise<void>;scheduled:boolean;failed:boolean}
const queues=new Map<string,Queue>();

/** Lines are buffered and appended off the socket's path, one append at a time, so the file keeps
 * the order they were taken in. A failed append loses that batch and is journalled once per outage
 * (`frames_failed`, reset by the next append that lands); later batches are tried. Past `cap` unwritten
 * bytes a line is dropped and counted, and the first append to land afterwards journals `frames_dropped`. */
function enqueue(runtime:string,line:string,cap:number):void {
  const path=join(runtime,'frames.jsonl');
  const queue=queues.get(path)??{lines:[],bytes:0,dropped:0,tail:Promise.resolve(),scheduled:false,failed:false};
  queues.set(path,queue);
  if(queue.bytes+line.length>cap){queue.dropped++;return;} // chars stand for bytes: frames are nearly all ASCII
  queue.lines.push(line);
  queue.bytes+=line.length;
  if(queue.scheduled)return;
  queue.scheduled=true;
  setImmediate(()=>{
    queue.scheduled=false;
    const text=queue.lines.join('');
    queue.lines=[];
    const note=(event:string,entry:Record<string,unknown>)=>{
      try {journalRun(runtime,entry,event);}
      catch {/* the journal is as unwritable as the frames; nothing is left to tell */} // edge: logging must never reach the socket
    };
    queue.tail=queue.tail.then(()=>appendFile(path,text,{mode:0o600})).then(()=>{
      queue.failed=false;
      if(queue.dropped){note('frames_dropped',{count:queue.dropped});queue.dropped=0;}
    },(error:unknown)=>{
      if(!queue.failed)note('frames_failed',{error:error instanceof Error?error.message:String(error)});
      queue.failed=true;
    }).then(()=>{queue.bytes-=text.length;});
  });
}

/** Everything taken so far has reached the file (or failed trying). */
export async function flushFrames():Promise<void> {
  await new Promise(resolve=>setImmediate(resolve));
  await Promise.all([...queues.values()].map(queue=>queue.tail));
}

/** The `onSend`/`onReceive` options of an `Account`; `freighter` tags a freighter's frames. `cap` is for tests. */
export function frameTap(runtime:string,freighter?:string,cap=FRAMES_QUEUE_BYTES):Required<Pick<AccountOptions,'onSend'|'onReceive'>> {
  const tap=(dir:'in'|'out')=>(frame:InboundFrame|RawFrame)=>{
    try {enqueue(runtime,`${JSON.stringify({at:new Date().toISOString(),dir,frame:scrubFrame(frame),...freighter===undefined?{}:{freighter}})}\n`,cap);}
    catch {/* an unserialisable frame is not worth the socket */} // edge: logging must never reach the socket
  };
  return {onSend:tap('out'),onReceive:tap('in')};
}
