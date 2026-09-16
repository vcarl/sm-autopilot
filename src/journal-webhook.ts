/** The pilot's journal, rendered, posted to a Discord webhook in bursts.
 *
 * A shift is hours of work and the operator is not watching a terminal. Rather than a
 * message per event (rate limits, noise) or a digest at rest (too late to be interesting),
 * lines buffer and drain on a random interval that shortens as the buffer fills: a quiet
 * pilot posts every few minutes, a busy one keeps up.
 *
 * Nothing here is the record. A post that fails keeps its lines and tries again; a drain
 * that never runs costs the pilot nothing, because `gameplay.jsonl` is already written.
 */
import {renderLine} from './journal-lines.ts';
import {watchJournal} from './run-record.ts';

/** ponytail: three numbers, not a config system. Discord takes 2000 characters a message
 * and the drain leaves room for the newline joins; three to eight minutes is "a burst, not
 * a stream". Lift them into config.yaml the day an operator wants a different cadence. */
export const BUDGET=1900;
export const MIN_MS=3*60_000;
export const MAX_MS=8*60_000;

export interface PostResult {ok:boolean;retryAfterMs?:number}
export interface DrainDeps {
  /** How a message is sent. Injected by the tests, which post nothing. */
  post?:(content:string)=>Promise<PostResult>;
  rng?:()=>number;
  schedule?:(fn:()=>void,ms:number)=>{unref?:()=>void};
}

export interface Drain {
  push(line:string):void;
  /** One drain now, whatever the timer was going to do. */
  flush():Promise<void>;
  stop():void;
  /** For the tests: what is still waiting, and when the next drain was scheduled for. */
  buffered():string[];
  nextDelay():number;
}

/** How long until the next drain: a random point in [MIN, MAX], pulled towards MIN as the
 * buffer grows, and MIN outright once the buffer is more than one message can carry.
 *
 * Pure so it can be tested without a clock: the caller passes the roll. */
export function nextDelayMs(bufferedChars:number,rng:number):number {
  if(bufferedChars>=BUDGET)return MIN_MS;
  const pressure=Math.max(0.05,1-bufferedChars/BUDGET);
  return Math.round(MIN_MS+(MAX_MS-MIN_MS)*Math.min(Math.max(rng,0),1)*pressure);
}

/** As many whole lines as the budget carries, newest left behind rather than cut in half. */
function take(buffer:string[]):string[] {
  const out:string[]=[];
  let size=0;
  for(const line of buffer) {
    const next=size+line.length+(out.length?1:0);
    if(out.length&&next>BUDGET)break;
    out.push(line);
    size=next;
  }
  return out;
}

const discordPost=(url:string)=>async (content:string):Promise<PostResult>=>{
  const reply=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({content,allowed_mentions:{parse:[]}})});
  if(reply.status===429) {
    // Discord answers the wait in seconds; anything unreadable is a second.
    const body=await reply.json().catch(()=>({})) as {retry_after?:unknown};
    const seconds=Number(body?.retry_after);
    return {ok:false,retryAfterMs:Math.max(1_000,Math.round((Number.isFinite(seconds)?seconds:1)*1000))};
  }
  return {ok:reply.ok};
};

export function journalDrain(url:string,deps:DrainDeps={}):Drain {
  const post=deps.post??discordPost(url);
  const rng=deps.rng??Math.random;
  const schedule=deps.schedule??((fn,ms)=>setTimeout(fn,ms));
  const buffer:string[]=[];
  let delay=0,stopped=false,inFlight:Promise<void>|null=null;

  const arm=(ms:number)=>{
    if(stopped)return;
    delay=ms;
    // Unref'd: the drain is never a reason for the bridge process to stay alive.
    schedule(()=>{void flush();},ms).unref?.();
  };
  const flush=async():Promise<void>=>{
    if(inFlight)return inFlight;
    inFlight=(async()=>{
      const sending=take(buffer);
      let wait:number|undefined;
      if(sending.length) {
        let result:PostResult;
        // A webhook that is down, slow or gone keeps its lines: the next drain carries them.
        try {result=await post(sending.join('\n'));} catch {result={ok:false};}
        if(result.ok)buffer.splice(0,sending.length);
        else wait=result.retryAfterMs;
      }
      const chars=buffer.reduce((sum,line)=>sum+line.length+1,0);
      arm(wait??nextDelayMs(chars,rng()));
    })();
    try {await inFlight;} finally {inFlight=null;}
  };

  arm(nextDelayMs(0,rng()));
  return {
    push:line=>{if(!stopped)buffer.push(line);},
    flush,
    stop:()=>{stopped=true;},
    buffered:()=>[...buffer],
    nextDelay:()=>delay,
  };
}

/** The bridge's one drain, if the operator set a webhook. Absent, nothing happens: no
 * listener, no timer, no post. */
let active:Drain|null=null;
export function startJournalDrain(deps:DrainDeps={}):Drain|null {
  const url=process.env.SPACEMOLT_JOURNAL_WEBHOOK;
  if(!url||active)return active;
  active=journalDrain(url,deps);
  watchJournal(entry=>{
    const line=renderLine(entry);
    if(line)active?.push(line);
  });
  return active;
}

/** The shutdown path's one drain. Bounded by the caller's own grace timer, not by a race. */
export const flushJournalDrain=():Promise<void>=>active?active.flush():Promise.resolve();

/** For the tests, which must never leave a listener or a timer behind them. */
export function stopJournalDrain():void {
  active?.stop();
  active=null;
  watchJournal(null);
}
