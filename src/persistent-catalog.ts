import { CatalogCache, type Catalog } from '@spacemolt/lib';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

interface StoredCatalog { catalog?:Catalog; etag?:string; fetchedAt?:number; retryAt?:number; failures?:number; reason?:string }
export interface IndustryCatalogResult {
  cache:CatalogCache|null; freshness:'fresh'|'stale'|'unavailable';
  fetchedAt:number|null; retryAt:number|null; reason?:string;
}
export interface CatalogOptions {
  cachePath?:string; fetch?:typeof fetch; now?:()=>number; sleep?:(milliseconds:number)=>Promise<void>;
  revalidateMs?:number; lockWaitMs?:number; staleLockMs?:number; requestTimeoutMs?:number;
}
const record=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** The public endpoint can expose ID-keyed maps; CatalogCache expects arrays. */
export function normalizeIndustryCatalog(value:unknown):Catalog {
  if(!record(value)||typeof value.version!=='string')throw new Error('Invalid catalog object/version');
  const entries=(name:string,required=false)=>{
    const section=value[name];
    if(section===undefined&&!required)return [];
    const rows=Array.isArray(section)?section:record(section)?Object.entries(section).map(([id,row])=>record(row)?{id,...row}:row):null;
    if(!rows||rows.some(row=>!record(row)||typeof row.id!=='string'||!row.id))throw new Error(`Invalid catalog section: ${name}`);
    return rows;
  };
  const recipes=entries('recipes',true);
  for(const recipe of recipes)for(const key of ['inputs','outputs'])if(!Array.isArray(recipe[key])||recipe[key].some((item:any)=>!record(item)||typeof item.item_id!=='string'||!Number.isFinite(item.quantity)||item.quantity<0))throw new Error(`Invalid recipe ${key}`);
  return {version:value.version,ships:entries('ships'),items:entries('items',true),recipes,skills:entries('skills'),facilities:entries('facilities'),achievements:entries('achievements'),faction_achievements:entries('faction_achievements'),hidden_achievement_count:Number(value.hidden_achievement_count??0),hidden_faction_achievement_count:Number(value.hidden_faction_achievement_count??0)} as Catalog;
}
function read(path:string):StoredCatalog {
  try {const data=JSON.parse(readFileSync(path,'utf8'));if(!record(data))throw new Error('Invalid catalog cache');if(data.catalog)data.catalog=normalizeIndustryCatalog(data.catalog);return data;}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {};throw error;}
}
function write(path:string,value:StoredCatalog) {
  const temporary=`${path}.${randomUUID()}.tmp`;
  try{writeFileSync(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});renameSync(temporary,path);}
  finally{try{unlinkSync(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
}
const active=new Map<string,Promise<IndustryCatalogResult>>();
/** Shared across calls and processes. Stale data is explicit, never a fresh production quote. */
export function getIndustryCatalog(options:CatalogOptions={}):Promise<IndustryCatalogResult> {
  const path=resolve(options.cachePath??fileURLToPath(new URL('../runtime/catalog-cache.json',import.meta.url)));
  const running=active.get(path);if(running)return running;
  const task=loadCatalog(path,options).finally(()=>{if(active.get(path)===task)active.delete(path);});
  active.set(path,task);return task;
}
async function loadCatalog(path:string,options:CatalogOptions):Promise<IndustryCatalogResult> {
  const now=options.now??Date.now,sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const ttl=options.revalidateMs??3600000,waitLimit=options.lockWaitMs??35000,staleAge=options.staleLockMs??120000;
  const requestTimeout=options.requestTimeoutMs??30000;
  if(![ttl,waitLimit,staleAge,requestTimeout].every(n=>Number.isFinite(n)&&n>0)||staleAge<=requestTimeout)throw new Error('Invalid catalog timing bounds (stale lock must exceed request timeout)');
  mkdirSync(dirname(path),{recursive:true});
  const view=(data:StoredCatalog,reason?:string):IndustryCatalogResult=>({cache:data.catalog?new CatalogCache(data.catalog,data.etag):null,freshness:!data.catalog?'unavailable':data.fetchedAt!==undefined&&now()-data.fetchedAt<ttl&&!data.reason?'fresh':'stale',fetchedAt:data.fetchedAt??null,retryAt:data.retryAt??null,...((reason??data.reason)?{reason:reason??data.reason}:{})});
  const usable=(data:StoredCatalog)=>!!(data.retryAt&&data.retryAt>now())||!!(data.catalog&&data.fetchedAt!==undefined&&now()-data.fetchedAt<ttl);
  let data=read(path);if(usable(data))return view(data);
  const lock=`${path}.lock`,token=randomUUID(),start=now();
  let acquired=false;
  while(!acquired){
    try{writeFileSync(lock,JSON.stringify({token,pid:process.pid,createdAt:now()}),{flag:'wx',mode:0o600});acquired=true;}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      try{
        const first=readFileSync(lock,'utf8');
        let ownerAlive=false;
        let owner:any;try{owner=JSON.parse(first);}catch{owner=null;}
        if(Number.isInteger(owner?.pid)&&owner.pid>0){try{process.kill(owner.pid,0);ownerAlive=true;}catch(error){if((error as NodeJS.ErrnoException).code==='EPERM')ownerAlive=true;else if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}
        // A paused but live refresher still owns its lock. Wait boundedly instead
        // of issuing a competing HTTP request merely because its age is old.
        if(!ownerAlive&&now()-statSync(lock).mtimeMs>staleAge&&readFileSync(lock,'utf8')===first){unlinkSync(lock);continue;}
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;continue;}
      data=read(path);if(usable(data))return view(data);
      if(now()-start>=waitLimit)return view(data,'Catalog refresh is already running; lock wait expired');
      await sleep(Math.min(100,waitLimit-(now()-start)));
    }
  }
  try{
    // Another process may have refreshed while we waited for ownership.
    data=read(path);if(usable(data))return view(data);
    try{
      const headers:Record<string,string>={accept:'application/json'};if(data.etag)headers['if-none-match']=data.etag;
      const response=await (options.fetch??fetch)('https://game.spacemolt.com/api/catalog.json',{headers,signal:AbortSignal.timeout(requestTimeout)});
      if(response.status===304){
        if(!data.catalog)throw new Error('Catalog returned 304 without cached content');
        data={catalog:data.catalog,etag:response.headers.get('etag')??data.etag,fetchedAt:now(),failures:0};
      }else if(response.ok){
        data={catalog:normalizeIndustryCatalog(await response.json()),etag:response.headers.get('etag')??undefined,fetchedAt:now(),failures:0};
      }else{
        const failures=(data.failures??0)+1,fallback=Math.min(3600000,60000*2**Math.min(failures-1,6));
        const retryHeader=response.headers.get('retry-after');
        const seconds=retryHeader!==null&&/^\d+(?:\.\d+)?$/.test(retryHeader.trim())?Number(retryHeader)*1000:null;
        const date=retryHeader===null?NaN:Date.parse(retryHeader);
        const delay=seconds!==null?seconds:Number.isFinite(date)?date-now():fallback;
        data={...data,failures,retryAt:now()+Math.max(1000,delay),reason:`Catalog HTTP ${response.status}; refresh deferred`};
      }
    }catch(error){
      const failures=(data.failures??0)+1;
      data={...data,failures,retryAt:now()+Math.min(3600000,60000*2**Math.min(failures-1,6)),reason:error instanceof Error?error.message:String(error)};
    }
    write(path,data);return view(data);
  }finally{
    try{if(JSON.parse(readFileSync(lock,'utf8')).token===token)unlinkSync(lock);}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
}
