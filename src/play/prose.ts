/** `prose(outcome)`: the report at the end of a run, static text assembled from the value.
 * No model, no per-function template (DESIGN.md "Outcome and prose"). */
import type {Outcome} from './types.ts';

const n=(value:number)=>Number.isInteger(value)?value.toLocaleString('en-US'):value.toFixed(1);
const rows=(items:{item_id:string;quantity:number}[])=>items.map(row=>`${n(row.quantity)} ${row.item_id}`).join(', ');

export function prose(outcome:Outcome<unknown>):string {
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

  if(outcome.next.length)out.push(`Consider:\n${outcome.next.map(text=>`  - ${text}`).join('\n')}`);
  return out.join('\n');
}
