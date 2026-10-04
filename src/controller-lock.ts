import {field} from './play/game.ts';
import {openSync,writeFileSync,closeSync,unlinkSync,readFileSync} from 'node:fs';

function take(path:string) {
  const fd=openSync(path,'wx',0o600);
  writeFileSync(fd,JSON.stringify({pid:process.pid,started_at:new Date().toISOString()}));
  closeSync(fd);
}
/** The pid recorded in the lock, or NaN for a lock too old or too broken to name one. */
function holder(path:string):number {
  try {return Number(field(JSON.parse(readFileSync(path,'utf8')),'pid'));}
  catch {return NaN;} // edge: a missing or half-written lock names no holder
}
// ponytail: liveness is the pid alone. Compare started_at against the process start time if
// pid reuse on a long-lived host ever wedges a bridge behind a recycled pid.
function alive(pid:number):boolean {
  if(!Number.isInteger(pid)||pid<=0)return false;
  try {process.kill(pid,0);return true;}
  catch(error){return field(error,'code')!=='ESRCH';} // edge: a pid probe; EPERM means alive, just not ours
}

/** Never steal a lock from a LIVE controller: a human must first inspect the pilot.
 *  A lock whose holder is gone is not a lock — a killed bridge must not wedge every successor. */
export function controllerLock(path:string) {
  try {take(path);}
  catch(error) { // edge: another process may hold the lock; only a stale EEXIST is replaced
    if(field(error,'code')!=='EEXIST'||alive(holder(path)))throw error;
    console.warn(`SpaceMolt: replacing a stale controller lock at ${path} (holder ${holder(path)} is gone)`);
    unlinkSync(path);
    take(path);
  }
  return ()=>{
    try {unlinkSync(path);}
    catch {/* already released */} // edge: an exit handler may run twice
  };
}
