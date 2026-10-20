/** The activity map as two SVG documents from one model: the art (the map's geometry, which goes through the restyle) and the labels
 * (everything the reader reads, and the whole timeline), composited over the art. */
import {DONUT,KINDS,KIND_COLOURS,LANE_PAD,MUTED_HUE,SIZE,hueOf} from './constants.ts';
import {columnHeight,donutRadius} from './layout.ts';
import type {Marks} from './activity.ts';
import type {MapModel} from './model.ts';

type Size={width:number;height:number};
export type Box={x:number;y:number;w:number;h:number};
export type Circle={x:number;y:number;r:number};
export type Seg=[number,number,number,number];
type Attrs=Record<string,string|number>;
type Kit=ReturnType<typeof kit>;
interface Node extends Circle {id:string;order:number;marks:Marks;focus:boolean}

const HOUR=3_600_000,TAU=2*Math.PI,HOUR_SPACE=32,HEADER_FONT=9,NAME_FONT=12;
const BG='#0B1426',INK='#E8EEFC',MUTED='#9FB0D0',WHITE='#FFFFFF',LANE_BG='#0E182C',BAR_BG='#0C1526',DEATH='#FF4D4D',STRANDED='#FFB020',JUMP='#2A3856',NEAR='#3B4C70',RING_FILL='#16213A',RING_LINE='#8AA0C8';
const SCALED=new Set(['x','y','cx','cy','r','x1','x2','y1','y2','width','height','font-size','stroke-width']);
const esc=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const two=(n:number)=>String(n).padStart(2,'0');

/** Everything a layer draws goes through `e`, which scales the geometric attributes (and dash lengths) by width/800. */
function kit(size:Size) {
  const k=size.width/SIZE.width,u=(v:number)=>+(v*k).toFixed(2);
  const val=(n:string,v:string|number)=>typeof v==='number'?(SCALED.has(n)?u(v):v):n==='stroke-dasharray'?v.split(' ').map(x=>u(+x)).join(' '):v;
  const e=(tag:string,a:Attrs,body?:string)=>`<${tag}${Object.entries(a).map(([n,v])=>` ${n}="${val(n,v)}"`).join('')}${body===undefined?'/>':`>${body}</${tag}>`}`;
  const doc=(body:string[])=>`<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}" font-family="Arial, Helvetica, sans-serif">${body.join('')}</svg>`;
  return {u,e,doc};
}

/** Whole hours across the window; `inside` is false when the hour falls in the dead time between epochs. */
function hours(m:MapModel) {
  const out:{t:Date;x:number;inside:boolean}[]=[];
  for(let t=Math.ceil(+m.window.start/HOUR)*HOUR;t<=+m.window.end;t+=HOUR) {
    const d=new Date(t);
    out.push({t:d,x:m.axis.toX(d),inside:m.epochs.some(e=>+e.start<=t&&t<=+e.end)});
  }
  return out;
}

/** A ring sector from angle `a0` to `a1` (a full turn is the whole ring, to be filled evenodd). */
function annulus(u:(v:number)=>number,cx:number,cy:number,r0:number,r1:number,a0:number,a1:number) {
  const pt=(r:number,a:number)=>`${u(cx+r*Math.cos(a))} ${u(cy+r*Math.sin(a))}`;
  if(a1-a0>=TAU-1e-6) {
    const ring=(r:number)=>`M${u(cx+r)} ${u(cy)}A${u(r)} ${u(r)} 0 1 0 ${u(cx-r)} ${u(cy)}A${u(r)} ${u(r)} 0 1 0 ${u(cx+r)} ${u(cy)}Z`;
    return ring(r1)+ring(r0);
  }
  const big=a1-a0>Math.PI?1:0;
  return `M${pt(r1,a0)}A${u(r1)} ${u(r1)} 0 ${big} 1 ${pt(r1,a1)}L${pt(r0,a1)}A${u(r0)} ${u(r0)} 0 ${big} 0 ${pt(r0,a0)}Z`;
}

const total=(counts:Record<string,number>)=>Object.values(counts).reduce((a,b)=>a+b,0);
const ringWidth=(r:number)=>Math.max(3,r*0.4);
/** Legs with both ends on known ground; the route is drawn from these. */
const routes=(m:MapModel)=>m.activity.legs.flatMap(l=>{const a=m.placed[l.a],b=m.placed[l.b];return a?.known&&b?.known?[{leg:l,a,b}]:[];});

/** Canvas background, neighbours and jump lines, route and donuts: the map as the restyle sees it. No text. */
export function artSvg(m:MapModel,size:Size):string {
  const {u,e,doc}=kit(size),out=[e('rect',{class:'bg',x:0,y:0,width:SIZE.width,height:SIZE.height,fill:BG})];
  const drawn=new Set<string>();
  for(const id of [...m.activity.visits.map(v=>v.system),...m.neighbours])
    for(const c of m.galaxy.systems[id]?.connections??[]) {
      const a=m.placed[id],b=m.placed[c],key=id<c?`${id}\0${c}`:`${c}\0${id}`;
      if(!a?.known||!b?.known||drawn.has(key))continue;
      drawn.add(key);
      out.push(e('line',{class:'jump',x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:JUMP,'stroke-width':1}));
    }
  for(const id of m.neighbours) {const p=m.placed[id];if(p)out.push(e('circle',{class:'near',cx:p.x,cy:p.y,r:2.5,fill:NEAR}));}
  // The context underneath, muted: a thin grey route and hollow grey donuts (window.ts `focus`).
  const legs=routes(m).sort((x,y)=>Number(x.leg.focus)-Number(y.leg.focus));
  for(const {leg,a,b} of legs)out.push(e('line',{class:leg.focus?'route':'route-muted',x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:leg.focus?WHITE:MUTED_HUE,'stroke-width':leg.focus?2:1,'stroke-linecap':'round'}));
  for(const v of m.activity.visits) {
    const p=m.placed[v.system],sum=total(v.counts);
    if(!p)continue;
    if(!v.focus) {out.push(e('circle',{class:'donut-muted',cx:p.x,cy:p.y,r:DONUT.floor,fill:'none',stroke:MUTED_HUE,'stroke-width':2}));continue;}
    const r=donutRadius(sum),r0=r-ringWidth(r);
    out.push(e('path',{class:'donut',d:annulus(u,p.x,p.y,r0,r,0,TAU),'fill-rule':'evenodd',fill:RING_FILL,stroke:RING_LINE,'stroke-width':1}));
    let a=-Math.PI/2;
    for(const kind of KINDS) {
      if(!v.counts[kind])continue;
      const to=a+TAU*v.counts[kind]/sum;
      out.push(e('path',{class:'arc',d:annulus(u,p.x,p.y,r0,r,a,to),'fill-rule':'evenodd',fill:KIND_COLOURS[kind]}));
      a=to;
    }
  }
  return doc(out);
}

/** The step line of one epoch: from its left edge to its right, held until each interval starts, risers at changes. */
function stepPoints(m:MapModel,i:number):[number,number][] {
  const e=m.epochs[i],s=m.axis.spans[i];
  if(!e||!s||!e.intervals[0])return [];
  const bottom=m.rects.lane.y+m.rects.lane.h-LANE_PAD,y=(system:string)=>bottom-(e.levels[system]??0)*e.pitch;
  const cl=(x:number)=>Math.min(s.x1,Math.max(s.x0,x));
  let held=y(e.intervals[0].system);
  const pts:[number,number][]=[[s.x0,held]];
  for(const iv of e.intervals) {
    const yy=y(iv.system);
    pts.push([cl(m.axis.toX(iv.start)),held],[cl(m.axis.toX(iv.start)),yy],[cl(m.axis.toX(iv.end)),yy]);
    held=yy;
  }
  pts.push([s.x1,held]);
  return pts;
}

/** The stack of one bucket as an x range: buckets are cut per epoch, so it lies inside its epoch's span. */
function columnX(m:MapModel,b:MapModel['buckets'][number]):[number,number]|undefined {
  const e=m.epochs.find(x=>+x.end>+b.t0),s=e&&m.axis.spans[e.index];
  if(!e||!s)return undefined;
  const x0=+b.t0<=+e.start?s.x0:m.axis.toX(b.t0),x1=+b.t1>=+e.end?s.x1:m.axis.toX(b.t1);
  return x1>x0?[x0,x1]:undefined;
}

/** The timeline's opaque ground: lane and bar backgrounds, epoch tints, step lines, activity columns and hour gridlines. */
function timeline({u,e}:Kit,m:MapModel):string[] {
  const {lane,bar}=m.rects,out=[e('rect',{class:'band',x:0,y:lane.y-1,width:SIZE.width,height:SIZE.height-lane.y+1,fill:LANE_BG}), // opaque under the whole strip: margins and hour labels never sit on restyled art
    e('text',{class:'what',x:20,y:bar.y+bar.h/2+3,'text-anchor':'middle','font-size':9,'font-weight':'bold',fill:MUTED},'what'),e('rect',{class:'lane',x:lane.x,y:lane.y,width:lane.w,height:lane.h,fill:LANE_BG}),e('rect',{class:'barbg',x:bar.x,y:bar.y,width:bar.w,height:bar.h,fill:BAR_BG})];
  m.epochs.forEach((ep,i)=>{
    const s=m.axis.spans[i];
    if(s)out.push(e('rect',{class:'tint',x:s.gapX,y:lane.y,width:s.x1-s.gapX,height:lane.h,fill:ep.hue,'fill-opacity':0.18}));
    const pts=stepPoints(m,i);
    if(pts.length)out.push(e('path',{class:ep.focus?'step':'step-muted',d:`M${pts.map(([x,y])=>`${u(x)} ${u(y)}`).join('L')}`,fill:'none',stroke:ep.focus?WHITE:MUTED_HUE,'stroke-width':ep.focus?2:1,'stroke-linejoin':'miter'}));
  });
  const max=Math.max(0,...m.buckets.map(b=>total(b.counts)));
  for(const b of m.buckets) {
    const sum=total(b.counts),x=sum>0?columnX(m,b):undefined;
    if(!x)continue;
    let y=bar.y+bar.h;
    const height=columnHeight(sum,max,bar.h),segs=KINDS.flatMap(kind=>{
      const h=height*b.counts[kind]/sum;
      y-=h;
      return b.counts[kind]>0?[e('rect',{x:x[0],y,width:Math.max(0.5,x[1]-x[0]-1),height:h,fill:KIND_COLOURS[kind]})]:[];
    });
    out.push(e('g',{class:'bar'},segs.join('')));
  }
  for(const h of hours(m))if(h.inside)out.push(e('line',{class:'grid',x1:h.x,y1:lane.y,x2:h.x,y2:bar.y+bar.h,stroke:WHITE,'stroke-opacity':0.12,'stroke-width':1}));
  return out;
}

const boxDist=(b:Box,px:number,py:number)=>Math.hypot(Math.max(b.x-px,0,px-b.x-b.w),Math.max(b.y-py,0,py-b.y-b.h));
const overlap=(a:Box,b:Box)=>a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h;
const inside=(b:Box,o:Box)=>b.x>=o.x&&b.y>=o.y&&b.x+b.w<=o.x+o.w&&b.y+b.h<=o.y+o.h;
const clampTo=(b:Box,o:Box):Box=>({...b,x:Math.min(Math.max(b.x,o.x),o.x+o.w-b.w),y:Math.min(Math.max(b.y,o.y),o.y+o.h-b.h)});
/** Distance from the box to a segment, sampled every 3 px along it. */
const segDist=(b:Box,[x1,y1,x2,y2]:Seg)=>{
  const n=Math.max(1,Math.ceil(Math.hypot(x2-x1,y2-y1)/3));
  return Math.min(...Array.from({length:n+1},(_,i)=>boxDist(b,x1+(x2-x1)*i/n,y1+(y2-y1)*i/n)));
};

/** What text may not cover: circles (already grown by their margin), route segments, and rects such as the legend and the timeline. */
export interface Obstacles {circles:Circle[];segs:Seg[];avoid:Box[]}
/** Where text may go at all: the canvas, and the map rect a last resort is clipped into. */
export interface Bounds {canvas:Box;map:Box}
export interface Spot {box:Box;anchor:string;tx:number;leader?:Seg}

/** On the canvas, off the avoided rects and off boxes already `taken`. */
const free=(b:Box,taken:Box[],obs:Obstacles,bounds:Bounds)=>inside(b,bounds.canvas)&&!obs.avoid.some(a=>overlap(b,a))&&!taken.some(t=>overlap(b,t));
const clear=(b:Box,taken:Box[],obs:Obstacles,bounds:Bounds)=>free(b,taken,obs,bounds)&&obs.circles.every(c=>boxDist(b,c.x,c.y)>=c.r)&&obs.segs.every(g=>segDist(b,g)>=6);

/** A text box for `n`: right, left, above, below at r+6; else a clear spot on a ring of eight directions at 30 then 60 px with a leader;
 * else the right candidate clipped inside the map rect. Pure: the caller records the returned box as taken. */
export function placeName(n:Circle,text:string,font:number,taken:Box[],obs:Obstacles,bounds:Bounds):Spot {
  const w=0.55*font*text.length,h=font+2,g=n.r+6; // ponytail: 0.55 em per character is Arial's average; wide capitals (W, M) run to about 0.9, so an all-caps name can overrun its box. Measure with resvg if that shows
  const right:Spot={box:{x:n.x+g,y:n.y-h/2,w,h},anchor:'start',tx:n.x+g};
  const spots:Spot[]=[right,{box:{x:n.x-g-w,y:n.y-h/2,w,h},anchor:'end',tx:n.x-g},
    {box:{x:n.x-w/2,y:n.y-g-h,w,h},anchor:'middle',tx:n.x},{box:{x:n.x-w/2,y:n.y+g,w,h},anchor:'middle',tx:n.x}];
  for(const d of [30,60])for(let i=0;i<8;i++) {
    const dx=Math.round(Math.cos(i*TAU/8)*1e3)/1e3,dy=Math.round(Math.sin(i*TAU/8)*1e3)/1e3,px=n.x+dx*(n.r+d),py=n.y+dy*(n.r+d);
    const box={x:dx>0?px:dx<0?px-w:px-w/2,y:dy>0?py:dy<0?py-h:py-h/2,w,h};
    const qx=Math.min(Math.max(n.x,box.x),box.x+w),qy=Math.min(Math.max(n.y,box.y),box.y+h),len=Math.hypot(qx-n.x,qy-n.y)||1;
    spots.push({box,anchor:dx>0?'start':dx<0?'end':'middle',tx:dx>0?box.x:dx<0?box.x+w:px,leader:[qx,qy,n.x+(qx-n.x)/len*n.r,n.y+(qy-n.y)/len*n.r]});
  }
  const found=spots.find(s=>clear(s.box,taken,obs,bounds));
  if(found)return found;
  const box=clampTo(right.box,bounds.map);
  return {box,anchor:right.anchor,tx:right.tx+box.x-right.box.x};
}

interface Scene {nodes:Node[];legs:{leg:MapModel['activity']['legs'][number];s:Seg}[];obs:Obstacles;bounds:Bounds}
const badgeAt=(n:Circle):Circle=>({x:n.x-(n.r+3)*0.7,y:n.y-(n.r+3)*0.7,r:6.5});
/** Mark glyphs sit on the donut's lower diagonals: a death to the right, a stranding to the left. */
const markAt=(n:Circle,side:1|-1):Circle=>({x:n.x+side*(n.r+3)*0.7,y:n.y+(n.r+3)*0.7,r:5});
const markCircles=(n:Node)=>[...n.marks.deaths?[markAt(n,1)]:[],...n.marks.stranded?[markAt(n,-1)]:[]].map(c=>({...c,r:c.r+2}));
function scene(m:MapModel):Scene {
  const nodes=m.activity.visits.flatMap(v=>{const p=m.placed[v.system];return p?[{id:v.system,x:p.x,y:p.y,r:v.focus?donutRadius(total(v.counts)):DONUT.floor,order:v.order,marks:v.marks,focus:v.focus}]:[];});
  const legs=routes(m).map(({leg,a,b}):{leg:typeof leg;s:Seg}=>({leg,s:[a.x,a.y,b.x,b.y]}));
  const {map,legend,lane,bar}=m.rects;
  return {nodes,legs,obs:{circles:[...nodes.map(n=>({...n,r:n.r+2})),...nodes.map(n=>{const b=badgeAt(n);return {...b,r:b.r+1};}),...nodes.flatMap(markCircles)],segs:legs.map(l=>l.s),avoid:[legend,lane,bar]},
    bounds:{canvas:{x:0,y:0,w:SIZE.width,h:SIZE.height},map}};
}

const halo:Attrs={stroke:BG,'stroke-width':3,'paint-order':'stroke','stroke-linejoin':'round'};

/** A 6 px red ring struck through by a diagonal: a death. */
const deathGlyph=({e}:Kit,x:number,y:number,cls:string)=>[e('circle',{class:cls,cx:x,cy:y,r:3,fill:'none',stroke:DEATH,'stroke-width':1.5}),
  e('line',{class:cls,x1:x-3.5,y1:y+3.5,x2:x+3.5,y2:y-3.5,stroke:DEATH,'stroke-width':1.5})];
/** A hollow amber triangle: a stranding. */
const strandedGlyph=({e,u}:Kit,x:number,y:number,cls:string)=>[e('path',{class:cls,d:`M${u(x)} ${u(y-4)}L${u(x+4)} ${u(y+3)}L${u(x-4)} ${u(y+3)}Z`,fill:'none',stroke:STRANDED,'stroke-width':1.5,'stroke-linejoin':'round'})];

/** The title and the legend: five kind rows, the route, and a swatch per epoch. */
function legend(k:Kit,m:MapModel):string[] {
  const {e}=k,lg=m.rects.legend,row=(i:number)=>lg.y+i*16,out=[e('text',{class:'title',x:16,y:22,'font-size':14,'font-weight':'bold',fill:INK},esc(m.title))];
  KINDS.forEach((kind,i)=>out.push(e('rect',{x:lg.x,y:row(i)+1,width:10,height:10,fill:KIND_COLOURS[kind]}),e('text',{x:lg.x+16,y:row(i)+10,'font-size':11,fill:INK},kind)));
  out.push(e('line',{x1:lg.x,y1:row(5)+6,x2:lg.x+10,y2:row(5)+6,stroke:WHITE,'stroke-width':2}),e('text',{x:lg.x+16,y:row(5)+10,'font-size':11,fill:INK},'route'));
  let next=6;
  for(const [word,glyph,present] of [['death',deathGlyph,m.activity.visits.some(v=>v.marks.deaths)],['stranded',strandedGlyph,m.activity.visits.some(v=>v.marks.stranded)]] as const) {
    if(!present)continue;
    out.push(...glyph(k,lg.x+5,row(next)+6,'key'),e('text',{x:lg.x+16,y:row(next)+10,'font-size':11,fill:INK},word));
    next++;
  }
  if(m.activity.visits.some(v=>!v.focus)) {
    out.push(e('circle',{cx:lg.x+5,cy:row(next)+6,r:4,fill:'none',stroke:MUTED_HUE,'stroke-width':2}),e('text',{x:lg.x+16,y:row(next)+10,'font-size':11,fill:MUTED},'earlier runs'));
    next++;
  }
  out.push(e('text',{x:lg.x,y:row(next)+10,'font-size':11,fill:MUTED},'epochs'));
  m.epochs.forEach((ep,i)=>out.push(e('rect',{x:lg.x+i*Math.min(12,lg.w/m.epochs.length),y:row(next+1)+2,width:8,height:8,fill:ep.hue})));
  return out;
}

/** A placed label and, when it needed one, its leader. */
function drawSpot({e}:Kit,s:Spot,text:string,font:number,cls:string,extra:Attrs):string[] {
  const out=s.leader?[e('line',{class:'leader',x1:s.leader[0],y1:s.leader[1],x2:s.leader[2],y2:s.leader[3],stroke:MUTED,'stroke-width':1})]:[];
  out.push(e('text',{class:cls,x:s.tx,y:s.box.y+s.box.h-3,'text-anchor':s.anchor,'font-size':font,fill:WHITE,...halo,...extra},esc(text)));
  return out;
}

/** System names with halo and leaders, plus the `you are here` ring and hint wherever the pilot is. Also answers the boxes taken. */
function names(k:Kit,m:MapModel,sc:Scene):{svg:string[];taken:Box[]} {
  const svg:string[]=[],taken:Box[]=[];
  const put=(n:Circle,text:string,font:number,cls:string,extra:Attrs)=>{
    const s=placeName(n,text,font,taken,sc.obs,sc.bounds);
    taken.push(s.box);
    svg.push(...drawSpot(k,s,text,font,cls,extra));
  };
  // The focus's names first, so they get the best spots; the context's after, smaller and grey.
  for(const n of sc.nodes.filter(x=>x.focus))put(n,m.galaxy.systems[n.id]?.name??n.id,NAME_FONT,'name',{'font-weight':'bold'});
  for(const n of sc.nodes.filter(x=>!x.focus))put(n,m.galaxy.systems[n.id]?.name??n.id,10,'name-muted',{fill:MUTED_HUE});
  const here=sc.nodes.find(n=>n.id===m.activity.current.system);
  if(here) {
    svg.push(k.e('circle',{class:'here',cx:here.x,cy:here.y,r:here.r+4,fill:'none',stroke:WHITE,'stroke-width':1.5}));
    put(here,'you are here',10,'hint',{'font-style':'italic'});
  }
  return {svg,taken};
}

/** One glyph per kind of mark beside a donut, with a count only when there is more than one. */
function marks(k:Kit,sc:Scene):string[] {
  return sc.nodes.flatMap(n=>([[n.marks.deaths,1,deathGlyph,DEATH],[n.marks.stranded,-1,strandedGlyph,STRANDED]] as const).flatMap(([count,side,glyph,colour])=>{
    if(!count)return [];
    const c=markAt(n,side);
    return [...glyph(k,c.x,c.y,'mark'),...count>1?[k.e('text',{class:'markn',x:c.x+side*6,y:c.y+3,'text-anchor':side>0?'start':'end','font-size':8,'font-weight':'bold',fill:colour,...halo,'stroke-width':2},String(count))]:[]];
  }));
}

/** Visit-order badges filled with the hue of the epoch each system spent most time in. */
function badges({e}:Kit,m:MapModel,sc:Scene):string[] {
  return sc.nodes.filter(n=>n.focus).flatMap(n=>{
    const b=badgeAt(n);
    return [e('circle',{class:'badge',cx:b.x,cy:b.y,r:b.r,fill:m.badgeHue[n.id]??hueOf(0),stroke:BG,'stroke-width':1}),
      e('text',{class:'bnum',x:b.x,y:b.y+3,'text-anchor':'middle','font-size':8,'font-weight':'bold',fill:BG},String(n.order))];
  });
}

const REACH=40,CLEAR=16;
/** `xN` for the heaviest leg: at the midpoint, moved perpendicular by the smallest offset (at most 40 px) that leaves it 16 px clear of other
 * routes, nodes and badges; else the best-scoring spot inside that reach. A spot nearer to another leg or node than to its own leg is never used. */
function legMark({e}:Kit,m:MapModel,sc:Scene,taken:Box[]):string[] {
  const top=m.activity.heaviest,hv=top&&top.trips>1?sc.legs.find(g=>g.leg===top):undefined;
  if(!hv||!top)return [];
  const [ax,ay,bx,by]=hv.s,len=Math.hypot(bx-ax,by-ay)||1,nx=-(by-ay)/len,ny=(bx-ax)/len,text=`x${top.trips}`,w=0.55*NAME_FONT*text.length,h=NAME_FONT+2;
  const at=(o:number):Box=>({x:(ax+bx)/2+o*nx-w/2,y:(ay+by)/2+o*ny-h/2,w,h});
  const ends=new Set([hv.leg.a,hv.leg.b]),rivals=sc.legs.filter(g=>g!==hv),badges=sc.nodes.map(badgeAt);
  /** Clearance from everything else, or -1 for a spot that is taken, off its leg, or nearer to another leg or node than to its own leg. */
  const score=(box:Box)=>{
    const own=segDist(box,hv.s);
    if(!free(box,taken,sc.obs,sc.bounds)||own<3)return -1;
    const legs=rivals.map(g=>segDist(box,g.s)),far=sc.nodes.filter(n=>!ends.has(n.id)).map(n=>boxDist(box,n.x,n.y));
    if(Math.min(...legs,...far)<own)return -1;
    return Math.min(...legs,...sc.nodes.map(n=>boxDist(box,n.x,n.y)-n.r),...badges.map(b=>boxDist(box,b.x,b.y)-b.r));
  };
  let best:{box:Box;score:number}|undefined;
  for(let o=14;o<=REACH&&(best?.score??-1)<CLEAR;o+=2)for(const side of [1,-1]) {
    const box=at(side*o),got=score(box);
    if(got>=0&&(!best||got>best.score))best={box,score:got};
  }
  const box=best?.box??clampTo(at(14),sc.bounds.map);
  return [e('text',{class:'leg',x:box.x+w/2,y:box.y+h-3,'text-anchor':'middle','font-size':NAME_FONT,'font-weight':'bold',fill:WHITE,...halo},text)];
}

/** Per epoch: the dotted separator, the vertical `k systems` header of a dense epoch, and the level numbers in the gap. */
function epochLabels({e,u}:Kit,m:MapModel):string[] {
  const lane=m.rects.lane,out:string[]=[],order=(system:string)=>m.activity.visits.find(v=>v.system===system)?.order;
  m.epochs.forEach((ep,i)=>{
    const s=m.axis.spans[i];
    if(!s)return;
    out.push(e('line',{class:'sep',x1:s.gapX,y1:lane.y,x2:s.gapX,y2:lane.y+lane.h,stroke:ep.hue,'stroke-width':1,'stroke-dasharray':'2 3'}));
    let floor=lane.y;
    if(ep.dense) {
      const text=`${ep.systems.length} systems`,x=s.x0-3,y=lane.y+2;
      out.push(e('text',{class:'hdr',x,y,transform:`rotate(-90 ${u(x)} ${u(y)})`,'text-anchor':'end','font-size':HEADER_FONT,fill:ep.hue,...halo,'stroke-width':2},text));
      floor=y+0.55*HEADER_FONT*text.length+2;
    }
    for(const l of m.labels[i]??[]) {
      const n=order(l.system);
      if(l.shown&&n!==undefined&&l.y-l.font/2>=floor)out.push(e('text',{class:'lvl',x:s.x0-3,y:l.y+l.font*0.35,'text-anchor':'end','font-size':l.font,'font-weight':'bold',fill:ep.hue,...halo,'stroke-width':2},String(n)));
    }
  });
  return out;
}

/** `HH:MMZ` under the timeline at whole hours, skipping an hour inside a gap and one too close to the last drawn. */
function hourLabels({e}:Kit,m:MapModel):string[] {
  const y=m.rects.bar.y+m.rects.bar.h+10;
  let last=-Infinity;
  return hours(m).flatMap(h=>{
    if(!h.inside||h.x-last<HOUR_SPACE)return [];
    last=h.x;
    return [e('text',{class:'hour',x:h.x,y,'text-anchor':'middle','font-size':9,fill:MUTED},`${two(h.t.getUTCHours())}:${two(h.t.getUTCMinutes())}Z`)];
  });
}

/** The timeline ground, then title, legend, names, badges, `xN`, epoch and hour labels. Transparent where nothing is drawn. */
export function labelsSvg(m:MapModel,size:Size):string {
  const k=kit(size),sc=scene(m),named=names(k,m,sc);
  return k.doc([...timeline(k,m),...legend(k,m),...named.svg,...badges(k,m,sc),...marks(k,sc),...legMark(k,m,sc,named.taken),...epochLabels(k,m),...hourLabels(k,m)]);
}
