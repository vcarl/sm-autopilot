/** The end-of-flight post: the map and the two moments' selfies against a stubbed imager and webhook (`picture/flight.ts`), and the
 * bridge's hook that runs them in a child on `run` `ended` (`pictures.ts`). Nothing here reaches the network. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {watchPictures} from './pictures.ts';
import {flight,flightCaption,type FlightDeps} from './picture/flight.ts';
import {seedOf} from './picture/imager.ts';
import {flightScenes} from './picture/oracle.ts';
import {journalRun,readJournal} from './run-record.ts';
import {FLIGHT_JUNCTURE,FLIGHT_RUN,flightRuntime} from './test-support/flight-runtime.ts';

const PNG=Buffer.from('fake-png'),MAP=Buffer.from('fake-map'),IMAGER='http://imager.test',HOOK='http://hook.test/webhook';
const drawn=()=>new Response(JSON.stringify({data:[{b64_json:PNG.toString('base64')}]}),{status:200});
const pictures=(dir:string)=>readJournal(dir,200).filter(l=>l.event==='picture');
const ENV={SPACEMOLT_IMAGER_URL:IMAGER,SPACEMOLT_JOURNAL_WEBHOOK:HOOK};
/** A stubbed fetch: the imager draws (or answers `imager`), the webhook takes the post; every request is kept. */
function stub(o:{imager?:number}={}) {
  const sent:{url:string;init:RequestInit|undefined}[]=[];
  const fetch=async(url:string|URL|Request,init?:RequestInit)=>{sent.push({url:String(url),init});
    return String(url).startsWith(IMAGER)?o.imager?new Response('model not loaded',{status:o.imager}):drawn():new Response('',{status:200});};
  return {sent,fetch,form:()=>{const f=sent.find(s=>s.url===HOOK)?.init?.body;assert.ok(f instanceof FormData);return f;}};
}
const files=async(form:FormData)=>Promise.all([...form.keys()].filter(k=>k.startsWith('files[')).map(async k=>{const f=form.get(k);assert.ok(f instanceof File);return [k,f.name,Buffer.from(await f.arrayBuffer()).toString()];}));
const NOW=()=>new Date('2026-10-19T12:00:00.123Z');

test('a flight posts one message: the map first, then a selfie of each moment, each on its own seed and camera, with the caption',async()=>{
  const dir=flightRuntime(),s=stub(),deps:FlightDeps={env:ENV,fetch:s.fetch,now:NOW,map:async()=>MAP};
  const {picture,oracles}=await flight(dir,FLIGHT_RUN,deps);
  assert.equal(picture.ok,true);assert.equal(picture.posted,true);
  assert.deepEqual(picture.images.map(i=>[i.kind,i.ok,i.moment?.type??null,i.seed??null,i.camera??null]),
    [['map',true,null,null,null],['selfie',true,'spacemolt/mine',seedOf(FLIGHT_RUN),['shoulder','side','wide'][seedOf(FLIGHT_RUN)%3]],
      ['selfie',true,'spacemolt/jump',seedOf(FLIGHT_RUN)+1,['shoulder','side','wide'][(seedOf(FLIGHT_RUN)+1)%3]]]);
  const stamp='2026-10-19T12-00-00Z';
  assert.deepEqual(await files(s.form()),[['files[0]',`map-${stamp}.png`,'fake-map'],['files[1]',`selfie-${stamp}-1.png`,'fake-png'],['files[2]',`selfie-${stamp}-2.png`,'fake-png']]);
  for(const i of picture.images)assert.ok(existsSync(String(i.path)),String(i.path));
  assert.equal(JSON.parse(String(s.form().get('payload_json'))).content,picture.caption);
  assert.match(String(picture.caption),/ · moments: mine at .+; jump at /);
  assert.equal(picture.caption,flightCaption(await flightScenes(dir,FLIGHT_RUN)));
  // Each selfie's prompt was drawn on its own seed: the two draws differ in seed and camera.
  const bodies=s.sent.filter(x=>x.url.startsWith(IMAGER)).map(x=>JSON.parse(String(x.init?.body)));
  assert.deepEqual(bodies.map(b=>b.seed),[seedOf(FLIGHT_RUN),seedOf(FLIGHT_RUN)+1]);
  assert.deepEqual(bodies.map(b=>b.prompt),picture.images.slice(1).map(i=>i.prompt));
  assert.deepEqual(oracles.map(o=>[o.run_id,o.scene.moment?.lead.type]),[[FLIGHT_RUN,'spacemolt/mine'],[FLIGHT_RUN,'spacemolt/jump']]);
});

test('the real map: the juncture is the focus, drawn as a PNG beside the selfies',async()=>{
  const dir=flightRuntime(),s=stub();
  const {picture}=await flight(dir,FLIGHT_RUN,{env:ENV,fetch:s.fetch,now:NOW});
  const [map]=picture.images;
  assert.equal(map?.ok,true,String(map?.error));
  assert.deepEqual([...readFileSync(String(map?.path)).subarray(1,4)].map(c=>String.fromCharCode(c)).join(''),'PNG');
});

test('a flight with one moment posts two files: the map and its selfie',async()=>{
  const dir=flightRuntime(),s=stub();
  const one=async(rt:string,id:string)=>(await flightScenes(rt,id)).slice(0,1);
  const {picture}=await flight(dir,FLIGHT_RUN,{env:ENV,fetch:s.fetch,now:NOW,map:async()=>MAP,scenes:one});
  assert.deepEqual(picture.images.map(i=>i.kind),['map','selfie']);
  assert.deepEqual((await files(s.form())).map(f=>f[0]),['files[0]','files[1]']);
  assert.doesNotMatch(String(picture.caption),/;/);
});

test('a flight where the pilot did nothing is skipped as idle: nothing drawn, nothing posted',async()=>{
  const dir=flightRuntime({idle:true}),s=stub();
  const {picture,oracles}=await flight(dir,FLIGHT_RUN,{env:ENV,fetch:s.fetch,map:async()=>MAP});
  assert.equal(picture.skipped,'idle');assert.equal(picture.ok,false);assert.deepEqual(picture.images,[]);
  assert.deepEqual(s.sent,[]);
  assert.equal(oracles.length,1); // the scene that said so is still kept
});

test('a map that fails still posts the selfies, and selfies that fail still post the map; nothing at all is no post',async()=>{
  const dir=flightRuntime();
  let s=stub();
  const noMap=await flight(dir,FLIGHT_RUN,{env:ENV,fetch:s.fetch,now:NOW,map:async()=>{throw new Error('resvg broke');}});
  assert.deepEqual(noMap.picture.images.map(i=>[i.kind,i.ok,i.error]),[['map',false,'resvg broke'],['selfie',true,null],['selfie',true,null]]);
  assert.deepEqual((await files(s.form())).map(f=>String(f[1]).replace(/-2026.*-/,'-')),['selfie-1.png','selfie-2.png']);
  s=stub({imager:500});
  const noSelfies=await flight(dir,FLIGHT_RUN,{env:ENV,fetch:s.fetch,now:NOW,map:async()=>MAP});
  assert.deepEqual(noSelfies.picture.images.map(i=>[i.kind,i.ok]),[['map',true],['selfie',false],['selfie',false]]);
  assert.match(String(noSelfies.picture.images[1]?.error),/imager HTTP 500: model not loaded/);
  assert.ok(noSelfies.picture.images[1]?.prompt); // what it was told is kept
  assert.deepEqual((await files(s.form())).map(f=>f[0]),['files[0]']);
  s=stub({imager:500});
  const none=await flight(dir,FLIGHT_RUN,{env:ENV,fetch:s.fetch,map:async()=>{throw new Error('no');}});
  assert.equal(none.picture.ok,false);assert.equal(none.picture.posted,null);assert.ok(!s.sent.some(x=>x.url===HOOK));
});

test('with no webhook the images are still written and nothing is posted; a webhook that fails keeps them',async()=>{
  const dir=flightRuntime();
  let s=stub();
  const quiet=await flight(dir,FLIGHT_RUN,{env:{SPACEMOLT_IMAGER_URL:IMAGER},fetch:s.fetch,map:async()=>MAP});
  assert.equal(quiet.picture.posted,null);assert.ok(quiet.picture.images.every(i=>existsSync(String(i.path))));
  assert.ok(!s.sent.some(x=>x.url===HOOK));
  s=stub();
  const down=async(url:string|URL|Request,init?:RequestInit)=>String(url)===HOOK?new Response('gone',{status:404}):s.fetch(url,init);
  const kept=await flight(dir,FLIGHT_RUN,{env:ENV,fetch:down,map:async()=>MAP});
  assert.equal(kept.picture.ok,true);assert.equal(kept.picture.posted,false);assert.match(String(kept.picture.post_error),/webhook HTTP 404/);
  const missing=await flight(dir,'nope',{env:ENV,fetch:s.fetch,map:async()=>MAP});
  assert.equal(missing.picture.ok,false);assert.match(String(missing.picture.error),/no ended run nope/);
});

test('hook: with no SPACEMOLT_IMAGER_URL nothing listens and nothing is journalled',()=>{
  const dir=flightRuntime();
  assert.equal(watchPictures(dir,{env:{}}),null);
  journalRun(dir,{phase:'ended',run_id:'r9'},'run');
  assert.deepEqual(pictures(dir),[]);
});

/** A child that prints `result` after `ms`, or `exit` with stderr. */
const child=(o:{ms?:number;result?:unknown;exit?:number})=>()=>['-e',
  `setTimeout(()=>{${o.exit?`console.error('boom');process.exit(${o.exit})`:`console.log(${JSON.stringify(JSON.stringify(o.result??{}))})`}},${o.ms??0})`];
const end=(dir:string,run_id:string)=>journalRun(dir,{phase:'ended',run_id},'run');

test('hook: the child\'s post is journalled with the run and its wall time, and its scenes go to oracle.jsonl',async()=>{
  const dir=flightRuntime();
  const w=watchPictures(dir,{env:{SPACEMOLT_IMAGER_URL:IMAGER},argv:child({result:{picture:{ok:true,posted:true,images:[{kind:'map',ok:true}]},
    oracles:[{event:'oracle',run_id:'r1',scene:{run_id:'r1'}},{event:'oracle',run_id:'r1',scene:{run_id:'r1'}}]}})});
  try {
    end(dir,'r1');
    await w?.idle();
    const [line]=pictures(dir);
    assert.equal(line?.run_id,'r1');assert.equal(line?.ok,true);assert.equal(line?.posted,true);assert.equal(typeof line?.ms,'number');
    assert.deepEqual(line?.images,[{kind:'map',ok:true}]);
    assert.deepEqual(readJournal(dir,10,'oracle').map(l=>[l.event,l.run_id]),[['oracle','r1'],['oracle','r1']]);
  } finally {w?.stop();}
});

test('hook: a flight that ends while a post renders is skipped as busy, never queued',async()=>{
  const dir=flightRuntime();
  const w=watchPictures(dir,{env:{SPACEMOLT_IMAGER_URL:IMAGER},argv:child({ms:500,result:{picture:{ok:true}}})});
  try {
    end(dir,'r1');end(dir,'r2');
    await w?.idle();
    assert.deepEqual(pictures(dir).map(l=>[l.run_id,l.ok,l.skipped]),[['r2',false,'busy'],['r1',true,undefined]]);
    end(dir,'r3'); // free again
    await w?.idle();
    assert.equal(pictures(dir).at(-1)?.run_id,'r3');
  } finally {w?.stop();}
});

test('hook: a child past the bound is stopped and journalled as timed out; a crash is journalled with its stderr; neither throws',async()=>{
  const dir=flightRuntime();
  const slow=watchPictures(dir,{env:{SPACEMOLT_IMAGER_URL:IMAGER},timeoutMs:300,argv:child({ms:60_000})});
  try {
    const t0=Date.now();
    end(dir,'r1');
    await slow?.idle();
    assert.ok(Date.now()-t0<10_000);
    assert.match(String(pictures(dir)[0]?.error),/timed out after 0 s/);
  } finally {slow?.stop();}
  const crash=watchPictures(dir,{env:{SPACEMOLT_IMAGER_URL:IMAGER},argv:child({exit:3})});
  try {
    end(dir,'r2');
    await crash?.idle();
    const line=pictures(dir).at(-1);
    assert.equal(line?.run_id,'r2');assert.equal(line?.ok,false);assert.match(String(line?.error),/boom/);
  } finally {crash?.stop();}
});

test('hook, end to end: the real child reads the flight, draws from a stubbed imager, posts map and selfies, and the bridge journals it',async()=>{
  const dir=flightRuntime(),hits:string[]=[];
  let body='';
  const server=createServer((req,res)=>{hits.push(req.url??'');req.setEncoding('latin1');req.on('data',(c:string)=>{if(req.url==='/hook')body+=c;});req.on('end',()=>{
    res.end(req.url==='/v1/images/generations'?JSON.stringify({data:[{b64_json:PNG.toString('base64')}]}):'');});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address(),base=`http://127.0.0.1:${typeof address==='object'&&address?address.port:0}`;
  const w=watchPictures(dir,{env:{...process.env,SPACEMOLT_IMAGER_URL:base,SPACEMOLT_JOURNAL_WEBHOOK:`${base}/hook`},argv:rt=>[join(import.meta.dirname,'picture','flight.ts'),rt,FLIGHT_RUN]});
  try {
    end(dir,'trigger'); // the trigger; the child draws the fixture's flight
    await w?.idle();
    const line=pictures(dir).at(-1);
    assert.equal(line?.ok,true,JSON.stringify(line));assert.equal(line?.posted,true);
    assert.deepEqual(hits,['/v1/images/generations','/v1/images/generations','/hook']);
    assert.deepEqual([...body.matchAll(/name="(files\[\d\])"; filename="(map|selfie)-/g)].map(m=>`${m[1]}:${m[2]}`),['files[0]:map','files[1]:selfie','files[2]:selfie']);
    assert.deepEqual(readJournal(dir,10,'oracle').map(l=>l.juncture_id),[FLIGHT_JUNCTURE,FLIGHT_JUNCTURE]);
  } finally {w?.stop();server.close();}
});
