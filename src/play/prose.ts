/** `prose(outcome)`: the report at the end of a run, static text assembled from the value.
 * No model, no per-function template (DESIGN.md "Outcome and prose"). */
import type {Call} from './runtime.ts';
import type {Outcome} from './types.ts';

const n=(value:number)=>Number.isInteger(value)?value.toLocaleString('en-US'):value.toFixed(1);
const rows=(items:{item_id:string;quantity:number}[])=>items.map(row=>`${n(row.quantity)} ${row.item_id}`).join(', ');

const MAX_LINES=8;
/** Every top-level call `main()` made, so a trailing idempotent no-op cannot erase the trip
 * behind it: the whole run's measured cost and gains, then one line per call. */
function thisRun(calls:Call[]):string {
  const total=(pick:(call:Call)=>number)=>calls.reduce((sum,call)=>sum+pick(call),0);
  const spent=[[total(c=>c.cost.credits),'cr'],[total(c=>c.cost.fuel),'fuel'],[total(c=>c.cost.hull),'hull'],
    [total(c=>c.cost.minutes),'min']].filter(([value])=>value).map(([value,unit])=>`${n(value as number)} ${unit}`);
  const got=[[total(c=>c.credits),'cr'],[total(c=>c.items),'items'],[total(c=>c.xp),'xp']]
    .filter(([value])=>value).map(([value,unit])=>`+${n(value as number)} ${unit}`);
  const shown=calls.length>MAX_LINES?calls.slice(1-MAX_LINES):calls;
  const lines=shown.map(call=>`  - ${call.fn} ${call.status} ${call.did}`);
  if(shown.length<calls.length)lines.unshift(`  - (${calls.length-shown.length} earlier call(s))`);
  return [`This run: ${calls.length} calls, cost ${spent.join(', ')||'nothing'}, gained ${got.join(', ')||'nothing'}.`,
    ...lines].join('\n');
}

export function prose(outcome:Outcome<unknown>,calls:Call[]=[]):string {
  const out:string[]=[];
  const head=outcome.status==='done'?'Done':outcome.status[0]!.toUpperCase()+outcome.status.slice(1);
  out.push(`${head}: ${outcome.did}${outcome.status!=='done'&&outcome.why?`: ${outcome.why}`:''}.`);

  const {cost,gained,now}=outcome;
  const spent=[cost.credits?`${n(cost.credits)} cr`:'',cost.fuel?`${n(cost.fuel)} fuel`:'',
    cost.hull?`${n(cost.hull)} hull`:'',cost.minutes?`${n(cost.minutes)} min`:''].filter(Boolean);
  out.push(spent.length?`Cost this run: ${spent.join(', ')}.`:'Cost: nothing.');

  const got=[gained.credits?`+${n(gained.credits)} cr`:'',gained.items.length?rows(gained.items):'',
    ...Object.entries(gained.xp).map(([skill,xp])=>{
      const row=now.skills[skill];
      return `${skill} +${n(xp)} xp${row?` (level ${row.level})`:''}`;
    })].filter(Boolean);
  if(got.length)out.push(`Gained: ${got.join('; ')}.`);

  const {ship,location}=now;
  const place=location?.docked_at?`docked at ${location.docked_at} (${location.system_name??location.system_id})`
    :location?.in_transit?`in transit to ${location.transit_dest_poi_id??location.transit_dest_system_id??'?'}`
      :`at ${location?.poi_id??'?'} (${location?.system_name??location?.system_id??'?'})`;
  const missions=now.ship?(outcome.now as any).missions:undefined;
  out.push(`Now: ${place}, fuel ${ship?.fuel??'?'}/${ship?.max_fuel??'?'}, hull ${ship?.hull??'?'}/${ship?.max_hull??'?'}, `+
    `hold ${ship?.cargo_used??'?'}/${ship?.cargo_capacity??'?'}, ${n(now.credits)} cr, mood ${now.mood}${now.tired_by?` (Tired: ${now.tired_by})`:''}.`+
    (Array.isArray(missions)&&missions.length?` Active missions: ${missions.length}.`:''));

  if(calls.length>1)out.push(thisRun(calls));
  if(outcome.next.length)out.push(`Consider:\n${outcome.next.map(text=>`  - ${text}`).join('\n')}`);
  return out.join('\n');
}
