/** The two SVG layers drawn from one model (`svg.ts`). */
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {markPlace} from '../play/places.ts';
import {journalRun} from '../run-record.ts';
import {MUTED_HUE,SIZE} from './constants.ts';
import {FLIGHT_JUNCTURE,flightRuntime} from '../test-support/flight-runtime.ts';
import type {Galaxy} from './galaxy.ts';
import {buildModel,type MapModel} from './model.ts';
import {artSvg,labelsSvg,placeName,type Bounds,type Box,type Obstacles} from './svg.ts';

const at=(h:number,m=0)=>`2026-10-16T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00.000Z`;
const sys=(id:string,x:number,y:number,connections:string[],name=id.toUpperCase())=>[id,{id,name,x,y,connections}] as const;
const galaxy:Galaxy={fetched_at:'',systems:Object.fromEntries([sys('a',0,0,['b']),sys('b',100,20,['a','c']),sys('c',160,90,['b','d']),sys('d',200,40,['c'])])};
const count=(s:string,re:RegExp)=>(s.match(re)??[]).length;
const jump=(dir:string,run_id:string,when:string,id:string)=>journalRun(dir,{run_id,at:when,tool:'spacemolt',action:'jump',params:{id},ok:true,summary:'x'},'command');
async function withRuntime<T>(fill:(dir:string)=>void,run:(dir:string)=>Promise<T>):Promise<T> {
  const dir=join(mkdtempSync(join(tmpdir(),'spacemolt-svg-')),'runtime');
  mkdirSync(dir,{recursive:true});
  try{fill(dir);return await run(dir);}finally{rmSync(dir,{recursive:true,force:true});}
}

/** Two epochs a day apart: a and b in the morning (a fight, a trade, a dock, jumps there and back), then c at 15:00. */
const sample=(g:Galaxy=galaxy):Promise<MapModel>=>withRuntime(dir=>{
  journalRun(dir,{phase:'started',run_id:'r1',at:at(8),started:at(8),start_state:{system:'a'}},'run');
  journalRun(dir,{run_id:'r1',at:at(8,10),tool:'spacemolt',action:'dock',ok:true,summary:'x'},'command');
  journalRun(dir,{run_id:'r1',at:at(8,15),side:'sell'},'trade');
  journalRun(dir,{run_id:'r1',at:at(8,20),push:'battle_ended'},'push');
  jump(dir,'r1',at(8,30),'b');jump(dir,'r1',at(8,50),'a');jump(dir,'r1',at(8,55),'b');
  journalRun(dir,{phase:'ended',run_id:'r1',started:at(8),at:at(9),outcome:'done',end_state:{system:'b'}},'run');
  journalRun(dir,{phase:'started',run_id:'r2',at:at(15),started:at(15),start_state:{system:'c'}},'run');
  journalRun(dir,{phase:'ended',run_id:'r2',started:at(15),at:at(16),outcome:'done',end_state:{system:'c'}},'run');
},dir=>buildModel(dir,{galaxy:g,pilot:'Kvothe'}));

/** One run marching through `ids` three minutes apart, all on one point of the map when `stacked`. */
const march=(ids:string[],stacked:boolean)=>withRuntime(dir=>{
  journalRun(dir,{phase:'started',run_id:'r1',at:at(8),started:at(8),start_state:{system:ids[0]??''}},'run');
  ids.slice(1).forEach((id,i)=>jump(dir,'r1',at(8,3*(i+1)),id));
  journalRun(dir,{phase:'ended',run_id:'r1',started:at(8),at:at(8,51),outcome:'done',end_state:{system:ids.at(-1)??''}},'run');
},dir=>buildModel(dir,{galaxy:{fetched_at:'',systems:Object.fromEntries(ids.map((id,i)=>sys(id,stacked?0:i*10,stacked?0:(i%3)*12,ids.filter(o=>o!==id&&Math.abs(+o.slice(1)-i)===1),id.toUpperCase())))}}));

test('artSvg has one donut per visited system and no text, and none of the timeline',async()=>{
  const m=await sample(),svg=artSvg(m,SIZE);
  assert.equal(m.activity.visits.length,3);
  assert.equal(count(svg,/<path class="donut/g),m.activity.visits.length);
  assert.ok(!/<text/.test(svg));
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.equal(count(svg,/class="(tint|step|bar|grid|lane|lvl)"/g),0);
  assert.equal(count(svg,/class="near"/g),m.neighbours.length);
});
test('labelsSvg has one badge per visited system filled with its epoch hue and one level label per shown level',async()=>{
  const m=await sample(),svg=labelsSvg(m,SIZE),visits=m.activity.visits;
  assert.equal(count(svg,/class="badge"/g),visits.length);
  const fills=[...svg.matchAll(/<circle class="badge"[^>]*fill="(#[0-9A-Fa-f]{6})"/g)].map(x=>x[1]);
  assert.deepEqual(fills,visits.map(v=>m.badgeHue[v.system]));
  assert.equal(count(svg,/class="lvl"/g),m.labels.flat().filter(l=>l.shown).length);
  assert.equal(count(svg,/class="name"/g),visits.length);
  assert.ok(svg.includes('Kvothe · last 2 runs'));
  assert.ok(svg.includes('you are here')); // the pilot ends in c, not badge 1
  assert.ok(svg.includes('>x3<')); // a-b was crossed three times
  assert.ok(!/<rect[^>]*class="bg"/.test(svg));
});
test('labelsSvg carries the whole timeline: lane, tints, step lines, columns, gridlines',async()=>{
  const m=await sample(),svg=labelsSvg(m,SIZE);
  assert.equal(count(svg,/class="lane"/g),1);
  assert.equal(count(svg,/class="tint"/g),m.epochs.length);
  assert.equal(count(svg,/class="step"/g),m.epochs.length);
  assert.equal(count(svg,/class="bar"/g),m.buckets.filter(b=>Object.values(b.counts).some(n=>n>0)).length);
  assert.equal(count(svg,/class="grid"/g),4);
  assert.equal(count(svg,/class="sep"/g),m.epochs.length);
});
test('labelsSvg omits an hour label whose centre lands in a gap',async()=>{
  const m=await sample(),svg=labelsSvg(m,SIZE);
  assert.equal(m.epochs.length,2);
  const hours=[...svg.matchAll(/class="hour"[^>]*>([^<]*)</g)].map(x=>x[1]);
  // 10:00Z to 14:00Z are dead time; 15:00Z is 24 px after 09:00Z, closer than the 32 px label spacing
  assert.deepEqual(hours,['08:00Z','09:00Z','16:00Z']);
  assert.ok(!svg.includes('12:00Z'));
});
test('labelsSvg keeps every level label inside the lane',async()=>{
  const m=await sample(),top=m.rects.lane.y;
  m.labels[0]![0]!.y=top+1; // a label whose box would cross the lane top
  const svg=labelsSvg(m,SIZE);
  assert.equal(count(svg,/class="lvl"/g),m.labels.flat().filter(l=>l.shown).length-1);
});
test('a dense epoch draws a vertical `k systems` header and keeps its numbers below it',async()=>{
  const ids=Array.from({length:16},(_,i)=>`s${i}`),m=await march(ids,false),lane=m.rects.lane;
  assert.equal(m.epochs.length,1);
  assert.equal(m.epochs[0]?.dense,true);
  const svg=labelsSvg(m,SIZE);
  assert.equal(count(svg,/class="hdr"/g),1);
  assert.match(svg,/class="hdr"[^>]*transform="rotate\(-90 [\d.]+ [\d.]+\)"[^>]*font-size="9"[^>]*>16 systems</);
  const lvl=[...svg.matchAll(/class="lvl"[^>]*\by="([\d.]+)"[^>]*font-size="([\d.]+)"/g)].map(x=>[Number(x[1]),Number(x[2])] as const);
  assert.ok(lvl.length>0&&lvl.length<16);
  const floor=lane.y+2+0.55*9*'16 systems'.length;
  assert.ok(lvl.every(([y,font])=>y-font/2>=floor));
});
test('svg scales with size',async()=>{
  const m=await sample(),big={width:1024,height:768};
  assert.ok(artSvg(m,big).includes('viewBox="0 0 1024 768"'));
  assert.ok(artSvg(m,SIZE).includes('viewBox="0 0 800 600"'));
  const cx=(svg:string)=>Number(/class="near" cx="([\d.]+)"/.exec(svg)?.[1]);
  assert.equal(cx(artSvg(m,big)),+(cx(artSvg(m,SIZE))*1.28).toFixed(2));
  const tintX=(svg:string)=>Number(/class="tint"[^>]*\bx="([\d.]+)"/.exec(svg)?.[1]);
  assert.equal(tintX(labelsSvg(m,SIZE)),m.axis.spans[0]!.gapX);
  assert.equal(tintX(labelsSvg(m,big)),+(tintX(labelsSvg(m,SIZE))*1.28).toFixed(2));
  assert.ok(labelsSvg(m,big).includes('viewBox="0 0 1024 768"'));
  assert.ok(/stroke-dasharray="2.56 3.84"/.test(labelsSvg(m,big)));
});
test('names are escaped, and a crowded node gets a leader',async()=>{
  const odd:Galaxy={fetched_at:'',systems:{...galaxy.systems,a:{...galaxy.systems.a!,name:'A&B <C>'}}};
  const svg=labelsSvg(await sample(odd),SIZE);
  assert.ok(svg.includes('>A&amp;B &lt;C&gt;<'));
  assert.ok(!svg.includes('A&B'));
  const stacked=labelsSvg(await march(['s0','s1','s2','s3','s4'],true),SIZE);
  assert.equal(count(stacked,/class="name"/g),5);
  assert.ok(count(stacked,/class="leader"/g)>=1);
});

const bounds:Bounds={canvas:{x:0,y:0,w:800,h:600},map:{x:16,y:36,w:614,h:364}};
const none:Obstacles={circles:[],segs:[],avoid:[]};
const node={x:300,y:200,r:7},text='Name',w=0.55*12*text.length,g=node.r+6;
const right:Box={x:node.x+g,y:node.y-7,w,h:14},left:Box={x:node.x-g-w,y:node.y-7,w,h:14};
const above:Box={x:node.x-w/2,y:node.y-g-14,w,h:14},below:Box={x:node.x-w/2,y:node.y+g,w,h:14};
const hit=(a:Box,b:Box)=>a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h;

test('placeName tries right, left, above, then below',()=>{
  const pick=(taken:Box[])=>placeName(node,text,12,taken,none,bounds);
  assert.deepEqual([pick([]).box,pick([]).anchor,pick([]).leader],[right,'start',undefined]);
  assert.deepEqual(pick([right]).box,left);
  assert.equal(pick([right]).anchor,'end');
  assert.deepEqual(pick([right,left]).box,above);
  assert.deepEqual(pick([right,left,above]).box,below);
  assert.equal(pick([right,left,above,below]).leader!==undefined,true);
});
test('placeName rings with a leader when crowded, clear of every obstacle',()=>{
  const taken=[right,left,above,below],obs:Obstacles={circles:[{x:340,y:230,r:9}],segs:[[250,150,350,150]],avoid:[]};
  const s=placeName(node,text,12,taken,obs,bounds);
  assert.ok(s.leader);
  assert.ok(taken.every(t=>!hit(s.box,t)));
  assert.ok(Math.min(Math.abs(s.box.y+s.box.h-150),Math.abs(s.box.y-150))>=6||s.box.x>350||s.box.x+s.box.w<250);
  assert.ok(Math.hypot(Math.max(s.box.x-340,0,340-s.box.x-s.box.w),Math.max(s.box.y-230,0,230-s.box.y-s.box.h))>=9);
  const [qx,qy,rx,ry]=s.leader;
  assert.ok(Math.abs(Math.hypot(rx-node.x,ry-node.y)-node.r)<1e-6); // ends on the node ring
  assert.ok(qx>=s.box.x-1e-6&&qx<=s.box.x+s.box.w+1e-6&&qy>=s.box.y-1e-6&&qy<=s.box.y+s.box.h+1e-6); // starts on the box
});
test('placeName never leaves the canvas or enters an avoided rect, and clips as a last resort',()=>{
  const edge={x:30,y:200,r:7}; // left of it would run off the canvas
  assert.deepEqual(placeName(edge,text,12,[{x:edge.x+g,y:193,w,h:14}],none,bounds).box,{x:edge.x-w/2,y:edge.y-g-14,w,h:14});
  const legend:Box={x:300,y:150,w:200,h:100};
  const s=placeName(node,text,12,[],{...none,avoid:[legend]},bounds);
  assert.ok(!hit(s.box,legend));
  const rim={x:629,y:200,r:7},wall:Box={x:0,y:0,w:800,h:600},pinned=placeName(rim,text,12,[wall],none,bounds);
  assert.ok(pinned.box.x>=16&&pinned.box.x+pinned.box.w<=630&&pinned.box.y>=36&&pinned.box.y+pinned.box.h<=400);
  assert.equal(pinned.leader,undefined);
});

test('the heaviest leg\'s xN sits beside its own leg, nearer to it than to any other leg or node',async()=>{
  const hub:Galaxy={fetched_at:'',systems:Object.fromEntries([sys('h',0,0,['p','q','r']),sys('p',100,0,['h']),sys('q',-50,87,['h']),sys('r',-50,-87,['h'])])};
  const m=await withRuntime(dir=>{
    journalRun(dir,{phase:'started',run_id:'r1',at:at(8),started:at(8),start_state:{system:'h'}},'run');
    ['p','h','p','h','q','h','r'].forEach((id,i)=>jump(dir,'r1',at(8,10*(i+1)),id));
    journalRun(dir,{phase:'ended',run_id:'r1',started:at(8),at:at(9,30),outcome:'done',end_state:{system:'r'}},'run');
  },dir=>buildModel(dir,{galaxy:hub}));
  assert.deepEqual(m.activity.heaviest,{a:'h',b:'p',trips:4,focus:true});
  const tag=/class="leg" x="([\d.]+)" y="([\d.]+)"/.exec(labelsSvg(m,SIZE));
  assert.ok(tag);
  const [x,y]=[Number(tag[1]),Number(tag[2])-4],d=(px:number,py:number)=>Math.hypot(px-x,py-y),mid=(a:string,b:string)=>d((m.placed[a]!.x+m.placed[b]!.x)/2,(m.placed[a]!.y+m.placed[b]!.y)/2);
  const own=mid('h','p');
  assert.ok(own<=40+10,`tag ${own} px from its leg's midpoint`);
  for(const other of [mid('h','q'),mid('h','r'),...['h','p','q','r'].map(id=>d(m.placed[id]!.x,m.placed[id]!.y))])assert.ok(own<other);
});

test('hour labels sit below the bar, with the `what` label beside it, on an opaque band under the whole timeline',async()=>{
  const m=await sample(),svg=labelsSvg(m,SIZE),{bar}=m.rects;
  const ys=[...svg.matchAll(/class="hour"[^>]*\by="([\d.]+)"/g)].map(x=>Number(x[1]));
  assert.ok(ys.length>0&&ys.every(y=>y-9*0.75>=bar.y+bar.h)); // the glyph tops clear the bar
  assert.match(svg,/<rect class="band" x="0" y="420" width="800" height="180" fill="#0E182C"\/>/);
  assert.ok(svg.indexOf('class="band"')<svg.indexOf('class="lane"'));
  const what=/class="what" x="20" y="([\d.]+)"[^>]*font-size="9"[^>]*>what</.exec(svg);
  assert.ok(what);
  assert.equal(Number(what[1]),bar.y+bar.h/2+3);
});
test('a bucket straddling an epoch seam is cut at the seam, never a hairline',async()=>{
  const m=await withRuntime(dir=>{
    journalRun(dir,{phase:'started',run_id:'r1',at:at(8),started:at(8),start_state:{system:'a'}},'run');
    journalRun(dir,{run_id:'r1',at:at(8,45),side:'sell'},'trade'); // in the 20 minutes that used to straddle 08:50
    jump(dir,'r1',at(8,50),'b');
    journalRun(dir,{run_id:'r1',at:at(8,55),side:'sell'},'trade');
    journalRun(dir,{run_id:'r1',at:at(9,35),side:'sell'},'trade'); // exactly at the end of the window
    journalRun(dir,{phase:'ended',run_id:'r1',started:at(8),at:at(9,35),outcome:'done',end_state:{system:'b'}},'run');
  },dir=>buildModel(dir,{galaxy}));
  assert.equal(m.epochs.length,2);
  assert.equal(+m.epochs[0]!.end,+m.epochs[1]!.start);
  assert.equal(m.buckets.reduce((n,b)=>n+b.counts.traded,0),3); // every trade, once
  const widths=[...labelsSvg(m,SIZE).matchAll(/<g class="bar">(.*?)<\/g>/g)].flatMap(g=>[...g[1]!.matchAll(/width="([\d.]+)"/g)].map(x=>Number(x[1])));
  assert.ok(widths.length>=3);
  assert.ok(widths.every(w=>w>=2),`narrowest column ${Math.min(...widths)} px`);
  const xs=[...labelsSvg(m,SIZE).matchAll(/<g class="bar"><rect x="([\d.]+)"/g)].map(x=>Number(x[1])),second=m.axis.spans[1]!;
  assert.ok(Math.min(...xs.filter(x=>x>=second.gapX))>=second.x0-0.01,'a later-epoch column starts in its gap');
  assert.ok(xs.some(x=>Math.abs(x-second.x0)<0.01));
});
test('a death draws a mark beside its donut and a legend row, and the pilot after it is where the respawn is',async()=>{
  const m=await withRuntime(dir=>{
    markPlace(dir,'base1','b');
    journalRun(dir,{phase:'started',run_id:'r1',at:at(8),started:at(8),start_state:{system:'a'}},'run');
    journalRun(dir,{run_id:'r1',at:at(8,10),ship_lost:'Cobble',respawn_base:'base1'},'death');
    journalRun(dir,{run_id:'r1',at:at(8,20),side:'sell'},'trade');
    journalRun(dir,{phase:'ended',run_id:'r1',started:at(8),at:at(9),outcome:'done',end_state:{system:'b'}},'run');
  },dir=>buildModel(dir,{galaxy}));
  const [a,b]=m.activity.visits;
  assert.equal(a?.marks.deaths,1);
  assert.equal(b?.counts.traded,1); // after the respawn, attributed to b
  const svg=labelsSvg(m,SIZE);
  assert.equal(count(svg,/class="mark"/g),2); // the ring and its slash
  assert.equal(count(svg,/class="key"/g),2);
  assert.ok(svg.includes('>death<'));
  assert.ok(!svg.includes('>stranded<'));
  assert.equal(count(svg,/class="markn"/g),0); // one death: no count
  assert.equal(count(labelsSvg(await sample(),SIZE),/class="(mark|key|markn)"/g),0);
});
test('a stranding is a hollow triangle, and a count shows only above one',async()=>{
  const m=await withRuntime(dir=>{
    journalRun(dir,{phase:'started',run_id:'r1',at:at(8),started:at(8),start_state:{system:'a'}},'run');
    for(const n of [10,20,30])journalRun(dir,{run_id:'r1',at:at(8,n),system:'a'},'stranded');
    journalRun(dir,{phase:'ended',run_id:'r1',started:at(8),at:at(9),outcome:'done',end_state:{system:'a'}},'run');
  },dir=>buildModel(dir,{galaxy}));
  const svg=labelsSvg(m,SIZE);
  assert.equal(m.activity.visits[0]?.marks.stranded,3);
  assert.equal(count(svg,/<path class="mark"[^>]*fill="none"/g),1);
  assert.match(svg,/class="markn"[^>]*>3</);
  assert.ok(svg.includes('>stranded<'));
  assert.ok(svg.includes('you are here')); // the pilot is still at badge 1
});
test('a single epoch of no length draws without NaN',async()=>{
  const m=await withRuntime(dir=>{
    journalRun(dir,{phase:'started',run_id:'r1',at:at(8),started:at(8),start_state:{system:'a'}},'run');
    journalRun(dir,{phase:'ended',run_id:'r1',started:at(8),at:at(8),outcome:'done',end_state:{system:'a'}},'run');
  },dir=>buildModel(dir,{galaxy}));
  assert.equal(m.epochs.length,1);
  assert.equal(+m.epochs[0]!.start,+m.epochs[0]!.end);
  for(const svg of [labelsSvg(m,SIZE),artSvg(m,SIZE)])assert.ok(!/NaN|Infinity/.test(svg));
  assert.equal(count(labelsSvg(m,SIZE),/class="step"/g),1);
});

// Spec "Per-juncture selection" (built 2026-10-19). Coordinator's rulings: the context is on; badges count the focus's first visits only.
test('a juncture\'s map: the focus in colour and numbered, the context underneath muted, counts the focus\'s own',async()=>{
  const dir=flightRuntime(),m=await buildModel(dir,{juncture:FLIGHT_JUNCTURE,pilot:'Kvothe'});
  assert.equal(m.title,'Kvothe · flight 08:45Z · 19 Oct 08:45–10:10Z');
  assert.deepEqual(m.activity.visits.map(v=>[v.system,v.focus,v.order,v.counts.docked]),[['sol',true,1,0],['rigel',false,0,0],['vega',true,2,0]]); // the context's dock is not counted
  assert.deepEqual(m.activity.legs.map(l=>[l.a,l.b,l.focus,l.trips]),[['rigel','sol',false,0],['sol','vega',true,1]]);
  assert.deepEqual(m.epochs.map(e=>[e.focus,e.hue===MUTED_HUE]),[[false,true],[true,false]]);
  assert.deepEqual(Object.keys(m.badgeHue).sort(),['sol','vega']);
  const art=artSvg(m,SIZE),labels=labelsSvg(m,SIZE);
  assert.equal((art.match(/class="donut-muted"/g)??[]).length,1);assert.equal((art.match(/class="route-muted"/g)??[]).length,1);
  assert.equal((art.match(/class="route"/g)??[]).length,1);
  assert.equal((labels.match(/class="badge"/g)??[]).length,2);
  assert.match(labels,/class="name-muted"[^>]*>Rigel</);assert.match(labels,/class="step-muted"/);assert.match(labels,/earlier runs/);
  // the last N runs keep every run in focus, as before
  const all=await buildModel(dir,{runs:3});
  assert.ok(all.activity.visits.every(v=>v.focus));assert.equal(all.activity.visits.find(v=>v.system==='sol')?.counts.docked,1);
  assert.doesNotMatch(artSvg(all,SIZE)+labelsSvg(all,SIZE),/muted|earlier runs/);
});
