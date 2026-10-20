// Dev renderer for the activity map (src/picture): `node scripts/render-map.ts <runtime-dir> [--out map.png]
// [--runs 28 | --juncture <id>] [--pilot Pilot] [--art-only 1024x768]`. --juncture draws that juncture's runs over the muted runs before it. Reads the pilot's runtime journal; the only file it may write
// there is the galaxy cache. --art-only writes just the art layer at that size (the input of the Qwen restyle).
import {existsSync,statSync,writeFileSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {buildModel} from '../src/picture/model.ts';
import {rasterize,renderMap} from '../src/picture/raster.ts';
import {artSvg} from '../src/picture/svg.ts';
import {readWindow} from '../src/picture/window.ts';

const USAGE='usage: node scripts/render-map.ts <runtime-dir> [--out map.png] [--runs 28 | --juncture id] [--pilot Pilot] [--art-only 1024x768]';
class Fail extends Error {}

async function main() {
  const {values,positionals}=parseArgs({allowPositionals:true,options:{out:{type:'string',default:'map.png'},runs:{type:'string',default:'28'},
    juncture:{type:'string'},pilot:{type:'string',default:'Pilot'},'art-only':{type:'string'},help:{type:'boolean',short:'h'}}});
  if(values.help){console.log(USAGE);return;}
  const [runtime]=positionals,runs=Number(values.runs),out=values.out;
  if(!runtime||positionals.length>1||!Number.isInteger(runs)||runs<1)throw new Fail(USAGE);
  const size=values['art-only'];
  const art=size===undefined?undefined:/^(\d+)x(\d+)$/.exec(size);
  if(size!==undefined&&(!art||!Number(art[1])||!Number(art[2])))throw new Fail(`--art-only wants WxH with both above 0, got ${size}`);
  if(!existsSync(runtime)||!statSync(runtime).isDirectory())throw new Fail(`runtime dir not found: ${runtime}`);
  // before the model: buildModel's galaxy load writes galaxy.json into the runtime dir
  const juncture=values.juncture;
  if(readWindow(runtime,juncture?{juncture}:runs).runs.length===0)throw new Fail(`no runs in ${runtime}${juncture?` for juncture ${juncture}`:''}`);
  const opts={runs,pilot:values.pilot,...juncture?{juncture}:{}};
  let png:Uint8Array,model,fontsUsed:string[];
  if(!art)({png,model,fontsUsed}=await renderMap(runtime,opts));
  else {
    model=await buildModel(runtime,opts);
    ({png,fontsUsed}=await rasterize(artSvg(model,{width:Number(art[1]),height:Number(art[2])})));
  }
  writeFileSync(out,png);
  console.log(`fonts: ${fontsUsed.join(', ')||'none'}`);
  console.log(`window: ${model.window.start.toISOString()} - ${model.window.end.toISOString()}`);
  console.log(`systems visited (${model.activity.visits.length}): ${[...new Set(model.activity.visits.map(v=>v.system))].join(', ')}`);
  console.log(`epochs (${model.epochs.length}):`);
  for(const e of model.epochs)console.log(`  ${e.systems.length} systems: ${e.systems.join(', ')}`);
  console.log(`unknown systems: ${model.unknownSystems.join(', ')||'none'}`);
  console.log(`wrote ${out}`);
}

main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:String(error));process.exit(1);});
