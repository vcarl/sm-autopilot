/** `prose(outcome)`: the report at the end of a run, static text assembled from the value.
 * No model, no per-function template (DESIGN.md "Outcome and prose"). */
import type {Call} from './runtime.ts';
import type {Outcome} from './types.ts';
import {cellReserve} from '../mining-inventory.ts';
import {field} from './game.ts';

const n=(value:number)=>Number.isInteger(value)?value.toLocaleString('en-US'):value.toFixed(1);
const rows=(items:{item_id:string;quantity:number}[])=>items.map(row=>`${n(row.quantity)} ${row.item_id}`).join(', ');

const MAX_LINES=8;
/** The run's cost, once: the sum over every top-level call, so a trailing idempotent no-op
 * cannot erase the trip behind it. The Outcome's own `cost` measures only from the last
 * `outcome()` mark, which is why the report used to say "Cost: nothing" over 28 hull lost. */
function runCost(calls:Call[],fallback:Outcome<unknown>['cost']):Outcome<unknown>['cost'] {
  if(!calls.length)return fallback;
  const total=(pick:(call:Call)=>number)=>calls.reduce((sum,call)=>sum+pick(call),0);
  return {credits:total(c=>c.cost.credits),fuel:total(c=>c.cost.fuel),hull:total(c=>c.cost.hull),
    minutes:total(c=>c.cost.minutes)};
}
/** Every top-level call `main()` made: what the whole run gained, then one line per call.
 * The cost is said once, above; two totals from two marks is how the report contradicted itself. */
function thisRun(calls:Call[]):string {
  const total=(pick:(call:Call)=>number)=>calls.reduce((sum,call)=>sum+pick(call),0);
  const gains:[number,string][]=[[total(c=>c.credits),'cr'],[total(c=>c.items),'items'],[total(c=>c.xp),'xp']];
  const got=gains.filter(([value])=>value).map(([value,unit])=>`+${n(value)} ${unit}`);
  const shown=calls.length>MAX_LINES?calls.slice(1-MAX_LINES):calls;
  // A call that did not end `done` carries its `why`: the reason is what the next script has
  // to correct itself from (the real ids behind a refused destination), and a `did` alone
  // drops it. A `done` line has nothing to explain.
  const lines=shown.map(call=>`  - ${call.fn} ${call.status} ${call.did}`
    +(call.status!=='done'&&call.why?`: ${call.why}`:''));
  if(shown.length<calls.length)lines.unshift(`  - (${calls.length-shown.length} earlier call(s))`);
  return [`This run: ${calls.length} calls, gained ${got.join(', ')||'nothing'}.`,
    ...lines].join('\n');
}

/** The run's headline from its work, not its last call. Live 2026-10-01 (kvothe 15:25Z): two
 * tradeRun calls earned 5,071 and 2,452 cr, the third lap was cut at the cap, and the run read
 * "nothing; did not reach nova_terra_central"; 09-30 run 8e0abef8 mined 27 items and read `refused`
 * "serviced nothing" from a trailing service() off a station. The pilot read both as the loop dying.
 * The rule, mechanical: when `main()` returned a library call's Outcome (not one it composed with
 * `outcome()`, nor the runtime's broke/stopped/cap) and some top-level call gained credits or items,
 * the run takes the status of the call that gained the most credits (then items), its did leads
 * with the run's totals and that call's did, and the last call follows as a clause. Every call
 * keeps its own status in `calls`; a run whose returned call is its only earner is left as it is. */
export function ofTheRun(result:Outcome<unknown>,calls:Call[]):Outcome<unknown> {
  const earned=calls.filter(c=>c.credits>0||c.items>0),last=calls.at(-1);
  if(result.fn==='pilot'||!earned.length||!last||(earned.length===1&&earned[0]===last))return result;
  const best=earned.reduce((a,c)=>c.credits>a.credits||(c.credits===a.credits&&c.items>a.items)?c:a);
  const total=(pick:(call:Call)=>number)=>calls.reduce((sum,call)=>sum+pick(call),0);
  const credits=total(c=>c.credits),count=total(c=>c.items);
  const got=[credits?`+${n(credits)} cr`:'',count?`+${n(count)} items`:''].filter(Boolean).join(', ');
  const tail=best===last?'':`; last call ${last.fn} ${last.status}`
    +(last.status==='done'?'':`: ${last.did}${last.why?`: ${last.why}`:''}`);
  const items=new Map<string,number>(),xp:Record<string,number>={};
  for(const call of calls) {
    for(const row of call.gained?.items??[])items.set(row.item_id,(items.get(row.item_id)??0)+row.quantity);
    for(const [id,value] of Object.entries(call.gained?.xp??{}))xp[id]=(xp[id]??0)+value;
  }
  const {why:_why,...rest}=result;
  return {...rest,status:best.status,
    did:`${earned.length>1?`${earned.length} calls`:best.fn} gained ${got}: ${best.did}${best.why?` (${best.why})`:''}${tail}`,
    gained:{credits,items:[...items].map(([item_id,quantity])=>({item_id,quantity})),xp}};
}

export function prose(outcome:Outcome<unknown>,calls:Call[]=[]):string {
  const out:string[]=[];
  const head=outcome.status==='done'?'Done':outcome.status.charAt(0).toUpperCase()+outcome.status.slice(1);
  out.push(`${head}: ${outcome.did}${outcome.status!=='done'&&outcome.why?`: ${outcome.why}`:''}.`);

  const {gained,now}=outcome;
  const cost=runCost(calls,outcome.cost);
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
  // Present declares no `missions` (present() never sets one); read it only if a caller's `now` carries it.
  const missions=now.ship?field(now,'missions'):undefined;
  const cells=cellReserve(now);
  out.push(`Now: ${place}, fuel ${ship?.fuel??'?'}/${ship?.max_fuel??'?'}, hull ${ship?.hull??'?'}/${ship?.max_hull??'?'}, `+
    `hold ${ship?.cargo_used??'?'}/${ship?.cargo_capacity??'?'}${cells.target?` (fuel cells ${cells.held}/${cells.target})`:''}, ${n(now.credits)} cr, mood ${now.mood}${now.tired_by?` (Tired: ${now.tired_by})`:''}.`+
    (Array.isArray(missions)&&missions.length?` Active missions: ${missions.length}.`:''));

  if(calls.length>1)out.push(thisRun(calls));
  if(outcome.next.length)out.push(`Consider:\n${outcome.next.map(text=>`  - ${text}`).join('\n')}`);
  return out.join('\n');
}
