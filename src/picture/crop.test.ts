/** Cropping a reference to its subject (`crop.ts`): the box in pixels, the pixels cut, the PNG, and what is sent whole. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {inflateSync} from 'node:zlib';
import {crop,cropRgba,pixels,pngOf} from './crop.ts';
import {BOXES} from './refs.ts';

test('a box is whole pixels inside the image, at least one each way',()=>{
  // The ship box on a 1200x896 codex photo: the middle band, the yard's sky and floor cut.
  assert.deepEqual(pixels(BOXES.ship??{x:0,y:0,w:1,h:1},1200,896),{x:96,y:179,w:960,h:538});
  assert.deepEqual(pixels({x:0.9,y:0.9,w:0.5,h:0.5},10,10),{x:9,y:9,w:1,h:1});
  assert.deepEqual(pixels({x:-1,y:0,w:0,h:2},10,10),{x:0,y:0,w:1,h:10});
});

test('the pixels cut are the box\'s, row by row',()=>{
  const img={width:3,height:2,data:Uint8Array.from({length:24},(_,i)=>i)};
  const cut=cropRgba(img,{x:1,y:0,w:2,h:2});
  assert.deepEqual([cut.width,cut.height,[...cut.data]],[2,2,[4,5,6,7,8,9,10,11,16,17,18,19,20,21,22,23]]);
});

test('the PNG holds the pixels as given, unfiltered',()=>{
  const png=pngOf(1,1,new Uint8Array([9,8,7,255]));
  assert.deepEqual([...png.subarray(1,4)].map(c=>String.fromCharCode(c)).join(''),'PNG');
  const idat=Buffer.from(png).indexOf('IDAT'),len=Buffer.from(png).readUInt32BE(idat-4);
  assert.deepEqual([...inflateSync(png.subarray(idat+4,idat+4+len))],[0,9,8,7,255]);
});

test('anything but WebP is sent whole',async()=>{
  assert.equal(await crop(pngOf(1,1,new Uint8Array(4)),'image/png',{x:0,y:0,w:1,h:1}),null);
});
