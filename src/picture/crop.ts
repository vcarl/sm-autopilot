/** A reference cropped to its subject before it is sent, so the scenery around it is not passed in: the spike's crop cut the
 * Eviction Notice's asteroids from most renders and cost nothing (experiments/qwen-spike/README.md, finding 6). The photo is
 * kept as it is otherwise. WebP (the codex art) is decoded and cut; anything else is sent whole. */
/// <reference path="../../node_modules/@jsquash/webp/emscripten-types.d.ts" />
import {readFileSync} from 'node:fs';
import {crc32,deflateSync} from 'node:zlib';
import decodeWebp,{init as initWebp} from '@jsquash/webp/decode.js';

/** A crop as fractions of the image: left, top, width, height. */
export interface Box {x:number;y:number;w:number;h:number}
export interface Image {width:number;height:number;data:Uint8Array|Uint8ClampedArray}

/** `box` in whole pixels of a `width`×`height` image, kept inside it and at least one pixel. */
export function pixels(box:Box,width:number,height:number):Box {
  const x=Math.min(width-1,Math.max(0,Math.round(box.x*width))),y=Math.min(height-1,Math.max(0,Math.round(box.y*height)));
  return {x,y,w:Math.max(1,Math.min(width-x,Math.round(box.w*width))),h:Math.max(1,Math.min(height-y,Math.round(box.h*height)))};
}

/** The RGBA pixels inside `px`. */
export function cropRgba(img:Image,px:Box):Image {
  const data=new Uint8Array(px.w*px.h*4);
  for(let row=0;row<px.h;row++)data.set(img.data.subarray(((px.y+row)*img.width+px.x)*4,((px.y+row)*img.width+px.x+px.w)*4),row*px.w*4);
  return {width:px.w,height:px.h,data};
}

/** RGBA pixels as a PNG: one IDAT, no filtering. */
export function pngOf(width:number,height:number,rgba:Uint8Array|Uint8ClampedArray):Uint8Array {
  const chunk=(type:string,data:Uint8Array)=>{const head=Buffer.alloc(8),tail=Buffer.alloc(4),body=Buffer.concat([Buffer.from(type,'ascii'),data]);
    head.writeUInt32BE(data.length,0);head.write(type,4,'ascii');tail.writeUInt32BE(crc32(body),0);return Buffer.concat([head.subarray(0,4),body,tail]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr.set([8,6,0,0,0],8);
  const raw=Buffer.alloc((width*4+1)*height);
  for(let y=0;y<height;y++)Buffer.from(rgba.buffer,rgba.byteOffset+y*width*4,width*4).copy(raw,y*(width*4+1)+1);
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',new Uint8Array())]);
}

let webp:Promise<void>|undefined;
/** `bytes` cut to `box` as a PNG, with the pixels cut and the size it was cut from; null when it is not WebP (sent whole). */
export async function crop(bytes:Uint8Array,type:string,box:Box):Promise<{png:Uint8Array;px:Box;from:{width:number;height:number}}|null> {
  if(type!=='image/webp')return null;
  await (webp??=WebAssembly.compile(readFileSync(new URL(import.meta.resolve('@jsquash/webp/codec/dec/webp_dec.wasm')))).then(m=>initWebp(m)));
  const img=await decodeWebp(bytes.slice().buffer),px=pixels(box,img.width,img.height),cut=cropRgba(img,px);
  return {png:pngOf(cut.width,cut.height,cut.data),px,from:{width:img.width,height:img.height}};
}
