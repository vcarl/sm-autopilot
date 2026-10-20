// The best moments of recorded flights (src/picture/moments.ts): `node scripts/moments.ts <runtime-dir>
// <run_id|juncture_id|latest> [--last N] [--source frames|journal] [--top K] [--events N]`. Per juncture (its last
// ended run, as the oracle picks it), the top K moments of its lately window: span, score, lead, supporting, and
// each event with its components (`--events N` keeps the N best of each moment). Reads the runtime dir only.
import {existsSync,statSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {moments,WEIGHTS,type Moment,type Scored,type Source} from '../src/picture/moments.ts';
import {scenes} from '../src/picture/oracle.ts';

const USAGE='usage: node scripts/moments.ts <runtime-dir> <run_id|juncture_id|latest> [--last N] [--source frames|journal] [--top K] [--events N]';
class Fail extends Error {}

const clock=(ms:number)=>new Date(ms).toISOString().slice(11,19)+'Z';
const n2=(v:number)=>v.toFixed(2);
const what=(e:Scored)=>`${e.type}${e.variant?`:${e.variant}`:''} [${e.category}]`;
const parts=(e:Scored)=>`${n2(e.score)} = ${e.category==='uncatalogued'?1:WEIGHTS[e.category]}×(r${n2(e.rarity)}+c${n2(e.change)}+f${n2(e.first)})×i${e.involvement}×h${n2(e.habituation)}`;
const facts=(e:Scored)=>[Object.entries(e.delta).map(([k,v])=>`${k} ${v>0?'+':''}${v}`).join(', '),e.identities.map(i=>`${i.kind}:${i.id}`).join(' '),e.note??'']
  .filter(Boolean).join(' · ');

function show(m:Moment,rank:number,events:number):string[] {
  const start=Date.parse(m.start),end=Date.parse(m.end),kept=events>0?[...m.events].sort((a,b)=>b.score-a.score).slice(0,events):m.events;
  const rest=m.events.filter(e=>!kept.includes(e));
  return [`#${rank} ${clock(start)}..${clock(end)} (${((end-start)/60_000).toFixed(1)} min) score ${n2(m.score)} (raw ${n2(m.raw)}, ${m.events.length} events)`,
    `   lead: ${what(m.lead)} ${n2(m.lead.score)}${m.lead.note?` · ${m.lead.note}`:''}`,
    `   supporting: ${m.supporting.map(e=>`${what(e)} ${n2(e.score)}`).join('; ')||'none'}`,
    `   earlier: ${m.earlier.map(e=>`${what(e)} ${n2(e.score)}`).join('; ')||'none'}`,
    `   identities: ${m.identities.map(i=>`${i.kind}:${i.id}`).join(' ')||'none'}`,
    ...m.events.filter(e=>kept.includes(e)).map(e=>`   ${clock(e.ms)}  ${parts(e)}  ${what(e)}  ${facts(e)}`),
    ...rest.length?[`   … ${rest.length} more, together ${n2(rest.reduce((s,e)=>s+e.score,0))}`]:[]];
}

async function main() {
  const {values,positionals}=parseArgs({allowPositionals:true,options:{last:{type:'string',default:'1'},source:{type:'string'},top:{type:'string',default:'3'},
    events:{type:'string',default:'0'},help:{type:'boolean',short:'h'}}});
  if(values.help){console.log(USAGE);return;}
  const [runtime,select]=positionals,last=Number(values.last),top=Number(values.top),events=Number(values.events),src=values.source;
  if(!runtime||!select||positionals.length>2||![last,top].every(v=>Number.isInteger(v)&&v>=1)||!Number.isInteger(events)||events<0||(src!==undefined&&src!=='frames'&&src!=='journal'))throw new Fail(USAGE);
  if(!existsSync(runtime)||!statSync(runtime).isDirectory())throw new Fail(`runtime dir not found: ${runtime}`);
  const source:Source|undefined=src==='frames'||src==='journal'?src:undefined;
  const found=await scenes(runtime,select,last,source);
  if(!found.length)throw new Fail(`no ended run for ${select} in ${runtime}`);
  const all=moments(runtime,found.map(s=>s.scope),source);
  for(const [i,s] of found.entries()) {
    const got=all[i]??{source:'journal',moments:[]},scoring=got.moments.reduce((n,m)=>n+m.events.length,0);
    console.log(`\n== juncture ${s.juncture_id?.slice(0,8)??'-'} run ${s.run_id.slice(0,8)} ended ${s.ended}; scope ${s.scope.start}..${s.scope.end} (${((Date.parse(s.scope.end)-Date.parse(s.scope.start))/3600_000).toFixed(2)} h); source ${got.source}${got.source==='journal'?' (approximate)':''}; ${scoring} scoring events in ${got.moments.length} moments`);
    got.moments.slice(0,top).forEach((m,i)=>console.log(show(m,i+1,events).join('\n')));
  }
}

main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:String(error));process.exit(1);});
