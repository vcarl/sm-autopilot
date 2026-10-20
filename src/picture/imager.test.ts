/** The image server client (`imager.ts`): the request it sends and the answer it reads, against a stubbed fetch. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {NEUTRAL,STYLE,draw,imagerOf} from './imager.ts';

const PNG=Buffer.from('fake-png');
const ok=()=>new Response(JSON.stringify({created:0,data:[{b64_json:PNG.toString('base64')}]}),{status:200});

test('settings come from the environment, with the defaults the spike used',()=>{
  assert.deepEqual(imagerOf({}),{url:'http://127.0.0.1:11234',model:'ddalcu/Qwen-Image-2.1-Turbo-MLX-Serve-8bit',style:STYLE});
  assert.deepEqual(imagerOf({SPACEMOLT_IMAGER_URL:'http://imager:9/',SPACEMOLT_IMAGER_KEY:'k',SPACEMOLT_IMAGE_MODEL:'m',SPACEMOLT_IMAGE_STYLE:'ink'}),
    {url:'http://imager:9',key:'k',model:'m',style:'ink'});
});

// experiments/qwen-spike/README.md: the JSON route, `model` required, the first reference `image` and the rest `ref_images`.
test('with references: a JSON edit, the first reference as image and the rest as ref_images, base64, no other knobs',async()=>{
  const calls:{url:string;init:RequestInit|undefined}[]=[];
  const fetch=async(url:string|URL|Request,init?:RequestInit)=>{calls.push({url:String(url),init});return ok();};
  const png=await draw({url:'http://x',key:'secret',model:'m',style:'s'},{prompt:'p <image1>',seed:7,refs:[new Uint8Array([1,2]),new Uint8Array([3])]},{fetch});
  assert.equal(Buffer.from(png).toString(),'fake-png');
  const [call]=calls;
  assert.equal(call?.url,'http://x/v1/images/generations');
  assert.equal(call?.init?.method,'POST');
  const headers=new Headers(call?.init?.headers);
  assert.equal(headers.get('authorization'),'Bearer secret');assert.equal(headers.get('content-type'),'application/json');
  assert.deepEqual(JSON.parse(String(call?.init?.body)),{model:'m',prompt:'p <image1>',size:'1024x768',seed:7,mode:'edit',image:'AQI=',ref_images:['Aw==']});
  await draw({url:'http://x',model:'m',style:'s'},{prompt:'p',seed:8,refs:[new Uint8Array([1,2])]},{fetch});
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)),{model:'m',prompt:'p',size:'1024x768',seed:8,mode:'edit',image:'AQI='}); // one reference: no ref_images
});

// Live 2026-10-19 (recipe2, b9bbabf4): a plain generation lost the colour and the pilot's ash hair; the edit route keeps them.
test('without references: an edit of the neutral grey frame, no auth header when there is no key',async()=>{
  const calls:{url:string;init:RequestInit|undefined}[]=[];
  const fetch=async(url:string|URL|Request,init?:RequestInit)=>{calls.push({url:String(url),init});return ok();};
  await draw(imagerOf({SPACEMOLT_IMAGER_URL:'http://x'}),{prompt:'p',refs:[]},{fetch});
  assert.equal(calls[0]?.url,'http://x/v1/images/generations');
  const headers=new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get('authorization'),null);assert.equal(headers.get('content-type'),'application/json');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)),{model:'ddalcu/Qwen-Image-2.1-Turbo-MLX-Serve-8bit',prompt:'p',size:'1024x768',mode:'edit',image:Buffer.from(NEUTRAL).toString('base64')});
});

test('an error status or an answer without b64_json throws, naming it',async()=>{
  const imager=imagerOf({});
  await assert.rejects(draw(imager,{prompt:'p',refs:[]},{fetch:async()=>new Response('model busy',{status:503})}),/HTTP 503: model busy/);
  await assert.rejects(draw(imager,{prompt:'p',refs:[]},{fetch:async()=>new Response('{"data":[]}',{status:200})}),/no b64_json/);
});
