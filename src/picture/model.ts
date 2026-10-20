/** One computed model of the activity map: window, geometry, epochs and timeline layout. `svg.ts` draws it. */
import {GAP,RUNS,hueOf} from './constants.ts';
import {replay,type Activity} from './activity.ts';
import {assignLevels,focusedEpochs,type Epoch} from './epochs.ts';
import {fit,loadGalaxy,neighbours,type Galaxy,type Placed} from './galaxy.ts';
import {buckets,fitLabels,timeAxis,type Axis,type Bucket,type LevelLabel} from './layout.ts';
import {readWindow,type Selector,type Window} from './window.ts';

export type Rect={x:number;y:number;w:number;h:number};
export interface MapModel {title:string;window:Window;activity:Activity;epochs:Epoch[];galaxy:Galaxy;placed:Record<string,Placed>;neighbours:string[];
  unknownSystems:string[];axis:Axis;labels:LevelLabel[][];buckets:Bucket[];badgeHue:Record<string,string>;rects:{map:Rect;legend:Rect;lane:Rect;bar:Rect}}

const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],two=(n:number)=>String(n).padStart(2,'0');
const day=(d:Date)=>`${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`,hm=(d:Date)=>`${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
/** `16 Oct 08:16–21:30Z` inside one UTC day, `16 Oct 11:39–17 Oct 00:28Z` across two. */
const span=(a:Date,b:Date)=>day(a)===day(b)?`${day(a)} ${hm(a)}–${hm(b)}Z`:`${day(a)} ${hm(a)}–${day(b)} ${hm(b)}Z`;

const RECTS={map:{x:16,y:36,w:614,h:364},legend:{x:650,y:36,w:140,h:130},lane:{x:40,y:421,w:740,h:128},bar:{x:40,y:552,w:740,h:36}};
const ROW=GAP; // one row: the unknown systems sit this far below every known node

/** The map for the last `runs` runs of `runtime`, or for `juncture` (its runs in focus, the context muted underneath). `opts.galaxy`
 * stands in for the fetched galaxy; without it the kept map is loaded (and fetched when stale). */
export async function buildModel(runtime:string,opts:{runs?:number;juncture?:string;pilot?:string;galaxy?:Galaxy}={}):Promise<MapModel> {
  const sel:Selector=opts.juncture?{juncture:opts.juncture}:opts.runs??RUNS,window=readWindow(runtime,sel),activity=replay(window,runtime),galaxy=opts.galaxy??await loadGalaxy(runtime);
  const visited=activity.visits.map(v=>v.system),near=neighbours(visited,galaxy),ids=[...visited,...near],{map,lane}=RECTS;
  const full=fit(ids,galaxy,map),known=full.unknown.length?fit(ids,galaxy,{...map,h:map.h-ROW}):full;
  const placed={...known.placed,...Object.fromEntries(full.unknown.flatMap(id=>full.placed[id]?[[id,full.placed[id]]]:[]))}; // unknowns from the full rect: its bottom row, below the shrunk fit's
  const epochs=assignLevels(focusedEpochs(activity.intervals,window),lane.h);
  const presence=new Map<string,[number,string]>(); // system -> [most time in one epoch, that epoch's hue]
  for(const e of epochs.filter(x=>x.focus)) {
    const time=new Map<string,number>();
    for(const i of e.intervals)time.set(i.system,(time.get(i.system)??0)+(+i.end-+i.start));
    for(const [s,t] of time)if(t>(presence.get(s)?.[0]??-1))presence.set(s,[t,e.hue]);
  }
  const title=opts.juncture?`${opts.pilot??'Pilot'} · juncture ${hm(window.focusStart)}Z · ${span(window.focusStart,window.focusEnd)}`
    :`${opts.pilot??'Pilot'} · last ${window.runs.length} runs · ${span(window.start,window.end)}`;
  return {title,window,activity,epochs,galaxy,placed,neighbours:near,
    unknownSystems:full.unknown,axis:timeAxis(epochs,lane.x,lane.w),labels:epochs.map(e=>fitLabels(e,lane.y,lane.y+lane.h)),
    buckets:epochs.flatMap((e,i)=>buckets(activity.events.filter(v=>+v.at!==+e.end||+(epochs[i+1]?.start??Infinity)>+e.end),e.start,e.end)), // per epoch, so no column straddles a seam; an event on a seam belongs to the later epoch
    badgeHue:Object.fromEntries(activity.visits.filter(v=>v.focus).map(v=>v.system).map(s=>[s,presence.get(s)?.[1]??hueOf(0)])),rects:RECTS};
}
