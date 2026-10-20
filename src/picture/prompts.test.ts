/** The picture templates over a Scene (`prompts.ts`): the loose selfie and the spike's scene recipe from facts only, generic across pilots. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {CD295081,blankScene,kvotheScene,scoredEvent as ev,withMoment} from '../test-support/scene.ts';
import {STYLE,seedOf} from './imager.ts';
import type {Scene} from './oracle.ts';
import {CAMERAS,CAMERA_ORDER,POSES,SETTINGS,SLOT_SOURCES,SOURCES,TEMPLATES,annotate,annotateWords,caption,pathsIn,picture,prompt,promptOf,pronounOf} from './prompts.ts';

const PRONOUN=/\b(he|she|they|him|her|hers|his|them|their|theirs)\b/i;
/** Capitalised words that do not open a sentence: the proper nouns a prompt holds. */
const properNouns=(text:string)=>[...text.matchAll(/(?<![.:!?]\s|^)\b[A-Z][\w'-]+/g)].map(m=>m[0]);
const COCKPIT='a worn starship cockpit of brass and leather';
/** The selfie up to its subject, for a seed's camera: 0 shoulder, 1 side, 2 wide. */
const CAM=(own:string,o:{seed?:0|1|2;cracked?:boolean;look?:string;docked?:boolean;gaze?:string;their?:string}={})=>{
  const canopy=o.cracked?'a canopy, its glass cracked and webbed,':'the canopy',pilot=`the pilot${o.look?`, ${o.look}`:''}`,their=o.their??'their';
  const view=o.docked?"the station's lit docking ring":'open space and a black starfield';
  return `S: ${[`from the pilot's seat of ${own}, ${COCKPIT}, through ${canopy} onto ${view}, ${pilot}, small in the lower left corner`,
    `a side view across the cockpit of ${own}, ${COCKPIT}: ${pilot}, seen in profile from ${their} left, ${o.gaze??`${their} eyes`} on the canopy at the right of the frame, through ${canopy} onto ${view}`,
    `a wide shot of the whole cockpit of ${own} from behind, ${COCKPIT}, ${pilot}, small in ${their} seat at the centre, through ${canopy} onto ${view}`][o.seed??0]}; `;
};
const subject=(s:Scene,o:Partial<NonNullable<Scene['subject']>>&{kind:'ship'|'creature'|'item';id:string}):Scene=>
  ({...s,subject:{category:'combat',name:o.id,faction:null,role:null,weapon_slots:null,description:null,fought:true,other_side:null,...o}});

test('the approved death picture: the camera first, the pirate\'s ship from image 1 with its catalog design, filling the canopy and diving at us, the station\'s guns beyond',()=>{
  const k=kvotheScene(),death=ev('player_died',{identities:[{kind:'ship_class',id:'eviction_notice'},{kind:'opponent',id:'Commodore'}],facts:{cause:'combat',foe_kind:'pirate',foe_name:'Commodore',foe_ship:'Eviction Notice'},score:6});
  const shot=ev('battle_damage',{facts:{gunner:'Kael Arsenal Station',weapons:'Harpoon Emplacement|Scrap Flak Battery',foe_name:'Commodore'},score:4});
  const s=subject(withMoment({...k,status:{...k.status,ship_class:'dust_devil',ship_name:'Dust Devil',ship_role:'Blockade Runner'}},death,[shot]),
    {kind:'ship',id:'eviction_notice',category:'hazard',name:'Eviction Notice',faction:'pirate',role:'Cruiser',weapon_slots:5});
  assert.equal(prompt('selfie',s,STYLE,0),CD295081);
  assert.equal(prompt('scene',s,STYLE),"hand-inked illustration, warm lamplight, deep indigo shadows, fine crosshatching: from just behind a blockade runner, out onto open space and a black starfield, its stern small in the lower left corner; the pirate cruiser from <image1> with five gun mounts, large and close in the upper right, dives straight at us nose-first, bright tracer bolts streaking from its turrets toward us, the station's flak batteries flashing beyond.");
  assert.deepEqual(properNouns(prompt('selfie',s,STYLE,0)),[]); // names are the caption's
});

// Camera spike (2026-10-19): naming the viewpoint and where things sit in the frame re-posed the shot; the seat alone was one shot.
test('the selfie\'s camera is the seed\'s, one of three; the eyes only in the side view; the pronoun the look\'s own',()=>{
  const look='a small, lean man with fiery red hair, in sturdy, practical clothes, travel-worn and customised for utility';
  const s={...kvotheScene(),where:{...kvotheScene().where,docked_at:null},look,eyes:'deep green eyes'};
  const tail='a distant sun ahead, large and filling the canopy.';
  assert.deepEqual(CAMERA_ORDER,['shoulder','side','wide']);
  assert.deepEqual([0,1,2].map(seed=>prompt('selfie',s,'S',seed)),[0,1,2].map(seed=>`${CAM('a miner ship',{seed:seed as 0|1|2,look,their:'his',gaze:'his deep green eyes'})}${tail}`));
  assert.equal(prompt('selfie',s,'S',4),prompt('selfie',s,'S',1)); // seed % 3
  assert.equal(prompt('selfie',s,'S'),prompt('selfie',s,'S',seedOf(s.run_id))); // by default the run's seed
  assert.doesNotMatch(prompt('selfie',s,'S',0)+prompt('selfie',s,'S',2),/green/);
  assert.match(prompt('selfie',{...s,eyes:null},'S',1),/seen in profile from his left, his eyes on the canopy/);
  assert.deepEqual([pronounOf('a tall woman with silver hair'),pronounOf(look),pronounOf(null),pronounOf('a wiry pilot')],['her','his','their','their']);
  for(const k of CAMERA_ORDER)assert.ok(annotateWords().includes(CAMERAS[k]),k);
});

test('a Scene with no moment and every optional fact empty renders the camera and a sun: no gendered pronoun, no proper noun',()=>{
  for(const seed of [0,1,2]) {
    const got=prompt('selfie',blankScene(),STYLE,seed);
    assert.ok([...got.matchAll(new RegExp(PRONOUN,'gi'))].every(m=>m[0]==='their'),got); // no look: "their"
    assert.deepEqual(properNouns(got),[]);
    assert.doesNotMatch(got,/\{|\}|\[|\]|undefined|null|NaN|image/);
  }
  assert.doesNotMatch(prompt('scene',blankScene(),STYLE),PRONOUN);
  assert.doesNotMatch(prompt('scene',blankScene(),STYLE),/image1/);
  // Every system has a sun: with nothing else known, it is what there is to see.
  assert.equal(prompt('selfie',blankScene(),'S',0),`${CAM("the pilot's ship")}a distant sun ahead, large and filling the canopy.`);
  assert.equal(prompt('scene',blankScene(),'S'),"S: from just behind the pilot's ship, out onto open space and a black starfield, its stern small in the lower left corner; a distant sun beyond.");
});

// Live 2026-10-19 (kvothe 0d8e53df): docked, the prompt said both open space and the berths close outside; then, the open space
// gone, "the berths" drew bunk beds and every docked view went planet-side. The docking ring, and one anchor in space.
test('with no moment the ship is where it ended: docked, the docking ring against black space; in space, what its POI shows',()=>{
  const k=kvotheScene();
  assert.equal(prompt('selfie',k,'S',0),`${CAM('a miner ship',{docked:true})}the docking ring close outside, filling the canopy, the station hanging in black space among the stars.`);
  assert.equal(prompt('scene',k,'S'),"S: from just behind a miner ship, out onto the station's lit docking ring close outside, the station hanging in black space among the stars, its stern small in the lower left corner.");
  assert.match(prompt('selfie',{...k,where:{...k.where,docked_at:null,poi_type:'station'}},'S'),/starfield; a station's lit structure ahead, large and filling the canopy\.$/);
  assert.match(prompt('selfie',{...k,flags:{...k.flags,hull_low:true}},'S'),/a canopy, its glass cracked and webbed,/);
  assert.match(prompt('selfie',{...k,where:{...k.where,sun:'M2III'}},'S'),/, the station hanging in black space among the stars, under a red giant sun\.$/);
});

test('a creature is named from image 1 with its name\'s clause; fought, it fills the canopy and lunges; else it glides',()=>{
  const fight=ev('battle_ended',{identities:[{kind:'opponent',id:'Patina-Grazer'},{kind:'species',id:'patina_grazer'}],score:2});
  const s=subject(withMoment(kvotheScene(),fight),{kind:'creature',id:'patina_grazer',name:'Patina-Grazer'});
  assert.equal(prompt('selfie',s,'S',0),`${CAM('a miner ship',{cracked:true})}the creature from <image1>, a grazer-like creature with patina-like features, large and filling the canopy, lunges straight at us head-first, its limbs flung wide, weapons fire crossing the dark.`);
  assert.equal(picture(subject(s,{kind:'creature',id:'patina_grazer',category:'discovery',fought:false})).pose,'glides across the stars above us, its belly toward us');
  assert.match(prompt('selfie',subject(s,{kind:'creature',id:'glimmerkin',name:'Glimmerkin'}),'S'),/the creature from <image1>, large and filling the canopy, lunges/); // one word says nothing more
});

// Live 2026-10-18 (kvothe a28932b8): Copper Wiring, made at a mill, flew like a missile through rocks with "the mining beam lit".
// Camera spike (2026-10-19): a thing on the console hardly shows; the loose selfie draws what is outside.
test('an item is no subject of a selfie, which names no image: the station at work, or the body mined; a scene has no console either',()=>{
  const craft=ev('spacemolt/craft',{identities:[{kind:'item',id:'copper_wiring'},{kind:'poi',id:'mobile_capital'}],facts:{venue:'Copper Wire Mill'},
    pilot:{system:'void_gate',poi:'mobile_capital',docked_at:'frontier_station',ship_class:'cobble'},score:1});
  const s=subject(withMoment(kvotheScene(),craft,[],[],{frontier_station:'Frontier Station',mobile_capital:'Mobile Capital'}),
    {kind:'item',id:'copper_wiring',category:'crafting',name:'Copper Wiring',description:'Bundled conductive wiring for electrical systems.'});
  assert.equal(prompt('selfie',s,'S',0),`${CAM('a miner ship',{docked:true})}the docking ring close outside, filling the canopy, the station's copper wire mill working, the station hanging in black space among the stars.`);
  assert.equal(promptOf('selfie',s,'S').subject,false);
  const mined=subject(withMoment({...kvotheScene(),where:{...kvotheScene().where,docked_at:null}},ev('mining_yield',{identities:[{kind:'item',id:'iron_ore'}]})),{kind:'item',id:'iron_ore',category:'extraction',name:'Iron Ore'});
  assert.equal(prompt('selfie',mined,'S',0),`${CAM('a miner ship')}a tumbling asteroid, large and filling the canopy, a mining beam cutting into it, loose rock spraying.`);
  assert.equal(prompt('scene',s,'S'),"S: from just behind a miner ship, out onto the station's copper wire mill working, the station hanging in black space among the stars, its stern small in the lower left corner.");
  assert.equal(picture(s).pose,null);
  const sold=withMoment(kvotheScene(),ev('spacemolt/sell',{facts:{base_id:'frontier_station'}}));
  assert.match(prompt('selfie',sold,'S'),/; the docking ring close outside, filling the canopy, its cargo lifters at work, the station hanging/);
  // Live 2026-10-17 (kvothe ae04e821): a cockpit setting is no view; docked, the ring is.
  assert.match(prompt('selfie',withMoment(kvotheScene(),ev('skill_level_up')),'S'),/; the docking ring close outside, filling the canopy, the station hanging in black space among the stars\.$/);
});

// Live 2026-10-19 (kvothe 7b7030a8): the Dialectic, in someone else's battle, was drawn diving at us.
test('a ship in a battle the pilot did not fight is far off, broadside, trading fire with the other side',()=>{
  const alert=ev('battle_alert',{identities:[{kind:'ship_class',id:'dialectic'}],facts:{other_side:'Patina-Grazer'},involvement:0.5,score:2});
  const s=subject(withMoment(kvotheScene(),alert),{kind:'ship',id:'dialectic',name:'Dialectic',faction:'solarian',role:'Assault',weapon_slots:5,fought:false,other_side:'creature'});
  assert.match(prompt('selfie',s,'S'),/; the assault ship from <image1> with five gun mounts, trading fire with a creature in the distance, broadside to us, weapons fire crossing the dark\.$/);
  assert.equal(picture(subject(s,{kind:'ship',id:'dialectic',fought:false})).pose,'trading fire in the distance, broadside to us');
});

test('the pilot\'s look is the pilot the selfie shows; a scene has no pilot',()=>{
  const look='a small, lean man with hair the colour of wet ash',s={...kvotheScene(),look};
  assert.equal(prompt('selfie',s,'S',0),`${CAM('a miner ship',{look,docked:true})}the docking ring close outside, filling the canopy, the station hanging in black space among the stars.`);
  assert.doesNotMatch(prompt('scene',s,'S'),/wet ash/);
});

test('a ship\'s design clause drops what the catalog lacks: no gun mounts, then no faction',()=>{
  const s=withMoment(kvotheScene(),ev('battle_started',{score:2}));
  const ship=(o:Partial<NonNullable<Scene['subject']>>)=>prompt('selfie',subject({...s,where:{...s.where,docked_at:null}},{kind:'ship',id:'x',name:'Lawn Dart',...o}),'S').split('; ')[1];
  // Named by kind: the class as a vessel, "pirate" its one faction word; the empire's name draws nothing.
  assert.equal(ship({faction:'outerrim',role:'Freighter',weapon_slots:1}),'the freighter from <image1> with one gun mount, large and filling the canopy, dives straight at us nose-first, bright tracer bolts streaking from its turrets toward us, weapons fire crossing the dark.');
  assert.equal(ship({faction:'pirate',role:'Assault',weapon_slots:0}),'the pirate assault ship from <image1>, large and filling the canopy, dives straight at us nose-first, bright tracer bolts streaking from its turrets toward us, weapons fire crossing the dark.');
  assert.equal(ship({}),'the ship from <image1>, large and filling the canopy, dives straight at us nose-first, bright tracer bolts streaking from its turrets toward us, weapons fire crossing the dark.');
});

// Live 2026-10-19 (kvothe 7b7030a8): "the lights of Bharani Star" drew an empty window; the star is a sun, and a sun can be drawn.
// Camera spike (2026-10-19): the mission's objective marker on the console hardly showed, and is dropped.
test('a mission and a jump show the place ahead, filling the canopy; a sun that is the subject is no light beside it',()=>{
  const k=kvotheScene(),at={...k.where,docked_at:null,poi_type:'sun',poi_class:'M2III',sun:'M2III'};
  const mission=withMoment({...k,where:at},ev('spacemolt/complete_mission',{identities:[{kind:'poi',id:'bharani_star'}]}),[],[],{bharani_star:'Bharani Star'});
  assert.equal(prompt('selfie',mission,'S',0),`${CAM('a miner ship')}a red giant sun ahead, large and filling the canopy.`);
  assert.equal(prompt('selfie',withMoment({...k,where:at},ev('spacemolt/jump')),'S',0),`${CAM('a miner ship')}a red giant sun ahead, large and filling the canopy.`);
  assert.match(prompt('selfie',withMoment({...k,where:{...at,poi_type:'planet'}},ev('spacemolt/jump')),'S'),/; a looming planet ahead, large and filling the canopy, under a red giant sun\.$/);
});

test('mining shows the body mined, filling the canopy, by the place\'s kind, under the system\'s sun',()=>{
  const at=(poi_type:string)=>prompt('selfie',{...withMoment(blankScene(),ev('mining_yield')),where:{...blankScene().where,poi_type,sun:'M2III'}},'S').split('; ')[1];
  assert.deepEqual([at('gas_cloud'),at('ice_field'),at('asteroid_belt')],['a glowing gas cloud, large and filling the canopy, the harvester drawing it in, under a red giant sun.',
    'a tumbling chunk of ice, large and filling the canopy, a mining beam cutting into it, loose ice spraying, under a red giant sun.',
    'a tumbling asteroid, large and filling the canopy, a mining beam cutting into it, loose rock spraying, under a red giant sun.']);
});

test('each category has its setting, verbatim, from the lead\'s own fields or a generic noun',()=>{
  const NAMES={frontier_station:'Frontier Station',the_telescope:'The Telescope'};
  const setting=(e:ReturnType<typeof ev>,more:ReturnType<typeof ev>[]=[])=>picture(withMoment(blankScene(),e,more,[],NAMES)).setting;
  const cases:[ReturnType<typeof ev>,string][]=[
    [ev('battle_ended'),'weapons fire crossing the dark'],
    [ev('battle_damage',{facts:{gunner:'Kael Arsenal Station',weapons:'Harpoon Emplacement|Railgun'}}),"the station's railguns flashing beyond"],
    [ev('battle_damage',{facts:{gunner:'Kael Arsenal Station'}}),"the station's guns flashing beyond"],
    [ev('battle_damage',{facts:{gunner:'Ann',weapons:'Autocannon'}}),'autocannons flashing beyond'], // a player's name draws nothing
    [ev('stranded',{category:'hazard'}),'debris tumbling past'],
    [ev('spacemolt/sell',{facts:{base_id:'frontier_station'}}),"the cargo lifters of the station's docking ring at work"],
    [ev('mining_yield'),'a mining beam cutting into a tumbling asteroid ahead, loose rock spraying'],
    [ev('mining_yield',{pilot:{system:null,poi:null,docked_at:null,ship_class:null,poi_type:'gas_cloud'}}),'a mining beam cutting into a tumbling asteroid ahead, loose rock spraying'], // the setting reads the scene's place

    [ev('spacemolt/craft',{facts:{venue:'Copper Wire Mill'},pilot:{system:null,poi:null,docked_at:'frontier_station',ship_class:null}}),"the station's copper wire mill working"],
    [ev('crafting_update'),"the station's docking ring"],
    [ev('spacemolt/jump',{identities:[{kind:'system',id:'the_telescope'}]}),'a distant sun ahead'],
    [ev('spacemolt/complete_mission'),'an objective marker glowing on the console, a distant sun beyond'],
    [ev('scan_detected',{facts:{scanner_ship_class:'lawn_dart'}}),'a ship sweeping us with scanners'],
    [ev('drone_survey',{identities:[{kind:'species',id:'veil_ray'}]}),'a never-seen creature glowing ahead'],
    [ev('skill_level_up'),'a new commendation glowing on the dash'],
    [ev('spacemolt/repair',{facts:{base_id:'frontier_station'}}),"the station's docking ring"],
    [ev('faction_alliance_formed',{facts:{with_faction_name:'Iron Reach'}}),'ships holding formation beyond'],
    [ev('chat_message',{facts:{sender:'Ann'}}),'a message lit on the console'],
    [ev('spacemolt_salvage/loot',{facts:{wreck_of:'Veil-Ray',wreck_foe:'creature'}}),"a creature's carcass drifting beyond"],
    [ev('spacemolt_salvage/loot',{facts:{wreck_of:'Commodore',wreck_foe:'ship'}}),'the wreck drifting beyond'],
  ];
  for(const [e,want] of cases)assert.equal(setting(e),want,e.type);
  // The gunner is the moment's, whichever event leads.
  assert.equal(setting(ev('player_died',{score:6}),[ev('battle_damage',{facts:{gunner:'Kael Arsenal Station',weapons:'Scrap Flak Battery'},score:4})]),"the station's flak batteries flashing beyond");
  const at=(poi_type:string)=>picture({...withMoment(blankScene(),ev('mining_yield')),where:{...blankScene().where,poi_type}}).setting;
  assert.deepEqual([at('gas_cloud'),at('ice_field')],['the harvester drawing in a glowing gas cloud','a mining beam cutting into a tumbling chunk of ice ahead, loose ice spraying']);
  assert.equal(setting(ev('action_error',{score:5})),'a distant sun beyond'); // system & connection is never depicted: the rest, and every system has a sun
  assert.deepEqual(Object.keys(SETTINGS).sort(),['combat','crafting','discovery','economy','extraction','faction','hazard','holdings','missions','progression','rest','social','travel','wreck']);
  assert.deepEqual(Object.keys(POSES).sort(),['creature','ship']);
});

// Live 2026-10-19 (kvothe 08:41Z): a creature listed by its instance id reached the prompt as "Crt Dc1f7b404a048a10e48d7168f2632098 fills the view".
test('a raw id never reaches a prompt: a slot takes its generic noun or fails',()=>{
  const raw='e505e6ed397cbc56a7d098249792f59d';
  assert.equal(picture(withMoment(blankScene(),ev('spacemolt/sell',{facts:{base_id:raw}}))).setting,"the cargo lifters of the station's docking ring at work");
  assert.doesNotMatch(prompt('selfie',{...blankScene(),where:{...blankScene().where,poi:raw}},'S'),/[0-9a-f]{16}/i);
  assert.doesNotMatch(prompt('selfie',subject(blankScene(),{kind:'ship',id:raw,name:raw}),'S'),/[0-9a-f]{16}/i); // named by kind: "the ship"
});

test('a second player with another ship and moment carries none of Kvothe\'s words',()=>{
  const s=blankScene();
  const base={...s,where:{...s.where,system:'halcyon',system_name:'Halcyon',poi:'halcyon_belt',poi_name:'Halcyon Belt'},
    status:{...s.status,ship_class:'stormrunner',ship_name:'Stormrunner',ship_role:'Courier',ship_faction:'solarian'},flags:{in_battle:false,hull_low:true,fuel_low:true,fresh_from:'mine' as const}};
  const mine=ev('mining_yield',{facts:{resource_id:'gold_ore'},identities:[{kind:'item',id:'gold_ore'}],score:2});
  const mira=subject(withMoment({...base,look:'a tall woman with close-cropped silver hair'},mine,[],[],{gold_ore:'Gold Ore'}),{kind:'item',id:'gold_ore',category:'extraction',name:'Gold Ore'});
  for(const kind of ['selfie','scene'] as const) {
    const got=prompt(kind,mira,STYLE,1);
    for(const word of ['Kvothe','Cobble','Outer Rim','Telescope','Frontier','Veil','Mobile Capital','Dust Devil','Eviction','green','red hair'])assert.ok(!got.includes(word),`${kind}: ${word}`);
    assert.match(got,/a courier/);
  }
  assert.match(prompt('selfie',mira,STYLE,1),/a tall woman with close-cropped silver hair, seen in profile from her left, her eyes on the canopy/);
  assert.match(prompt('selfie',mira,STYLE),/; a tumbling asteroid, large and filling the canopy, a mining beam cutting into it, loose rock spraying\.$/);
});

test('every slot a template reads has a recorded source, and the annotations print the templates, cameras, poses and settings',()=>{
  for(const kind of ['selfie','scene'] as const) {
    const paths=new Set(TEMPLATES[kind].flatMap(alts=>alts.flatMap(pathsIn)));
    for(const path of paths)assert.ok(SOURCES[path],`${kind}: ${path} has no source`);
    const doc=annotate(kind);
    for(const path of paths)assert.ok(doc.includes(`\`{${path}}\`: ${SOURCES[path]}`),`${kind}: ${path} not annotated`);
  }
  const words=annotateWords();
  for(const p of [...Object.values(POSES),...Object.values(SETTINGS)])for(const f of p)assert.ok(words.includes(`\`${f}\``),f);
  for(const k of Object.keys(SLOT_SOURCES))assert.ok(words.includes(`\`{${k}}\``),k);
});

test('the caption says no fights rather than zero, and drops what it lacks',()=>{
  const k=kvotheScene();
  assert.equal(caption(k),'Frontier Station, Mobile Capital, The Telescope · hull 80/80, fuel 120/120, hold 32/75, 316,653 cr · lately: 15 fights, 11 won, +14,993 cr over 3.1 hours');
  assert.equal(caption({...k,lately:{...k.lately,fights:{count:0,won:0,lost:0,other:0,last_opponent:null}}}).split(' · ')[2],'lately: no fights, +14,993 cr over 3.1 hours');
  assert.equal(caption(blankScene()),'lately: no fights');
  const fights=(count:number,won:number)=>caption({...blankScene(),lately:{...blankScene().lately,fights:{count,won,lost:count-won,other:0,last_opponent:null}}});
  assert.deepEqual([fights(1,0),fights(1,1),fights(3,2),fights(3,0),fights(2,2),fights(1200,7)],
    ['lately: 1 fight, lost','lately: 1 fight, won','lately: 3 fights, 2 won','lately: 3 fights, all lost','lately: 2 fights, 2 won','lately: 1,200 fights, 7 won']);
});
// Live 2026-10-19 (kvothe 06:03Z): docked at a base whose POI has the base's own id, the caption named the station twice.
test('the caption names a place once when the base and its POI are one',()=>{
  const k=kvotheScene(),fsms='first_step_memorial_station',name='First Step Memorial Station';
  const s={...k,where:{...k.where,system:'first_step',system_name:'First Step',poi:fsms,poi_name:name,docked_at:fsms,base_name:name}};
  assert.equal(caption(s).split(' · ')[0],'First Step Memorial Station, First Step');
});
test('the seed is the run id\'s: stable, 31 bits, different runs differ',()=>{
  assert.equal(seedOf('23cf458c-7e63-47c8-91a7-b7cf31bce73a'),seedOf('23cf458c-7e63-47c8-91a7-b7cf31bce73a'));
  assert.notEqual(seedOf('a'),seedOf('b'));
  for(const id of ['a','b','r1'])assert.ok(Number.isInteger(seedOf(id))&&seedOf(id)>=0&&seedOf(id)<2**31);
});

// Carl, 2026-10-19: the one authored lookup is the star's class (stars.ts). Where a sun is drawn it is the system's own.
test('a sun is drawn by its class: as the place when the POI is the sun, as the place when nothing else is known, beside a subject and a mining body as light',()=>{
  const k=kvotheScene(),at=(s:Scene,w:Partial<Scene['where']>)=>({...s,where:{...s.where,docked_at:null,...w}});
  const jump=withMoment(k,ev('spacemolt/jump'));
  assert.equal(picture(at(jump,{poi_type:'sun',poi_class:'M2III',sun:'M2III'})).setting,'a red giant sun ahead');
  assert.equal(picture(at(jump,{poi_type:'sun',poi_class:null})).setting,'a blazing sun ahead'); // no class: the generic sun
  assert.equal(picture(at(jump,{sun:'G2V'})).setting,'a yellow sun ahead'); // no POI kind: the system's sun
  assert.equal(picture(at(jump,{poi_type:'planet',sun:'G2V'})).setting,'a looming planet ahead');
  assert.equal(picture(at(withMoment(k,ev('mining_yield')),{poi_type:'asteroid_belt',sun:'M2III'})).setting,'a mining beam cutting into a tumbling asteroid ahead, loose rock spraying, under a red giant sun');
  const fight=subject(at(withMoment(k,ev('battle_ended')),{sun:'K5V'}),{kind:'ship',id:'x',role:'Cruiser'});
  assert.match(prompt('selfie',fight,'S'),/, weapons fire crossing the dark, under an orange sun\.$/); // beside a subject: light only, at most six words
  assert.doesNotMatch(prompt('selfie',subject(at(withMoment(k,ev('battle_ended')),{}),{kind:'ship',id:'x'}),'S'),/under/);
});
