/** Splitting the window into epochs and giving each system a level within its epoch. */
import type {Interval} from './activity.ts';
import {DENSE_PITCH,LANE_PAD,LONG_STAY_MIN,MIN_EPOCH_SHARE,MUTED_HUE,PITCH_MAX,hueOf} from './constants.ts';

/** `focus` false for an epoch of the context runs: drawn muted, in `MUTED_HUE`. */
export interface Epoch {index:number;start:Date;end:Date;systems:string[];intervals:Interval[];levels:Record<string,number>;pitch:number;dense:boolean;hue:string;focus:boolean}

const minutes=(i:Interval)=>(+i.end-+i.start)/60_000;
const systemsOf=(intervals:Interval[])=>[...new Set(intervals.map(i=>i.system))];
const sameSet=(a:string[],b:string[])=>a.length===b.length&&a.every(s=>b.includes(s));

/** The context's epochs, then the focus's, each cut on its own span; indexed in order, hued by the focus's own count. */
export function focusedEpochs(intervals:Interval[],w:{start:Date;end:Date;focusStart:Date;focusEnd:Date}):Epoch[] {
  const context=intervals.filter(i=>!i.focus),focus=intervals.filter(i=>i.focus);
  const before=context.length?makeEpochs(context,{start:w.start,end:context.at(-1)?.end??w.focusStart}).map(e=>({...e,hue:MUTED_HUE,focus:false})):[];
  const after=makeEpochs(focus,{start:w.focusStart,end:w.focusEnd});
  return [...before,...after].map((e,index)=>({...e,index}));
}

/** A long stay in a system other than the last long stay opens a new epoch, once the current one spans enough of the window. */
export function makeEpochs(intervals:Interval[],span:{start:Date;end:Date}):Epoch[] {
  const floor=MIN_EPOCH_SHARE*(+span.end-+span.start);
  const groups:Interval[][]=[];
  let lastLong:string|undefined,from=0;
  for(const i of intervals){
    const long=minutes(i)>=LONG_STAY_MIN,current=groups.at(-1);
    if(!current||(long&&i.system!==lastLong&&+i.start-from>=floor)){groups.push([i]);from=+i.start;}
    else current.push(i);
    if(long)lastLong=i.system;
  }
  const merged:Interval[][]=[];
  for(const group of groups){
    const last=merged.at(-1);
    if(last&&sameSet(systemsOf(last),systemsOf(group)))last.push(...group);
    else merged.push(group);
  }
  return merged.map((group,index)=>({index,start:group[0]?.start??span.start,end:group.at(-1)?.end??span.end,systems:systemsOf(group),intervals:group,levels:{},pitch:0,dense:false,hue:hueOf(index),focus:true}));
}

/** Level 0 is the system with the most presence; a system carried over keeps its level where that is still free. */
export function assignLevels(epochs:Epoch[],laneHeight:number):Epoch[] {
  const out:Epoch[]=[];
  for(const epoch of epochs){
    const k=epoch.systems.length,presence=new Map<string,number>();
    for(const i of epoch.intervals)presence.set(i.system,(presence.get(i.system)??0)+minutes(i));
    const ranked=[...epoch.systems].sort((a,b)=>(presence.get(b)??0)-(presence.get(a)??0));
    const before=out.at(-1)?.levels??{},levels:Record<string,number>={},taken=new Set<number>();
    for(const s of ranked){
      const was=before[s];
      if(was!==undefined&&was<k&&!taken.has(was)){levels[s]=was;taken.add(was);}
    }
    for(const s of ranked){
      if(levels[s]!==undefined)continue;
      let level=0;
      while(taken.has(level))level++;
      levels[s]=level;taken.add(level);
    }
    const pitch=Math.min(PITCH_MAX,(laneHeight-LANE_PAD)/k);
    out.push({...epoch,levels,pitch,dense:pitch<DENSE_PITCH});
  }
  return out;
}
