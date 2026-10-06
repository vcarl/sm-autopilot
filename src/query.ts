/** One query: `query/index.ts` under the runtime dir, checked as a run's program is (tsc, the import
 * boundary, the policy), then run on a binding of its own (`querying`) whose every command must be a
 * query in the lib's `ACTIONS` (or a craft's dry run); login and its kin are refused as well. A refused command is never sent.
 *
 * Not a run: no run.json, no `run` lines, no instruction consumed, nothing for the gate. Its record is
 * one `query` line, and every line written in it carries its `query_id`. It runs beside the run, flying
 * or paused on `ask()`: the lib orders an account's mutations itself, and a read interleaves with them.
 * Capped at `QUERY_CAP_MS`: stopped there and answered; its binding is closed, so code it left running
 * can send nothing more. */
import {ACTIONS,SpacemoltError} from '@spacemolt/lib';
import {randomUUID} from 'node:crypto';
import {statSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import type {ReadinessCommand} from './readiness.ts';
import {journalRun,withStamp} from './run-record.ts';
import {check,keepProgram} from './run.ts';
import {progress,querying,runCalls,stop,type Binding} from './play/runtime.ts';

export const QUERY_CAP_MS=90_000;
/** ponytail: the last 100 streamed lines and 8000 characters of what `main` returned reach the pilot;
 * raise them if a query's answer is ever cut where it mattered. */
const LINES=100,RETURNED_CHARS=8000;
// The lib calls self_destruct a query; it is the one that does real damage, and a chat window holds this tool too.
const SESSION=new Set([...['login','login_link','login_link_poll','login_token','logout','register'].map(name=>`spacemolt_auth/${name}`),'spacemolt_battle/self_destruct']);

/** Why a query may not send `action`, or null: every action the lib calls a query, but the session's own, and a craft's
 * dry run, which moves nothing. Live 2026-10-06 (kvothe, query b86b3973): every `recipes()` quote was refused here, so
 * each row came back unpriced. */
export const notAQuery=(action:string,params?:Record<string,unknown>):string|null=>SESSION.has(action)?`${action} is not available in a query`
  :ACTIONS[action]?.kind==='query'||(action==='spacemolt/craft'&&params?.dry_run===true)?null:`${action} is not a read; a query only reads`;

export interface QueryDeps extends Omit<Binding,'runtime'|'emit'|'query'> {
  runtime:string;
  capMs?:number;
  juncture?:{readonly juncture_id?:string|null};
}

const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const clip=(text:string,n:number)=>text.length>n?`${text.slice(0,n-1)}…`:text;
/** What `main` returned, as the pilot reads it: a string is its own text, anything else JSON. */
const shown=(value:unknown):string=>{
  if(typeof value==='string')return value;
  try {return JSON.stringify(value)??String(value);}
  catch(error){return `${String(value)} (not JSON: ${message(error)})`;} // edge: a cycle or a bigint is the pilot's to return
};

export function runQuery(deps:QueryDeps):Promise<Record<string,unknown>> {
  const query_id=randomUUID(),since=Date.now(),juncture_id=deps.juncture?.juncture_id??null;
  return withStamp({query_id},async()=>{
    const gate=await check(deps.runtime,{name:'query'});
    keepProgram(deps.runtime,gate.entry,gate.sha);
    if(!gate.ok) {
      journalRun(deps.runtime,{query_id,juncture_id,sha:gate.sha,ok:false,ms:Date.now()-since,errors:gate.errors.slice(0,5)},'query');
      return {ok:false,query_id,sha:gate.sha,reason:'query/index.ts is not admissible',errors:gate.errors};
    }
    const lines:string[]=[],refused:string[]=[];
    const command:ReadinessCommand=(action,params)=>{
      const why=notAQuery(action,params);
      if(!why)return deps.command(action,params);
      refused.push(action);
      return Promise.reject(new SpacemoltError('not_a_query',why));
    };
    return querying({...deps,command,emit:text=>{lines.push(text);}},async()=>{
      let capped=false,timer:ReturnType<typeof setTimeout>|undefined,crashed=(_error:unknown)=>{};
      const cap=deps.capMs??QUERY_CAP_MS;
      const cutOff=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{capped=true;stop();reject(new Error(`stopped at the query's cap of ${cap/1000}s`));},cap);});
      // A promise the program left unawaited would otherwise take the bridge down.
      // ponytail: process-wide, so beside a run each one's handler sees the other's; attribute by context if that bites.
      const broke=new Promise<never>((_,reject)=>{crashed=reject;});
      const onRejection=(error:unknown)=>crashed(new Error(`unhandled rejection: ${message(error)}`));
      process.on('unhandledRejection',onRejection);
      let returned:unknown,error:string|undefined;
      try {
        returned=await Promise.race([broke,cutOff,(async()=>{
          const loaded:unknown=await import(`${pathToFileURL(gate.entry).href}?v=${statSync(gate.entry).mtimeMs}-${gate.sha}`);
          const main=typeof loaded==='object'&&loaded!==null?Reflect.get(loaded,'default'):undefined;
          if(typeof main!=='function')throw new Error('query/index.ts exports no default function');
          return await Reflect.apply(main,undefined,[]);
        })()]);
      } catch(thrown) {error=message(thrown);} // edge: the pilot's own program may throw anything
      finally {clearTimeout(timer);process.off('unhandledRejection',onRejection);}
      const calls=runCalls(),{commands}=progress(),ok=error===undefined;
      journalRun(deps.runtime,{query_id,juncture_id,sha:gate.sha,ok,ms:Date.now()-since,commands,
        calls:calls.slice(0,40),calls_total:calls.length,...refused.length?{refused}:{},...capped?{capped:true}:{},...error===undefined?{}:{error}},'query');
      return {ok,query_id,sha:gate.sha,lines:lines.slice(-LINES),
        ...returned===undefined?{}:{returned:clip(shown(returned),RETURNED_CHARS)},
        ...error===undefined?{}:{error},...refused.length?{refused}:{}};
    });
  });
}
