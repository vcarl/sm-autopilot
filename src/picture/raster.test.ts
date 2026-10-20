/** Rasterising and compositing (`raster.ts`): PNG structure and fonts only, never pixels. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compose,rasterize,renderMap} from './raster.ts';

const svg=(w:number,h:number,body:string)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
const dims=(png:Uint8Array)=>{const v=new DataView(png.buffer,png.byteOffset);return [v.getUint32(16),v.getUint32(20)];};

test('rasterize produces a PNG of the requested size',async()=>{
  const {png}=await rasterize(svg(20,10,'<rect width="20" height="10" fill="#000"/>'));
  assert.deepEqual([...png.slice(0,8)],[137,80,78,71,13,10,26,10]);
  assert.deepEqual(dims(png),[20,10]);
});

test('rasterize without any font still renders',async()=>{
  const {png,fontsUsed}=await rasterize(svg(20,10,'<text y="9">x</text>'),{fonts:['/nonexistent.ttf']});
  assert.deepEqual(fontsUsed,[]);
  assert.deepEqual(dims(png),[20,10]);
});

test('renderMap on an empty runtime returns an 800x600 PNG and an empty model',async()=>{
  const root=mkdtempSync(join(tmpdir(),'spacemolt-raster-')),dir=join(root,'runtime');
  mkdirSync(dir,{recursive:true});
  try{
    const r=await renderMap(dir,{fonts:['/nonexistent.ttf'],galaxy:{fetched_at:'1970-01-01T00:00:00.000Z',systems:{}}});
    assert.deepEqual(dims(r.png),[800,600]);
    assert.equal(r.model.activity.visits.length,0);
    assert.deepEqual(r.fontsUsed,[]);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('compose embeds the art under the labels',async()=>{
  const {png:art}=await rasterize(svg(1,1,'<rect width="1" height="1" fill="#f00"/>'));
  const png=await compose(art,svg(40,30,'<rect width="10" height="10" fill="#00f"/>'),{width:40,height:30},{fonts:['/nonexistent.ttf']});
  assert.deepEqual(dims(png),[40,30]);
});
