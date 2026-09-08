import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,utimesSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {getIndustryCatalog,normalizeIndustryCatalog} from './persistent-catalog.ts';
const payload={version:'fixture',items:{ore:{name:'Ore'}},recipes:{smelt:{inputs:[{item_id:'ore',quantity:2}],outputs:[{item_id:'metal',quantity:1}]}},skills:[],ships:[],facilities:[]};
const workspace=(t:any)=>{const dir=mkdtempSync(join(tmpdir(),'catalog-cache-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return {dir,path:join(dir,'catalog.json')};};

test('conditional cache survives new callers, 429 cooldown and stale recovery via 304',async t=>{
  const {path}=workspace(t);let now=1000000,calls=0;
  const fetcher:typeof fetch=async(_url,init)=>{
    calls++;
    if(calls===1)return new Response(JSON.stringify(payload),{status:200,headers:{etag:'"v1"'}});
    assert.equal((init!.headers as Record<string,string>)['if-none-match'],'"v1"');
    if(calls===2)return new Response('',{status:429,headers:{'retry-after':'120'}});
    return new Response(null,{status:304,headers:{etag:'"v1"'}});
  };
  const options={cachePath:path,now:()=>now,fetch:fetcher,revalidateMs:100};
  const first=await getIndustryCatalog(options);assert.equal(first.freshness,'fresh');assert.equal(first.cache!.recipe('smelt')!.id,'smelt');
  await getIndustryCatalog({...options});assert.equal(calls,1);
  now+=101;const stale=await getIndustryCatalog(options);assert.equal(stale.freshness,'stale');assert.equal(stale.retryAt,now+120000);assert.ok(stale.cache!.item('ore'));
  await getIndustryCatalog({...options});assert.equal(calls,2);
  now+=120001;const recovered=await getIndustryCatalog(options);assert.equal(recovered.freshness,'fresh');assert.equal(recovered.retryAt,null);assert.equal(recovered.fetchedAt,now);assert.equal(calls,3);
  assert.equal(JSON.parse(readFileSync(path,'utf8')).catalog.recipes[0].id,'smelt');
});

test('cold rate limits persist date and bounded fallback cooldowns; stale lock recovers',async t=>{
  const {path}=workspace(t);let now=Date.now(),calls=0;
  const date=new Date(now+180000).toUTCString();
  const options={cachePath:path,now:()=>now,fetch:async()=>{calls++;return new Response('',{status:429,headers:calls===1?{'retry-after':date}:{}});}};
  const cold=await getIndustryCatalog(options);assert.equal(cold.cache,null);assert.equal(cold.freshness,'unavailable');assert.equal(cold.retryAt,Date.parse(date));
  await getIndustryCatalog({...options});assert.equal(calls,1);
  now=Date.parse(date)+1;const second=await getIndustryCatalog(options);assert.equal(second.retryAt,now+120000);
  now=second.retryAt!+1;
  writeFileSync(`${path}.lock`,JSON.stringify({token:'dead-owner',pid:99999999}));
  utimesSync(`${path}.lock`,new Date(now-200000),new Date(now-200000));
  const recovered=await getIndustryCatalog({...options,fetch:async()=>new Response(JSON.stringify(payload))});assert.equal(recovered.freshness,'fresh');
  assert.throws(()=>normalizeIndustryCatalog({version:'bad',items:[],recipes:[{id:'bad',inputs:[{item_id:'ore',quantity:-1}],outputs:[]}]}),/Invalid recipe/);
});

test('separate processes share one refresh and restart reads the atomic stored catalog',async t=>{
  const {dir,path}=workspace(t),counter=join(dir,'requests.txt');
  const moduleUrl=new URL('./persistent-catalog.ts',import.meta.url).href;
  const source=`import {getIndustryCatalog} from ${JSON.stringify(moduleUrl)};import {appendFileSync} from 'node:fs';const result=await getIndustryCatalog({cachePath:${JSON.stringify(path)},fetch:async()=>{appendFileSync(${JSON.stringify(counter)},'request\\n');await new Promise(r=>setTimeout(r,150));return new Response(JSON.stringify(${JSON.stringify(payload)}),{headers:{etag:'test'}});}});process.stdout.write(result.freshness);`;
  const child=()=>new Promise<string>((resolve,reject)=>{const proc=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});let out='',err='';proc.stdout.on('data',chunk=>out+=chunk);proc.stderr.on('data',chunk=>err+=chunk);proc.on('error',reject);proc.on('exit',code=>code===0?resolve(out):reject(new Error(err)));});
  assert.deepEqual(await Promise.all([child(),child()]),['fresh','fresh']);
  assert.equal(readFileSync(counter,'utf8').trim().split('\n').length,1);
  assert.equal(await child(),'fresh');assert.equal(readFileSync(counter,'utf8').trim().split('\n').length,1);
});
