/** Replaying the window: where the pilot was, when, and what it did there. The focus runs (window.ts) count; a context run only places
 * the pilot: its systems, legs and intervals are kept unfocused, its acts, marks and creatures are not counted. */
import {isRecord,type JournalLine} from '../run-record.ts';
import {readPlaces} from '../play/places.ts';
import {readSightings} from '../sighting-memory.ts';
import type {Kind} from './constants.ts';
import type {Window} from './window.ts';

export interface Interval {system:string;start:Date;end:Date;focus:boolean}
/** Deaths and strandings are counted beside the five kinds: they are marks, not slices of the donut. */
export interface Marks {deaths:number;stranded:number}
/** `order` numbers first visits within the focus runs; 0 for a system only the context visited (`focus` false). */
export interface Visit {system:string;order:number;counts:Record<Kind,number>;marks:Marks;focus:boolean}
/** `trips` are the focus runs'; a leg only the context flew has none and `focus` false. */
export interface Leg {a:string;b:string;trips:number;focus:boolean}
export interface ActivityEvent {at:Date;system:string;kind:Kind;count:number}
export interface Activity {visits:Visit[];intervals:Interval[];legs:Leg[];heaviest?:Leg;events:ActivityEvent[];
  current:{system?:string;poi?:string;docked_at?:string}}

const str=(value:unknown)=>typeof value==='string'&&value?value:undefined;
const when=(value:unknown)=>{const at=typeof value==='string'?new Date(value):undefined;return at&&!Number.isNaN(+at)?at:undefined;};

/** What a line counts as, if anything. A repair is a stop at a dock, as a `dock` is. */
function kindOf(line:JournalLine):Kind|undefined {
  if(line.event==='command')return line.action==='dock'&&line.ok===true?'docked':undefined;
  if(line.event==='trade')return line.service==='repair'?'docked':line.service==='refuel'?'fuel':line.side==='buy'||line.side==='sell'?'traded':undefined;
  return line.event==='push'&&line.push==='battle_ended'?'fights':undefined;
}

/** Walk the window's lines in time order, run by run, keeping the system the pilot is in. */
export function replay(w:Window,runtime:string):Activity {
  const pois:Record<string,string>={...readPlaces(runtime)};
  const visits=new Map<string,Visit>(),legs=new Map<string,Leg>(),events:ActivityEvent[]=[],spans:Interval[]=[];
  let focus=true,order=0;
  const visit=(system:string)=>{
    const known=visits.get(system)??{system,order:0,counts:{fights:0,docked:0,traded:0,fuel:0,creatures:0},marks:{deaths:0,stranded:0},focus:false};
    if(focus&&!known.focus){known.focus=true;known.order=++order;}
    visits.set(system,known);return known;
  };
  const timed=w.lines.flatMap(line=>{const at=when(line.at);return at?[{line,at}]:[];}).sort((x,y)=>+x.at-+y.at);
  let here:string|undefined;
  for(const run of w.runs) {
    focus=run.focus;
    here=str(run.start_state?.system)??here;
    if(here)visit(here);
    let since=run.started,last=run.ended??run.started;
    const close=(to:Date)=>{if(here)spans.push({system:here,start:since,end:to<since?since:to,focus});};
    for(const {line,at} of timed.filter(x=>x.line.run_id===run.run_id)) {
      last=at>last?at:last;
      const id=str(isRecord(line.params)?line.params.id:undefined);
      if(line.event==='command'&&line.ok===true&&id) {
        if(line.action==='travel'&&here)pois[id]=here;
        if(line.action==='jump') {
          close(at);
          if(here&&here!==id) {
            const a=here<id?here:id,b=here<id?id:here,leg=legs.get(`${a}\0${b}`)??{a,b,trips:0,focus:false};
            legs.set(`${a}\0${b}`,focus?{...leg,trips:leg.trips+1,focus:true}:leg);
          }
          here=id;since=at;visit(id);
        }
      }
      if(line.event==='death'&&here) {
        if(focus)visit(here).marks.deaths+=1;
        const respawn=pois[str(line.respawn_base)??''];
        if(respawn&&respawn!==here) {close(at);here=respawn;since=at;visit(respawn);} // the clone wakes at its base: what follows happens there
      }
      if(line.event==='stranded') {
        const there=str(line.system),system=there&&visits.has(there)?there:here;
        if(system&&focus)visit(system).marks.stranded+=1;
      }
      const kind=kindOf(line);
      if(kind&&here&&focus) {visit(here).counts[kind]+=1;events.push({at,system:here,kind,count:1});}
    }
    close(last);
  }
  // Creatures: the newest look at each species at each POI, summed into the system that POI is in, when the focus visited it.
  const seen=new Set<string>();
  for(const one of readSightings(runtime)) {
    const key=`${one.poi_id}\0${one.species}`,system=pois[one.poi_id],there=system?visits.get(system):undefined;
    if(!one.species||seen.has(key))continue;
    seen.add(key);
    if(!there?.focus||one.count<=0)continue;
    there.counts.creatures+=one.count;
    const seenAt=when(one.at);
    if(seenAt)events.push({at:seenAt,system:there.system,kind:'creatures',count:one.count});
  }
  const intervals:Interval[]=[];
  for(const span of spans.sort((x,y)=>+x.start-+y.start)) {
    const prior=intervals.at(-1);
    if(prior&&prior.system===span.system&&prior.focus===span.focus)prior.end=new Date(Math.max(+prior.end,+span.end));
    else intervals.push({...span});
  }
  const trips=[...legs.values()],heaviest=trips.filter(l=>l.focus).reduce<Leg|undefined>((top,leg)=>!top||leg.trips>top.trips?leg:top,undefined);
  const end=w.runs.at(-1)?.end_state,system=str(end?.system)??here, // a run still live has no end_state: the replay's last position stands in
    poi=str(end?.poi),docked_at=str(end?.docked_at);
  return {visits:[...visits.values()],intervals,legs:trips,...heaviest?{heaviest}:{},events,
    current:{...system?{system}:{},...poi?{poi}:{},...docked_at?{docked_at}:{}}};
}
