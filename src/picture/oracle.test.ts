/** The journal oracle (`oracle.ts`): a run's Scene from the journal and sidecars, as of its end.
 * Fixture lines are cut from Kvothe's journal of 2026-10-17 (juncture c5f4c0ff), trimmed to what the oracle reads. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {appendFileSync,copyFileSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {journalRun} from '../run-record.ts';
import {oracleLine,pilotEyes,pilotLook,scenes} from './oracle.ts';
import {CD295081} from '../test-support/scene.ts';
import {STYLE} from './imager.ts';
import {caption,prompt} from './prompts.ts';
import {refOf} from './refs.ts';

const J='c5f4c0ff13a249238deb5ba5359a7654',EARLIER='50e5bfb7d35a42ba9dd9e62fa0df22e6';
const docked={system:'the_telescope',poi:'mobile_capital',docked_at:'frontier_station'};
const ship=(over:Record<string,unknown>={})=>({credits:316653,fuel:120,max_fuel:120,hull:80,max_hull:80,cargo_used:32,cargo_capacity:75,
  cargo:[{item_id:'fuel_cell',quantity:3},{item_id:'copper_piping',quantity:29}],...docked,...over});
const json=(dir:string,file:string,value:unknown)=>writeFileSync(join(dir,file),JSON.stringify(value));

function runtime(opts:{combat?:boolean}={}):string {
  const dir=join(mkdtempSync(join(tmpdir(),'spacemolt-oracle-')),'runtime');
  mkdirSync(dir,{recursive:true});
  json(dir,'galaxy.json',{fetched_at:new Date().toISOString(),systems:{
    the_telescope:{id:'the_telescope',name:'The Telescope',x:0,y:0,connections:['last_light']},
    last_light:{id:'last_light',name:'Last Light',x:1,y:1,connections:['the_telescope']}}});
  json(dir,'places.json',{frontier_station:'the_telescope',ramens_rest:'last_light'});
  json(dir,'catalog.json',{catalog:{ships:[{id:'cobble',name:'Cobble',class:'Miner',faction:'outerrim'}]}});
  json(dir,'systems.json',{the_telescope:{police:55,security:'Patrolled (police 55)',pirates:0,at:'2026-10-17T02:00:00.000Z'}});
  json(dir,'sightings.json',{sightings:[
    {poi_id:'mobile_capital',species:'veil_ray',count:3,legal:3,at:'2026-10-17T03:10:00.000Z'}, // after the end: left out
    {poi_id:'the_telescope_entangled_drift',species:'veil_ray',count:2,legal:2,at:'2026-10-17T02:15:03.187Z'},
    {poi_id:'zeta_minor_i',count:0,legal:0,at:'2026-10-17T02:22:43.128Z'},
    {poi_id:'the_telescope_flicker_field',species:'veil_ray',count:1,legal:1,at:'2026-10-16T18:00:00.000Z'}]}); // before the span: left out
  if(opts.combat!==false)json(dir,'combat.json',{fights:[
    {battle_id:'b9',opponent:'Void Eel',ship_class:'cobble',ending:'victory',at:'2026-10-17T03:20:00.000Z',ticks:1,by_range:{},dealt:1,taken:0,stances:[],flee_ticks:0},
    {battle_id:'b2',opponent:'Veil-Ray',ship_class:'cobble',ending:'stalemate',at:'2026-10-17T02:44:34.099Z',ticks:11,by_range:{},dealt:60,taken:10,stances:['fire'],flee_ticks:0},
    {battle_id:'b1',opponent:'Veil-Ray',ship_class:'cobble',ending:'victory',at:'2026-10-17T02:20:00.000Z',ticks:9,by_range:{},dealt:60,taken:0,stances:['fire'],flee_ticks:0}]});
  return dir;
}
const start=(dir:string,run_id:string,at:string,juncture_id:string,state=ship())=>journalRun(dir,{at,phase:'started',run_id,started:at,mood:'Focused',juncture_id,start_state:state},'run');
const end=(dir:string,run_id:string,at:string,fn:string,calls:unknown[],state=ship(),outcome='done')=>
  journalRun(dir,{at,phase:'ended',run_id,outcome,work:{fn,arg:'',status:'done',credits:469,items:2,xp:117},end_state:state,calls},'run');
const call=(fn:string,did:string,fuel=0,credits=0)=>({fn,status:'done',did,credits,items:0,cost:{credits:0,fuel,hull:0,minutes:0}});

/** Juncture 50e5bfb7: one sell run. Juncture c5f4c0ff: a hunt run with two fights, then a service run. Then a later run whose fight must not count. */
function kvothe(dir:string) {
  start(dir,'r0','2026-10-17T01:52:10.579Z',EARLIER,ship({credits:301660}));
  journalRun(dir,{at:'2026-10-17T01:52:12.000Z',run_id:'r0',side:'sell',item_id:'creature_carapace',quantity:101,total:9000},'trade');
  end(dir,'r0','2026-10-17T01:52:14.936Z','sell',[call('orient','docked at frontier_station (The Telescope), fuel 120/120'),call('sell','sold 101 creature_carapace at ramens_rest for 9000 cr',0,9000)],ship({credits:310660,system:'last_light',poi:'last_light_ring',docked_at:'ramens_rest'}));
  start(dir,'r1','2026-10-17T02:10:33.653Z',J,ship({credits:310660,system:'last_light',poi:'last_light_ring',docked_at:'ramens_rest'}));
  journalRun(dir,{at:'2026-10-17T02:11:00.000Z',run_id:'r1',tool:'spacemolt',action:'jump',params:{id:'the_telescope'},ok:true,summary:'jump'},'command');
  journalRun(dir,{at:'2026-10-17T02:12:00.000Z',run_id:'r1',text:'✓ goTo  done  28s  arrived at mobile_capital after 1 jump(s); at mobile_capital (Mobile Capital), not docked: frontier_station is here'},'line');
  journalRun(dir,{at:'2026-10-17T02:12:01.000Z',run_id:'r1',text:'✓ stores  done  0.1s  holdings at frontier_station (iridium_ore, standard_rounds_box)'},'line'); // ids in brackets, not a name
  journalRun(dir,{at:'2026-10-17T02:20:00.000Z',run_id:'r1',push:'battle_ended',battle_id:'b1',reason:'victory'},'push');
  journalRun(dir,{at:'2026-10-17T02:44:34.099Z',run_id:'r1',push:'battle_ended',battle_id:'b2',reason:'stalemate'},'push');
  end(dir,'r1','2026-10-17T02:45:00.000Z','hunt',[call('goTo','arrived at mobile_capital',8),call('hunt','2 fights, 1 won')],ship({credits:316184}));
  start(dir,'r2','2026-10-17T02:42:36.813Z',J,ship({credits:316184}));
  end(dir,'r2','2026-10-17T02:52:34.911Z','service',[call('orient','docked at frontier_station (The Telescope)'),call('hunt','no prey'),call('service','refuelled')]);
  start(dir,'r3','2026-10-17T03:15:00.000Z','later000000000000000000000000000');
  journalRun(dir,{at:'2026-10-17T03:20:00.000Z',run_id:'r3',push:'battle_ended',battle_id:'b9',reason:'victory'},'push');
  journalRun(dir,{at:'2026-10-17T03:21:00.000Z',run_id:'r3',text:'Frontier Station is busy'},'line');
  end(dir,'r3','2026-10-17T03:25:00.000Z','hunt',[call('hunt','1 fight')]);
}

test('a juncture\'s scene is its last ended run, as of that run\'s end',async()=>{
  const dir=runtime();
  try {
    kvothe(dir);
    const [s]=await scenes(dir,'c5f4c0ff');
    assert.ok(s);
    assert.equal(s.run_id,'r2');assert.equal(s.juncture_id,J);assert.equal(s.ended,'2026-10-17T02:52:34.911Z');
    assert.deepEqual(s.where,{system:'the_telescope',system_name:'The Telescope',poi:'mobile_capital',poi_name:'Mobile Capital',poi_type:null,poi_class:null,sun:null,
      docked_at:'frontier_station',base_name:'Frontier Station',security:'Patrolled (police 55)',empire:null}); // names are identities: "Frontier Station" is written after the end and still names it; "(The Telescope)" after the base id is the system's name
    assert.deepEqual(s.status,{hull:80,max_hull:80,fuel:120,max_fuel:120,credits:316653,cargo_used:32,cargo_capacity:75,
      cargo:[{item_id:'copper_piping',quantity:29},{item_id:'fuel_cell',quantity:3}],ship_class:'cobble',ship_class_seen_at:'2026-10-17T02:44:34.099Z',ship_class_seen_after_end:false,
      ship_name:'Cobble',ship_faction:'outerrim',ship_role:'Miner'});
    assert.deepEqual(s.company,{creatures:[],ships:[],nearby:[{poi:'the_telescope_entangled_drift',poi_name:'The Telescope Entangled Drift',species:'veil_ray',count:2,seen_at:'2026-10-17T02:15:03.187Z'}]}); // no name known anywhere: the id title-cased
    assert.deepEqual(s.lately.runs.map(r=>[r.run_id,r.fn]),[['r0','sell'],['r1','hunt'],['r2','service']]);
    assert.deepEqual(s.lately.fights,{count:2,won:1,lost:0,other:1,last_opponent:'Veil-Ray'});
    assert.deepEqual(s.lately.trades,{bought:{},sold:{creature_carapace:101},places:[{id:'ramens_rest',name:'Ramens Rest'}]});
    assert.deepEqual(s.lately.systems.map(x=>x.id),['the_telescope','last_light','the_telescope']);
    assert.deepEqual(s.lately.wallet,{start:301660,end:316653,change:14993});
    assert.deepEqual(s.lately.span,{start:'2026-10-17T01:52:10.579Z',end:'2026-10-17T02:52:34.911Z',hours:1.01});
    assert.deepEqual(s.flags,{in_battle:false,hull_low:false,fuel_low:false,fresh_from:'hunt'}); // r2's `hunt` call is done, though it found nothing
    assert.deepEqual(s.scope,{start:'2026-10-17T02:45:00.000Z',end:s.ended}); // the flight: from r1's end, the previous picture, though r1 is this juncture's too
    assert.equal(s.moment,null); // r2 only serviced: the fights and the jump are r1's flight, not this one's
    const [r1]=await scenes(dir,'r1');
    assert.ok(r1?.moment&&r1.moment.start>=r1.scope.start&&r1.moment.end<=r1.ended,'the moment lies inside the scope'); // moments.ts: the fights and the jump of r1
    assert.ok(r1.moment.events.every(e=>e.approximate)); // no frames.jsonl: the journal
    assert.deepEqual(oracleLine(s),{event:'oracle',run_id:'r2',juncture_id:J,scene:s});
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('later sightings, fights and names are left out; the latest scene has them',async()=>{
  const dir=runtime();
  try {
    kvothe(dir);
    const [then]=await scenes(dir,'r2'),[now]=await scenes(dir,'latest');
    assert.equal(then?.company.creatures.length,0);
    assert.equal(then?.lately.fights.count,2);
    assert.equal(now?.run_id,'r3');
    assert.deepEqual(now?.company.creatures,[{poi:'mobile_capital',poi_name:'Mobile Capital',species:'veil_ray',count:3,seen_at:'2026-10-17T03:10:00.000Z'}]);
    assert.equal(now?.lately.fights.last_opponent,'Void Eel');
    assert.equal(now?.where.base_name,'Frontier Station');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('a ship class known only after the end stands in, flagged as a lookahead',async()=>{
  const dir=runtime();
  try {
    kvothe(dir);
    const [s]=await scenes(dir,'50e5bfb7'); // every fight in combat.json is after r0's end
    assert.deepEqual([s?.status.ship_class,s?.status.ship_class_seen_at,s?.status.ship_class_seen_after_end,s?.status.ship_name],['cobble','2026-10-17T03:20:00.000Z',true,'Cobble']);
    const [t]=await scenes(dir,'c5f4c0ff');
    assert.equal(t?.status.ship_class_seen_after_end,false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('--last N gives that many runs ending at the selected one',async()=>{
  const dir=runtime();
  try {
    kvothe(dir);
    assert.deepEqual((await scenes(dir,'c5f4c0ff',2)).map(s=>[s.juncture_id?.slice(0,8),s.run_id]),[['c5f4c0ff','r1'],['c5f4c0ff','r2']]);
    assert.deepEqual((await scenes(dir,'latest',9)).map(s=>s.run_id),['r0','r1','r2','r3']);
    assert.deepEqual(await scenes(dir,'nosuchid'),[]);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('an undocked run with an unknown ship class: no base, no class, travel when a goTo spent fuel',async()=>{
  const dir=runtime({combat:false});
  try {
    const away={system:'last_light',poi:'last_light_ring',docked_at:null,hull:40,fuel:10};
    start(dir,'r1','2026-10-17T02:10:00.000Z',J);
    end(dir,'r1','2026-10-17T02:30:00.000Z','goTo',[call('goTo','arrived at last_light_ring',12),call('sell','sold nothing')],ship(away),'partial');
    const [s]=await scenes(dir,'latest');
    assert.ok(s);
    assert.equal(s.where.docked_at,null);assert.equal(s.where.base_name,null);assert.equal(s.where.system_name,'Last Light');assert.equal(s.where.security,null);
    assert.equal(s.status.ship_class,null);assert.equal(s.status.ship_name,null);assert.equal(s.status.ship_class_seen_at,null);
    assert.deepEqual(s.flags,{in_battle:false,hull_low:true,fuel_low:true,fresh_from:'travel'}); // a sell that sold nothing is not trade; Focused: walk away under 72 of 80, fuel reserve 24
    assert.equal(s.outcome,'partial');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('the lately window holds at most ten runs and six hours',async()=>{
  const dir=runtime();
  try {
    start(dir,'old','2026-10-16T18:00:00.000Z',J);end(dir,'old','2026-10-16T18:10:00.000Z','hunt',[]);
    for(let i=0;i<12;i++){const at=`2026-10-17T0${Math.floor(i/6)}:${String((i%6)*10).padStart(2,'0')}:00.000Z`;start(dir,`r${i}`,at,J);end(dir,`r${i}`,at.replace(':00.000Z',':05.000Z'),'service',[]);}
    const [s]=await scenes(dir,'latest');
    assert.deepEqual(s?.lately.runs.map(r=>r.run_id),['r2','r3','r4','r5','r6','r7','r8','r9','r10','r11']);
    start(dir,'late','2026-10-17T06:55:00.000Z',J);end(dir,'late','2026-10-17T07:00:00.000Z','service',[]);
    const [t]=await scenes(dir,'latest');
    assert.deepEqual(t?.lately.runs.map(r=>r.run_id),['r6','r7','r8','r9','r10','r11','late']);
    assert.equal(t?.moment,null); // nothing in the window scores
  } finally {rmSync(dir,{recursive:true,force:true});}
});

// Live 2026-10-20 (kvothe 58746f94): a juncture of 40 runs over 9.5 h looked for each post's moments in all of it.
test('a long juncture\'s scope is the flight: from the previous run\'s end, though it is the same juncture\'s',async()=>{
  const dir=runtime();
  try {
    start(dir,'prev','2026-10-17T00:00:00.000Z',EARLIER);end(dir,'prev','2026-10-17T00:05:00.000Z','sell',[]);
    const lines:string[]=[];
    for(let i=0;i<14;i++) { // 14 runs of 302 lines: the first read (4000 lines) starts inside the second
      const t=Date.parse('2026-10-17T01:00:00.000Z')+i*600_000,iso=(ms:number)=>new Date(ms).toISOString();
      lines.push(JSON.stringify({at:iso(t),event:'run',phase:'started',run_id:`j${i}`,started:iso(t),juncture_id:J,start_state:ship()}));
      for(let k=0;k<300;k++)lines.push(JSON.stringify({at:iso(t+1000+k),event:'line',run_id:`j${i}`,text:'tick'}));
      lines.push(JSON.stringify({at:iso(t+300_000),event:'run',phase:'ended',run_id:`j${i}`,outcome:'done',end_state:ship(),calls:[]}));
    }
    appendFileSync(join(dir,'gameplay.jsonl'),`${lines.join('\n')}\n`);
    const [s]=await scenes(dir,'latest');
    assert.equal(s?.scope.start,'2026-10-17T03:05:00.000Z'); // j12's end
  } finally {rmSync(dir,{recursive:true,force:true});}
});

// Live 2026-10-19 (kvothe 06:03Z): a pirate's battle at Kael Arsenal, the station's guns destroyed the Dust Devil 16 s after a
// refused run ended, and the next run flew the respawned Cobble from First Step. The picture of the death drew a Cobble, the
// caption put it at First Step with "no fights", and the pirate's Eviction Notice sent no art. The frames are the live ones
// (test-support/frames-kvothe-2026-10-19.jsonl); the journal is cut to the runs and the lines between them.
test('a scene whose moment is a death in battle: the ship, the place and the fight are the moment\'s, from the frames',async()=>{
  const J2='cd2950810c14498b961291a594295a4f',dir=join(mkdtempSync(join(tmpdir(),'spacemolt-oracle-')),'runtime');
  try {
    mkdirSync(dir,{recursive:true});
    copyFileSync(new URL('../test-support/frames-kvothe-2026-10-19.jsonl',import.meta.url),join(dir,'frames.jsonl'));
    json(dir,'galaxy.json',{fetched_at:new Date().toISOString(),systems:{xamidimura:{id:'xamidimura',name:'Xamidimura',x:0,y:0,connections:[]},first_step:{id:'first_step',name:'First Step',x:1,y:1,connections:[]}}});
    json(dir,'catalog.json',{catalog:{ships:[{id:'cobble',name:'Cobble',class:'Miner',faction:'outerrim'},{id:'dust_devil',name:'Dust Devil',class:'Blockade Runner',faction:'outerrim'},
      {id:'eviction_notice',name:'Eviction Notice',class:'Cruiser',faction:'pirate',weapon_slots:5}]}});
    const fsms='first_step_memorial_station',at={system:'xamidimura',poi:'kael_arsenal',docked_at:null};
    start(dir,'9b8b1a19','2026-10-19T05:57:21.810Z',J2,ship({credits:562347,...at}));
    end(dir,'9b8b1a19','2026-10-19T06:02:48.271Z','acceptMission',[],ship({credits:562347,...at}),'refused');
    journalRun(dir,{at:'2026-10-19T06:02:55.005Z',push:'battle_alert',battle_id:'8c72b3c372fbf0a0414c983c75c565c4',system_id:'xamidimura'},'push'); // between runs: no run_id
    journalRun(dir,{at:'2026-10-19T06:03:04.878Z',respawn_base:'frontier_station',ship_lost:'dust_devil',wreck_poi_id:'kael_arsenal',wreck_system_id:'xamidimura',cause:'combat'},'death');
    start(dir,'9b993e0a','2026-10-19T06:03:16.503Z',J2,ship({credits:561772,system:'first_step',poi:'mobile_capital',docked_at:'frontier_station'}));
    end(dir,'9b993e0a','2026-10-19T06:04:40.000Z','goTo',[],ship({credits:561772,system:'first_step',poi:fsms,docked_at:fsms,hull:110,max_hull:110}));
    const [s]=await scenes(dir,'cd295081');
    assert.ok(s);
    const rows:[string,unknown,unknown][]=[
      ['A: the ship at the moment, not the respawn',[s.status.ship_class,s.status.ship_name,s.status.ship_class_seen_at],['dust_devil','Dust Devil','2026-10-19T06:03:04.877Z']],
      ['A, D: the one reference is the pirate\'s ship, with its catalog facts',[s.subject,s.subject&&refOf(s.subject).url],
        [{kind:'ship',id:'eviction_notice',category:'hazard',name:'Eviction Notice',faction:'pirate',role:'Cruiser',weapon_slots:5,description:null,fought:true,other_side:null},'https://assets.spacemolt.com/images/ships/catalog/eviction_notice.webp']],
      ['B: one death',s.moment?.events.filter(e=>e.category==='hazard').map(e=>e.type),['player_died']],
      ['C: the place is the moment\'s',[s.where.system,s.where.system_name,s.where.poi,s.where.poi_name,s.where.docked_at],['xamidimura','Xamidimura','kael_arsenal','Kael Arsenal',null]],
      ['C: the fight counts, from the frames',s.lately.fights,{count:1,won:0,lost:1,other:0,last_opponent:'Commodore'}],
      ['C: the death between runs counts',s.lately.deaths,1],
      ['C: the caption',caption(s),'Kael Arsenal, Xamidimura · hull 110/110, fuel 120/120, hold 32/75, 561,772 cr · lately: 1 fight, lost, -575 cr over 7 minutes'],
      ['E: the approved prompt, from the frames',prompt('selfie',s,STYLE,0),CD295081],
    ];
    for(const [what,actual,want] of rows)assert.deepEqual(actual,want,what);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

const KVOTHE_SOUL=`You are Kvothe, a pilot in SpaceMolt.

You were orphaned young and taught yourself to survive.

You are a small, lean man, built like a load-bearing rope, with shoulders a touch too broad for the frame, hair the colour of wet ash cut short at the sides, a face that is unremarkable at a distance, and scarred, knuckled hands you have never bothered to hide. Your eyes are the one thing you never let rest.

> My name is Kvothe.`;
// Live 2026-10-19: the look as the whole physical sentence ran to 50 words; the picture wants the pilot small in a corner.
test('the pilot\'s look is a few of SOUL.md\'s own words: the head of its physical sentence and the hair; none is null',()=>{
  assert.equal(pilotLook(KVOTHE_SOUL),'a small, lean man with hair the colour of wet ash');
  for(const word of (pilotLook(KVOTHE_SOUL)??'').split(/[\s,]+/))assert.ok(KVOTHE_SOUL.includes(word),word);
  assert.equal(pilotLook('You are Mira.\n\nYou are a tall woman with close-cropped silver hair, a freckled face and steady grey eyes, and your hands are never still.'),'a tall woman with close-cropped silver hair');
  assert.equal(pilotLook('Mira is a tall woman, her hair silver, with a scarred face and grey eyes.'),'a tall woman'); // a part in the third person goes
  assert.equal(pilotLook('You are Ash, a pilot.\n\nYou distrust empires and keep your word.'),null);
  assert.equal(pilotLook(''),null);
  assert.equal(pilotEyes(KVOTHE_SOUL),null); // "your eyes are the one thing you never let rest" says no colour
});

// Kvothe's SOUL.md as rewritten 2026-10-19. Camera spike: with no clothing named the pilot was drawn as an airline captain; the
// hand-written "a small, lean man with fiery red hair, in travel-worn utility clothes with many pockets" drew a jacket with pockets.
const KVOTHE_SOUL_1019=`You are Kvothe, a pilot in SpaceMolt.

You are a small, lean man, built like a load-bearing rope, with shoulders a touch too broad for the frame, fiery red hair cut short at the sides, a face that is unremarkable at a distance, and scarred, knuckled hands you have never bothered to hide. You wear sturdy, practical clothes, travel-worn and customised for utility, pockets everywhere, the materials simple but not rough. Your eyes are a deep green that shifts with your mood, the one thing you never let rest, and the easy smile you meet strangers with is a door you built long ago, with a tired man who counts the exits standing behind it.`;
test('the look is build, hair and clothing in SOUL.md\'s own words; the eyes apart, for the side camera; any part it lacks is absent',()=>{
  const look=pilotLook(KVOTHE_SOUL_1019);
  assert.equal(look,'a small, lean man with fiery red hair, in sturdy, practical clothes, travel-worn and customised for utility');
  for(const word of (look??'').split(/[\s,]+/))assert.ok(word==='in'||KVOTHE_SOUL_1019.includes(word),word);
  assert.equal(pilotEyes(KVOTHE_SOUL_1019),'deep green eyes');
  const mira='You are Mira, a courier.\n\nYou are a tall woman with close-cropped silver hair, a freckled face and steady grey eyes, and your hands are never still. You are dressed in a long grey greatcoat with brass buttons, its hem frayed from years of docks.\n\n> Deliver, then ask.';
  assert.equal(pilotLook(mira),'a tall woman with close-cropped silver hair, in a long grey greatcoat with brass buttons');
  assert.equal(pilotEyes(mira),'steady grey eyes');
  assert.equal(pilotLook('You are Oren.\n\nYou are a stocky man with a shaved head and a scarred face, and your hands are steady.'),'a stocky man with a shaved head and a scarred face'); // no hair, clothes or eyes said
  assert.equal(pilotEyes('You are Oren.\n\nYou are a stocky man with a shaved head and a scarred face.'),null);
});
