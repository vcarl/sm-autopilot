/** Where things go: the piecewise time axis, level labels, activity buckets and mark sizes. */
import type {ActivityEvent} from './activity.ts';
import {BUCKET_MIN,DONUT,GAP,LANE_PAD,SMALL_FONT_PITCH,type Kind} from './constants.ts';
import type {Epoch} from './epochs.ts';

export interface Axis {spans:{epoch:number;gapX:number;x0:number;x1:number}[];toX:(t:Date)=>number}

/** Each epoch gets `gap` of dead space then a share of what is left proportional to its duration. */
export function timeAxis(epochs:Epoch[],x0:number,width:number,gap=GAP):Axis {
  const total=epochs.reduce((sum,e)=>sum+(+e.end-+e.start),0),room=width-gap*epochs.length;
  let x=x0;
  const spans=epochs.map(e=>{
    const gapX=x,start=gapX+gap,end=start+(total>0?room*(+e.end-+e.start)/total:0);
    x=end;
    return {epoch:e.index,gapX,x0:start,x1:end};
  });
  const toX=(t:Date)=>{
    for(const [i,e] of epochs.entries()) {
      const s=spans[i];
      if(!s||+t>+e.end)continue;
      if(+t<+e.start)return spans[i-1]?.x1??s.x0;
      return +e.end>+e.start?s.x0+(s.x1-s.x0)*(+t-+e.start)/(+e.end-+e.start):s.x0;
    }
    return spans.at(-1)?.x1??x0;
  };
  return {spans,toX};
}

export interface LevelLabel {system:string;level:number;y:number;shown:boolean;font:number}

/** Level 0 sits at the bottom; in a dense epoch a label is shown only if it clears the last one shown. */
export function fitLabels(epoch:Epoch,_laneTop:number,laneBottom:number):LevelLabel[] {
  const font=epoch.pitch>=SMALL_FONT_PITCH?10:8;
  let lastY:number|undefined;
  return epoch.systems.map(system=>({system,level:epoch.levels[system]??0})).sort((a,b)=>a.level-b.level).map(({system,level})=>{
    const y=laneBottom-LANE_PAD-level*epoch.pitch;
    const shown=!epoch.dense||lastY===undefined||lastY-y>=font;
    if(shown)lastY=y;
    return {system,level,y,shown,font};
  });
}

export interface Bucket {t0:Date;t1:Date;counts:Record<Kind,number>}

/** Equal steps over `[start,end]`, every one returned (at least one, so a range of no length still holds its events); the last
 * step ends at `end` and takes an event exactly there. Events outside the range are dropped. */
export function buckets(events:ActivityEvent[],start:Date,end:Date,minutes=BUCKET_MIN):Bucket[] {
  const step=minutes*60_000,n=Math.max(1,Math.ceil((+end-+start)/step));
  const out:Bucket[]=Array.from({length:n},(_,i)=>({t0:new Date(+start+i*step),t1:new Date(Math.min(+end,+start+(i+1)*step)),counts:{fights:0,docked:0,traded:0,fuel:0,creatures:0}}));
  for(const e of events) {
    if(+e.at<+start||+e.at>+end)continue;
    const b=out[Math.min(n-1,Math.floor((+e.at-+start)/step))];
    if(b)b.counts[e.kind]+=e.count;
  }
  return out;
}

export const donutRadius=(total:number)=>Math.min(DONUT.cap,DONUT.floor+DONUT.scale*Math.sqrt(total));

export const columnHeight=(total:number,max:number,barHeight:number)=>total<=0||max<=0?0:4+(barHeight-4)*Math.sqrt(total/max);
