/** The end-of-flight post: on each pilot `run` `ended`, the flight's activity map and a selfie of each of the flight's two moments,
 * drawn and posted by a child process (src/picture/flight.ts), journalled as one `picture` line, and the Scenes they were drawn from
 * as `oracle` lines in `oracle.jsonl` (a scene with its moment is tens of kilobytes; the journal's tail stays small, as
 * `books.jsonl` keeps it). Off unless SPACEMOLT_IMAGER_URL is set.
 *
 * Never the run's business: the listener returns at once, a failure is a line, a child past `PICTURE_MS` is stopped, and a flight
 * that ends while one renders gets `skipped: 'busy'`, never a queue. */
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isRecord,journalRun,watchJournal} from './run-record.ts';

const FLIGHT=fileURLToPath(new URL('./picture/flight.ts',import.meta.url));
/** ponytail: one bound over the oracle, the map and two selfies, each of which may draw a species portrait first; every draw gives
 * up at 180 s by itself. A flight is 40-60 s (kvothe, 2026-10-19); lift it if a first render after a model load keeps hitting it. */
export const PICTURE_MS=600_000;

export interface PictureDeps {env?:Record<string,string|undefined>;timeoutMs?:number;
  /** What the child runs, for the tests: node's arguments after the binary. */
  argv?:(runtime:string,run_id:string)=>string[]}

/** The child's stdout's last line, or why there is none. */
function shoot(argv:string[],timeout:number,env?:Record<string,string|undefined>):Promise<Record<string,unknown>> {
  return new Promise(resolve=>{
    // The heap cap is the machine's guard: a scene needs under 100 MB of it after collection (kvothe, 2026-10-19), and a child
    // that outgrows the cap dies and is journalled rather than swapping the pilot's machine.
    execFile(process.execPath,['--max-old-space-size=1024',...argv],{timeout,maxBuffer:64<<20,env},(error,stdout,stderr)=>{
      const last=String(stdout).trim().split('\n').at(-1)??'';
      let read:unknown;
      try {read=JSON.parse(last);} catch {} // edge: a child killed or crashed printed nothing whole; the error below says why
      if(isRecord(read)&&!error)return resolve(read);
      const why=error&&'killed' in error&&error.killed?`timed out after ${Math.round(timeout/1000)} s`:error?error.message:'the child printed no result';
      resolve({picture:{ok:false,error:`${why}${stderr?`: ${String(stderr).trim().slice(-400)}`:''}`}});
    });
  });
}

/** Starts the listener; null when pictures are off. `idle` settles when no picture is rendering, for the tests and a shutdown. */
export function watchPictures(runtime:string,deps:PictureDeps={}):{stop:()=>void;idle:()=>Promise<void>}|null {
  if(!(deps.env??process.env).SPACEMOLT_IMAGER_URL)return null;
  let rendering:Promise<void>|null=null;
  const stop=watchJournal(e=>{
    if(e.event!=='run'||e.phase!=='ended'||e.freighter!==undefined||typeof e.run_id!=='string')return;
    const run_id=e.run_id;
    if(rendering)return journalRun(runtime,{run_id,ok:false,skipped:'busy'},'picture');
    const t0=Date.now();
    rendering=shoot(deps.argv?.(runtime,run_id)??[FLIGHT,runtime,run_id],deps.timeoutMs??PICTURE_MS,deps.env).then(got=>{
      for(const line of Array.isArray(got.oracles)?got.oracles:[])if(isRecord(line))journalRun(runtime,line,'oracle','oracle.jsonl');
      journalRun(runtime,{run_id,ms:Date.now()-t0,...isRecord(got.picture)?got.picture:{ok:false,error:'no picture in the result'}},'picture');
    }).catch((error:unknown)=>{try {journalRun(runtime,{run_id,ok:false,error:String(error)},'picture');} catch {}}) // edge: a journal that cannot be written loses the line, never the bridge
      .finally(()=>{rendering=null;});
  });
  return {stop,idle:()=>rendering??Promise.resolve()};
}
