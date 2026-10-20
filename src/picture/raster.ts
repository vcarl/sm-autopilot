/** Rasterising the map's SVG layers with resvg (wasm, no system fonts) and compositing the restyled art under the labels. */
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {initWasm,Resvg} from '@resvg/resvg-wasm';
import {SIZE} from './constants.ts';
import type {Galaxy} from './galaxy.ts';
import {buildModel,type MapModel} from './model.ts';
import {artSvg,labelsSvg} from './svg.ts';

export const DEFAULT_FONTS=['/System/Library/Fonts/Supplemental/Arial Bold.ttf','/System/Library/Fonts/Supplemental/Arial.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];

type Opts={fonts?:string[]};
type Size={width:number;height:number};
let ready:Promise<void>|undefined;
const wasm=()=>ready??=initWasm(readFileSync(fileURLToPath(import.meta.resolve('@resvg/resvg-wasm/index_bg.wasm'))));

/** Renders `svg` at its own width and height with every existing font path loaded (none: the text vanishes). */
export async function rasterize(svg:string,opts:Opts={}):Promise<{png:Uint8Array;fontsUsed:string[]}> {
  await wasm();
  const fontsUsed=(opts.fonts??process.env['SPACEMOLT_MAP_FONTS']?.split(':')??DEFAULT_FONTS).filter(f=>existsSync(f));
  const png=new Resvg(svg,{fitTo:{mode:'original'},font:{fontBuffers:fontsUsed.map(f=>readFileSync(f)),defaultFontFamily:'Arial',loadSystemFonts:false}}).render().asPng();
  return {png,fontsUsed};
}

/** The art PNG as one `<image>` under the label layer's own content (both share the viewBox), rasterised together. */
function layered(artPng:Uint8Array,labels:string,{width,height}:Size,opts:Opts) {
  const inner=labels.slice(labels.indexOf('>')+1,labels.lastIndexOf('</svg>'));
  const img=`<image href="data:image/png;base64,${Buffer.from(artPng).toString('base64')}" width="${width}" height="${height}"/>`;
  return rasterize(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial, Helvetica, sans-serif">${img}${inner}</svg>`,opts);
}

export async function compose(artPng:Uint8Array,labels:string,size:Size,opts:Opts={}):Promise<Uint8Array> {
  return (await layered(artPng,labels,size,opts)).png;
}

/** The whole picture for `runtime`: model, art layer rasterised, labels composited over it. */
export async function renderMap(runtime:string,opts:{runs?:number;juncture?:string;pilot?:string;fonts?:string[];galaxy?:Galaxy}={}):Promise<{png:Uint8Array;model:MapModel;fontsUsed:string[]}> {
  const {fonts,...rest}=opts,f:Opts=fonts?{fonts}:{},model=await buildModel(runtime,rest);
  const art=await rasterize(artSvg(model,SIZE),f),{png,fontsUsed}=await layered(art.png,labelsSvg(model,SIZE),SIZE,f);
  return {png,model,fontsUsed};
}
