import {openSync,writeFileSync,closeSync,unlinkSync} from 'node:fs';
/** Never steal a lock after a crash: an operator must first inspect the pilot/controller. */
export function controllerLock(path:string) {
  const fd=openSync(path,'wx',0o600);
  writeFileSync(fd,JSON.stringify({pid:process.pid,started_at:new Date().toISOString()}));
  closeSync(fd);
  return ()=>unlinkSync(path);
}
