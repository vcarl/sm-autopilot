// The prompt a recorded flight's picture is drawn from (src/picture): `node scripts/flight-prompt.ts <runtime-dir>
// <run_id|juncture_id|latest> [--last N] [--kind selfie|scene] [--render] [--out dir] [--cache dir] [--seed n] [--seeds N]
// [--prompt-file f]`. Without --render it prints each scene's summary, subject, prompt and caption. With it, it fetches the
// moment's one subject reference (refs.ts), cropped to the subject, and draws the prompt with it as `<image1>` (imager.ts), on
// seeds seed+0 … seed+N-1 (the seed is the run id's, seedOf, unless --seed gives one; --seeds defaults to 3; --seeds 0 writes the
// files below and draws nothing, not even a species portrait), writing
// <out>/<juncture id, 8>/scene.json, prompt.txt, caption.txt, refs.json (the reference, its crop, its fetch), ref.png (the bytes
// sent; none when the prompt names no subject), species-<id>.png (a portrait drawn or kept) and <kind>-1.png … <kind>-N.png, and a
// selfie's prompt-<n>.txt per seed, since its camera is the seed's (prompts.ts `CAMERAS`). --prompt-file draws that exact text
// (trailing newline cut) in place of the template's, with the reference, seeds and size the run would have had. --template
// prints the annotated templates. Reads the runtime dir; writes nothing there but galaxy.json when none is kept, and the
// reference cache when --cache is left at its default (<runtime>/refs).
import {existsSync,mkdirSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {NEUTRAL,draw,imagerOf,seedOf} from '../src/picture/imager.ts';
import {scenes,type Scene} from '../src/picture/oracle.ts';
import {annotate,annotateWords,caption,promptOf,type Kind} from '../src/picture/prompts.ts';
import {fetchRef,refOf,type SpeciesSource} from '../src/picture/refs.ts';
import {catalogItems,portraitPrompt,speciesFacts,speciesName,speciesRef} from '../src/picture/species.ts';

const USAGE='usage: node scripts/flight-prompt.ts <runtime-dir> <run_id|juncture_id|latest> [--last N] [--kind selfie|scene] [--render] [--out dir] [--cache dir] [--seed n] [--seeds N] [--prompt-file f] | --template';
class Fail extends Error {}

/** The Scene paths that hold nothing: what the journal could not supply. */
const missing=(s:Scene)=>[...Object.entries(s.where).map(([k,v])=>[`where.${k}`,v]),...Object.entries(s.status).map(([k,v])=>[`status.${k}`,v]),
  ['company.creatures',s.company.creatures.length?1:null],['company.nearby',s.company.nearby.length?1:null],['company.ships',s.company.ships.length?1:null],
  ['lately.fights.last_opponent',s.lately.fights.last_opponent],['flags.hull_low',s.flags.hull_low],['flags.fresh_from',s.flags.fresh_from],['subject',s.subject]]
  .filter(([,v])=>v===null).map(([k])=>String(k));

async function main() {
  const {values,positionals}=parseArgs({allowPositionals:true,options:{last:{type:'string',default:'1'},kind:{type:'string',default:'selfie'},
    render:{type:'boolean'},out:{type:'string',default:'pictures'},cache:{type:'string'},seed:{type:'string'},seeds:{type:'string',default:'3'},'prompt-file':{type:'string'},
    template:{type:'boolean'},help:{type:'boolean',short:'h'}}});
  if(values.help){console.log(USAGE);return;}
  if(values.template){for(const k of ['selfie','scene'] as const)console.log(`## ${k}\n\n${annotate(k)}\n`);console.log(`## poses and settings\n\n${annotateWords()}\n`);return;}
  const [runtime,select]=positionals,last=Number(values.last),kind=values.kind,seed=values.seed===undefined?undefined:Number(values.seed),seeds=Number(values.seeds);
  if(!runtime||!select||positionals.length>2||!Number.isInteger(last)||last<1||(kind!=='selfie'&&kind!=='scene')||(seed!==undefined&&!Number.isInteger(seed))||!Number.isInteger(seeds)||seeds<0)throw new Fail(USAGE);
  if(!existsSync(runtime)||!statSync(runtime).isDirectory())throw new Fail(`runtime dir not found: ${runtime}`);
  const found=await scenes(runtime,select,last);
  if(!found.length)throw new Fail(`no ended run for ${select} in ${runtime}`);
  const override=values['prompt-file']===undefined?undefined:readFileSync(values['prompt-file'],'utf8').replace(/\n+$/,''),imager=imagerOf(),cache=values.cache??join(runtime,'refs');
  const items=catalogItems(runtime);
  console.log(`imager ${imager.url}, model ${imager.model}`);
  for(const scene of found) {
    const id=(scene.juncture_id??scene.run_id).slice(0,8),k:Kind=kind;
    console.log(`\n== juncture ${scene.juncture_id??'-'} run ${scene.run_id} ended ${scene.ended} (${scene.work?.fn??'-'} ${scene.outcome??'-'}), fresh_from ${scene.flags.fresh_from??'-'}`);
    console.log(`missing: ${missing(scene).join(', ')||'nothing'}`);
    // A prompt that names no subject sends no subject art. A selfie's camera is the seed's, so its prompt is per seed.
    const at=seed??seedOf(scene.run_id),textOf=(i:number)=>override??promptOf(k,scene,imager.style,at+i).text;
    const made=promptOf(k,scene,imager.style,at),text=textOf(0),cap=caption(scene),ref=scene.subject&&made.subject?refOf(scene.subject):null;
    if(!values.render) {
      console.log(`subject: ${scene.subject?`${scene.subject.kind} ${scene.subject.id} (${scene.subject.category}) ${ref?.url}`:'none'}`);
      if(scene.subject?.kind==='creature')console.log(`species ${scene.subject.id} portrait prompt: ${portraitPrompt(speciesName(scene,scene.subject.id),speciesFacts(items,scene.subject.id))}`);
      for(let i=0;i<Math.max(1,seeds);i++)console.log(`prompt (seed ${at+i}): ${textOf(i)}`);
      console.log(`caption: ${cap}`);
      continue;
    }
    // With --seeds 0 nothing is drawn: a species with no catalog art and no kept portrait is not sent.
    const offline:typeof fetch=(url,init)=>String(url).startsWith(imager.url)?Promise.reject(new Error('--seeds 0: no portrait drawn')):fetch(url,init);
    const species:SpeciesSource=sp=>speciesRef(sp,{name:speciesName(scene,sp),facts:speciesFacts(items,sp),cache,imager,...seeds?{}:{fetch:offline}});
    const t0=Date.now(),got=ref?await fetchRef(ref,cache,species):null,t1=Date.now(),dir=join(values.out,id);
    mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,'scene.json'),`${JSON.stringify(scene,null,2)}\n`);
    writeFileSync(join(dir,'prompt.txt'),`${text}\n`);
    writeFileSync(join(dir,'caption.txt'),`${cap}\n`);
    const {sent,portrait,...fetched}=got??{sent:null,portrait:null};
    // The subject's art keeps its place as <image1> when it could not be had: the neutral frame stands in. With none, draw edits NEUTRAL.
    const refs=ref?[sent??NEUTRAL]:[];
    writeFileSync(join(dir,'refs.json'),`${JSON.stringify({image:sent?1:null,subject:scene.subject,...ref?{ref:{...fetched,file:sent?'ref.png':null}}:{},seeds:Array.from({length:seeds},(_,i)=>at+i)},null,2)}\n`);
    if(sent)writeFileSync(join(dir,'ref.png'),sent);
    if(portrait&&scene.subject)writeFileSync(join(dir,`species-${scene.subject.id}.png`),portrait);
    // ponytail: every seed is drawn and a human picks the one that did not copy the whole reference (README finding 5:
    // a copy is a per-seed lottery); lift when a cheap copy check separates relit copies too.
    for(let i=0;i<seeds;i++) {
      const t=Date.now(),png=await draw(imager,{prompt:textOf(i),refs,seed:at+i},{timeoutMs:600_000});
      writeFileSync(join(dir,`prompt-${i+1}.txt`),`${textOf(i)}\n`);
      writeFileSync(join(dir,`${k}-${i+1}.png`),png);
      console.log(`seed ${at+i}: ${((Date.now()-t)/1000).toFixed(1)} s -> ${join(dir,`${k}-${i+1}.png`)}`);
    }
    console.log(`ref ${((t1-t0)/1000).toFixed(2)} s (${got?.status??'none'}${got?.crop?`, cropped to ${got.crop.px.w}x${got.crop.px.h}`:''}) -> ${dir}`);
    console.log(`caption: ${cap}`);
  }
}

main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:String(error));process.exit(1);});
