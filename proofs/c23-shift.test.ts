/** C23: one full shift on replay — rest, reflect, goal, stance, script, home, rest —
 * with the journal agreeing with what the pilot says.
 *
 * Replay, not fixture: every reply below is a real recorded response, sliced out of
 * `runtime/gameplay.jsonl` (106 MB of live play, untracked) by `fixtures/slice_gameplay.py`
 * into `fixtures/c23-replay.json` (S46). The harness owns the world the way the game does —
 * one authoritative state, advanced by each command — and hands back the recorded reply for
 * that command, with only the three numbers a reply is *required* to agree with overlaid
 * (`find_route`'s fuel and cargo, `storage/view`'s items, `refuel`'s cost). Everything else,
 * including a mine reply still carrying another session's hold, is as it came off the wire,
 * so the shift runs against real shapes and its numbers can only come from live reads.
 *
 * The agent is a scripted chooser: it reads what the bridge delivers and acts as a
 * well-behaved pilot would. It never reaches into the runner's machinery — reflection is
 * mirrored from what `spacemolt_reflect` writes (record + one `{event:'reflection'}` line),
 * and nothing here imports Python.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serve,type Dispatch,type Pilot} from '../src/bridge.ts';
import {journalRun,readJournal} from '../src/run-record.ts';
import type {ReadinessAccount,ReadinessCommand} from '../src/readiness.ts';

interface Fixture {
  note:string;
  source:Record<string,any>;
  state:{ship:Record<string,any>;cargo:{item_id:string;quantity:number;size?:number}[];
    location:Record<string,any>;credits:number;modules:Record<string,any>[]};
  observed:{home_base_id:string;home_poi_id:string;site_poi_id:string;system_id:string;
    travel_fuel:number;mine_gain:{item_id:string;quantity:number}[];fuel_price_all_in:number};
  responses:Record<string,any[]>;
}
const FIXTURE=JSON.parse(readFileSync(new URL('./fixtures/c23-replay.json',import.meta.url),'utf8')) as Fixture;
const {home_base_id:HOME_BASE,home_poi_id:HOME_POI,site_poi_id:SITE,travel_fuel:TRAVEL_FUEL,
  mine_gain:MINE_GAIN,fuel_price_all_in:FUEL_PRICE}=FIXTURE.observed;
const ORE=MINE_GAIN[0]!.item_id;
/** Every action the bridge answers. The shift must find the same set at both ends. */
const ACTIONS=['where','rest','reflect','travel','dock','gather','storage','menu','run','scripts','resume','status'];

/** The replayed world: one authoritative state, the recorded replies, a call index per
 * command so a repeated command walks its recorded ones in order (S46), and a tick that
 * advances with every send — the game's own clock, the only one this shift needs, because
 * every step's end state holds the moment its command lands. */
function replay(ship:Record<string,number>={}) {
  const state={
    ship:{...structuredClone(FIXTURE.state.ship),...ship},
    cargo:structuredClone(FIXTURE.state.cargo),
    location:structuredClone(FIXTURE.state.location),
    modules:structuredClone(FIXTURE.state.modules),
    player:{credits:FIXTURE.state.credits},
  };
  const store=structuredClone(
    FIXTURE.responses['spacemolt_storage/view']![0].structuredContent.items) as
    {item_id:string;name?:string;quantity:number;size?:number}[];
  const calls:{action:string;params:Record<string,unknown>}[]=[];
  const index:Record<string,number>={};
  let tick=Number(FIXTURE.responses['spacemolt/mine']![0].tick)||0;

  /** The recorded reply for this send: the next one for a repeated command, the last one
   * once its recorded run is used up, stamped with the clock as it stands now. */
  const recorded=(action:string)=>{
    const rows=FIXTURE.responses[action];
    if(!rows)throw new Error(`the recorded trace carries no ${action}`);
    const seen=index[action]=(index[action]??-1)+1;
    const reply=structuredClone(rows[Math.min(seen,rows.length-1)]);
    if(reply.tick!==undefined)reply.tick=++tick;
    return reply;
  };
  const carried=(item_id:string)=>state.cargo.find(row=>row.item_id===item_id);
  const add=(item_id:string,quantity:number,size=1)=>{
    const row=carried(item_id);
    if(row)row.quantity+=quantity;else state.cargo.push({item_id,quantity,size});
    state.ship.cargo_used+=quantity*size;
  };
  const take=(item_id:string,quantity:number)=>{
    const row=carried(item_id);
    const moved=Math.min(row?.quantity??0,quantity);
    if(row) {
      row.quantity-=moved;
      if(!row.quantity)state.cargo=state.cargo.filter(current=>current!==row);
    }
    state.ship.cargo_used-=moved*(row?.size??1);
    return moved;
  };

  const handlers:Record<string,(params:any)=>unknown>={
    'spacemolt/get_system':()=>recorded('spacemolt/get_system'),
    'spacemolt/get_base':()=>recorded('spacemolt/get_base'),
    'spacemolt/get_skills':()=>recorded('spacemolt/get_skills'),
    'spacemolt_shipping/profile':()=>recorded('spacemolt_shipping/profile'),
    // The one quote the caller checks against the ship it is about to move.
    'spacemolt/find_route':()=>{
      const reply=recorded('spacemolt/find_route');
      Object.assign(reply.structuredContent,
        {fuel_available:state.ship.fuel,cargo_used:state.ship.cargo_used});
      return reply;
    },
    'spacemolt/undock':()=>{state.location.docked_at=null;return recorded('spacemolt/undock');},
    'spacemolt/dock':()=>{state.location.docked_at=HOME_BASE;return recorded('spacemolt/dock');},
    'spacemolt/travel':({id})=>{
      state.ship.fuel-=TRAVEL_FUEL;
      state.location.poi_id=String(id);
      state.location.docked_at=null;
      return recorded('spacemolt/travel');
    },
    'spacemolt/mine':()=>{
      for(const row of MINE_GAIN)add(row.item_id,row.quantity);
      return recorded('spacemolt/mine');
    },
    'spacemolt_storage/view':()=>{
      const reply=recorded('spacemolt_storage/view');
      reply.structuredContent.items=structuredClone(store);
      return reply;
    },
    'spacemolt_storage/deposit':({item_id,quantity})=>{
      const moved=take(String(item_id),Number(quantity));
      const held=store.find(row=>row.item_id===String(item_id));
      if(held)held.quantity+=moved;else store.push({item_id:String(item_id),quantity:moved,size:1});
      return recorded('spacemolt_storage/deposit');
    },
    'spacemolt/refuel':()=>{
      const units=state.ship.max_fuel-state.ship.fuel;
      const cost=units*FUEL_PRICE;
      state.ship.fuel=state.ship.max_fuel;
      state.player.credits-=cost;
      const reply=recorded('spacemolt/refuel');
      reply.delta.details.fuel=units;
      reply.delta.details.cost=cost;
      return reply;
    },
  };
  const account:ReadinessAccount={
    state:structuredClone(state) as unknown as ReadinessAccount['state'],
    async refresh(){account.state=structuredClone(state) as unknown as ReadinessAccount['state'];}};
  const command:ReadinessCommand=async(action,params)=>{
    calls.push({action,params:params??{}});
    if(!Object.hasOwn(handlers,action))throw new Error(`the recorded trace carries no ${action}`);
    return handlers[action]!(params??{});
  };
  return {state,store,calls,account,command,
    count:(action:string)=>calls.filter(call=>call.action===action).length,
    stored:(item_id:string)=>store.find(row=>row.item_id===item_id)?.quantity??0};
}

/** A run outlives the call that started it; the shift waits for its juncture. */
async function drain(dispatch:Dispatch) {
  for(let turn=0;turn<100_000;turn++) {
    await new Promise(resolve=>setImmediate(resolve));
    if(!((await dispatch('status')) as any).running)return;
  }
  throw new Error('the run never ended');
}

/** Which of these names the bridge answers. A name it does not know is the only thing that
 * can be missing: an action that refuses on its parameters is still an action the shift
 * holds. Probed only where the pilot is at rest, so nothing here moves the world. */
async function toolset(dispatch:Dispatch) {
  const held:string[]=[];
  for(const action of [...ACTIONS,'sell','craft','spacemolt_reflect']) {
    try {await dispatch(action,{});held.push(action);}
    catch(error){if(!/^Unknown action/.test(String((error as Error).message)))held.push(action);}
  }
  return held;
}

/** One runner over the replayed world, with the record the operator left it. */
function shift(over:{pilot?:Partial<Pilot>;ship?:Record<string,number>}={}) {
  const world=replay(over.ship);
  const runtime=mkdtempSync(join(tmpdir(),'c23-shift-'));
  let pilot:Pilot={name:'pilot',objective:'two loads of ore for the bench',
    home:HOME_BASE,...over.pilot};
  const dispatch=serve(world.account,world.command,
    {pilot:()=>pilot,setPilot:next=>{pilot=next;},runtime});
  return {...world,runtime,dispatch,
    record:()=>pilot,
    /** What the chooser does when it reflects: the record, then the one journal line —
     * the same two writes `spacemolt_reflect` makes (N8). */
    reflect:(goal:string,stance:Pilot['stance'],mood:Pilot['mood'])=>{
      pilot={...pilot,goal,stance,mood};
      delete pilot.objective_done;
      journalRun(runtime,{goal,stance,mood},'reflection');
    },
    done:()=>{pilot={...pilot,objective_done:true};},
    journal:()=>readJournal(runtime),
    close:()=>rm(runtime,{recursive:true,force:true})};
}

test('C23: rest, reflect, goal, stance, script, home, rest — and the journal says the same',async()=>{
  const s=shift();
  try {
    // (1) At rest: no stance, so the consultation is not a menu of work but the reflection
    // the next shift is chosen from (N7). Real reads answer it.
    const held=await toolset(s.dispatch);
    const opening=await s.dispatch('menu') as any;
    assert.equal(opening.at_rest,true,'a pilot with no stance is consulted about reflection');
    assert.ok(!('options' in opening),'no menu of work while the shift is closed');
    assert.equal(opening.objective,'two loads of ore for the bench');
    assert.equal(opening.home,HOME_BASE);
    assert.equal(opening.ship.max_fuel,FIXTURE.state.ship.max_fuel);
    assert.ok(opening.skills.length>0,'the recorded skills board reaches reflection');
    assert.ok(opening.skills.every((row:any)=>row.level<=opening.skills.at(-1).level),
      'the lagging skills come first');
    assert.ok(opening.holdings.storage.some((row:any)=>row.base_id===HOME_BASE),
      'the recorded storage index reaches reflection');
    // Nothing is guessed: the one counter this recorded play never called is named, not invented.
    assert.deepEqual(opening.missing.filter((row:string)=>row==='tax'),['tax']);
    assert.ok(!('tax_due' in opening.owes));
    assert.equal(opening.owes.carrier_tier,'probationary','the recorded shipping profile is read');
    // N9: an empty journal is a pilot that has chosen nothing.
    assert.ok(opening.stagnation.some((line:string)=>/stances never chosen/.test(line)),
      JSON.stringify(opening.stagnation));

    // (2) The chooser reflects: a goal, and from the goal a stance and an initial mood.
    s.reflect('two loads of ore for the bench','Industrialist','Cautious');
    assert.deepEqual([s.record().stance,s.record().mood,s.record().goal],
      ['Industrialist','Cautious','two loads of ore for the bench']);

    // (3) The shift is open, so the consultation is the Industrialist's menu.
    const menu=await s.dispatch('menu') as any;
    assert.equal(menu.stance,'Industrialist');
    assert.equal(menu.mood,'Cautious');
    assert.ok(!('at_rest' in menu),'a stance held is a shift, not a reflection');
    assert.equal(menu.present.docked_at,HOME_BASE);
    const rows=[...menu.options,...menu.unavailable].map((row:any)=>row.job);
    assert.ok(rows.some((job:string)=>/^J7 /.test(job)),'the Industrialist sees its own job');
    assert.ok(!rows.some((job:string)=>/^(J1|J4|J5|J6|J8|J9) /.test(job)),
      `another stance's jobs are not on this menu: ${rows.join(' | ')}`);
    assert.ok(menu.options.every((row:any)=>row.reason&&row.bounds),'every option carries a reason and bounds');
    // The bench has nothing to work with, which is exactly why the chooser goes gathering:
    // the menu bounds, it does not command, and a pilot may act outside it (VISION).
    const bench=menu.unavailable.find((row:any)=>/^J7 /.test(row.job));
    assert.match(bench.reason,/workshop|inputs/);
    assert.ok(menu.options.some((row:any)=>row.job===`Travel to ${SITE}`),
      'the belt next door is on the menu');

    // The chooser writes no script of its own: it names one the runner ships and the
    // parameters that make it two trips — enough ore in the store for two loads at the bench.
    const perCycle=MINE_GAIN.reduce((sum,row)=>sum+row.quantity,0);
    const cycles=(FIXTURE.state.ship.cargo_capacity-FIXTURE.state.ship.cargo_used)/perCycle;
    const before=s.stored(ORE);
    const target=before+2*cycles*MINE_GAIN[0]!.quantity;
    const started=await s.dispatch('run',{script:'gather-until',
      params:{poi_id:SITE,item_id:ORE,quantity:target,max_runs:4,base_id:HOME_BASE}}) as any;
    assert.equal(started.accepted,true,started.reason);
    assert.equal(started.script,'gather-until');
    await drain(s.dispatch);

    // One outcome for the whole run, and the ore is in the station store.
    const status=await s.dispatch('status') as any;
    assert.equal(status.running,false);
    assert.equal(status.last.outcome,'done',status.last.reason);
    assert.equal(status.last.jobs.length,2);
    assert.ok(status.last.jobs.every((job:any)=>job.outcome==='done'));
    assert.match(status.last.reason,/2 jobs/);
    const mined=status.last.jobs.reduce((total:number,job:any)=>
      total+job.yield.reduce((sum:number,row:any)=>sum+row.quantity,0),0);
    // Each trip is named for its end state — a full hold — so the take is the room the
    // recorded ship had, at the rate the recorded belt gave, twice over.
    assert.equal(s.count('spacemolt/mine'),2*cycles,'both holds were filled, cycle by cycle');
    assert.equal(mined,2*cycles*perCycle);
    assert.equal(s.stored(ORE),target,
      'what the pilot says it gathered is what the station store holds');
    assert.equal(s.stored(ORE),before+mined);
    // Docked at home on a full tank, carrying only what it set out with.
    assert.equal(s.state.location.docked_at,HOME_BASE);
    assert.equal(s.state.ship.fuel,s.state.ship.max_fuel);
    assert.deepEqual(s.state.cargo.map(row=>row.item_id).sort(),
      FIXTURE.state.cargo.map(row=>row.item_id).sort(),
      'the hold ends with the pilot\'s own cargo and nothing else');

    // VISION's first invariant: no juncture between the two jobs of the run. Two trips
    // out and back, one ended line in the journal, one outcome, one juncture.
    assert.equal(s.count('spacemolt/undock'),2);
    assert.equal(s.count('spacemolt/dock'),2);
    assert.equal(s.journal().filter(entry=>entry.event==='run'&&entry.phase==='ended').length,1);

    // (4) The next consultation carries the outcome, and the objective is met.
    const after=await s.dispatch('menu') as any;
    assert.equal(after.last.script,status.last.script);
    assert.equal(after.last.outcome,'done');
    assert.ok(after.options.some((row:any)=>/^Rest and reflect/.test(row.job)),
      'home, safe and serviced: the evening can be put down');
    s.done();

    // (5) Rest ends the shift, at home, and clears what the shift held.
    const rested=await s.dispatch('rest') as any;
    assert.equal(rested.rested,true,rested.reason);
    assert.equal(rested.shift_ended,true);
    assert.equal(rested.serviced,true);
    assert.deepEqual(s.record(),{name:'pilot',objective:'two loads of ore for the bench',
      home:HOME_BASE,objective_done:true},
      'no stance, no mood, no goal; the operator\'s two settings and the flag survive');

    // The journal agrees with what the pilot says: the shift in order, with the same values.
    const events=s.journal();
    assert.deepEqual(events.map(entry=>entry.event),['reflection','run','run','rest']);
    assert.deepEqual(events.filter(entry=>entry.event==='run').map(entry=>entry.phase),
      ['started','ended'],'one run: it began once and ended once');
    assert.ok(events.every(entry=>typeof entry.at==='string'),'every line is stamped');
    const [reflection,begun,run,rest]=events as any[];
    assert.deepEqual([reflection.goal,reflection.stance,reflection.mood],
      ['two loads of ore for the bench','Industrialist','Cautious']);
    assert.equal(begun.script,'gather-until');
    assert.equal(begun.started,run.started);
    assert.equal(run.script,status.last.script);
    assert.equal(run.outcome,status.last.outcome);
    assert.deepEqual(run.jobs.map((job:any)=>job.outcome),
      status.last.jobs.map((job:any)=>job.outcome));
    assert.equal(run.reason,status.last.reason);
    assert.deepEqual([rest.stance,rest.mood,rest.goal,rest.home],
      ['Industrialist','Cautious','two loads of ore for the bench',HOME_BASE]);
    assert.ok(!events.some(entry=>entry.event==='unsolicited_move'),
      'nothing moved the pilot that the pilot did not command');

    // VISION's second invariant: nothing moved under the agent. The shift opened and closed
    // with the same set of actions in front of it; reflection added none and rest took none.
    assert.deepEqual(await toolset(s.dispatch),held);
    assert.deepEqual(held,ACTIONS,'and that set is the bridge\'s own');
  } finally {await s.close();}
});

test('C23 mutations: rest away from home, reflection with a stance held, a journal missing its line',async()=>{
  // Rest happens only at home (N6): the same shift, docked one station over, is refused.
  // Serviced, so where it is standing is the only thing between it and the evening's end.
  const away=shift({pilot:{home:'frontier_station',stance:'Industrialist',mood:'Cautious'},
    ship:{fuel:FIXTURE.state.ship.max_fuel}});
  try {
    const refused=await away.dispatch('rest') as any;
    assert.equal(refused.rested,false);
    assert.match(refused.reason,/only at home/);
    assert.equal(away.journal().length,0,'a refused rest leaves no line');
  } finally {await away.close();}

  // Reflection is the consultation of a pilot with no stance. With one held, the same call
  // is a menu of work — the shift is not reopened mid-evening (N8).
  const onShift=shift({pilot:{stance:'Industrialist',mood:'Cautious',goal:'ore'}});
  try {
    const menu=await onShift.dispatch('menu') as any;
    assert.ok(!('at_rest' in menu),'a stance held is never offered a reflection');
    assert.equal(menu.stance,'Industrialist');
  } finally {await onShift.close();}

  // A rest that happened leaves its line; a journal without it cannot account for the shift.
  // (The recorded play holds this same ship at this same dock on a full tank, line 260.)
  const ended=shift({pilot:{stance:'Industrialist',mood:'Cautious',goal:'ore'},
    ship:{fuel:FIXTURE.state.ship.max_fuel}});
  try {
    assert.equal((await ended.dispatch('rest') as any).rested,true);
    assert.deepEqual(ended.journal().map(entry=>entry.event),['rest']);
  } finally {await ended.close();}
});
