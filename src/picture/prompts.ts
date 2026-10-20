/** The picture prompts: the seat selfie, the rendered scene and the caption, as templates over a
 * Scene. The templates are data so tuning is this file and the README can print them as they are.
 *
 * The selfie is the camera spike's loose prompt (experiments/camera-spike/README.md, Carl 2026-10-19): `{style}: {camera};
 * {subject}, large and filling the canopy, {action}[, {setting}][, under {sun}].`, one pass, no style frame, the camera one of
 * three by the seed. The scene is the image spike's recipe (experiments/qwen-spike/README.md): `{style}: {camera}; {subject}
 * from <image1>, {one design clause}, {pose}, {setting}.` In both the camera comes before the subject; the pose names the
 * subject's own parts relative to us and contradicts the catalog's three-quarter view, or the model keeps the reference's pose;
 * nothing in a reference's backdrop is named and no noun is negated, since every noun pulls the picture toward it.
 *
 * A sentence is a list of alternatives; the first that resolves is used, and when none does the
 * sentence is dropped. `{a.b|c.d:fmt}` is the first non-empty of those Scene paths through each
 * formatter; an empty value fails its alternative. `{?path}` holds when the value is truthy,
 * `{?path=word}` when it equals the word, `{?a==b}` when two paths are equal; `{!…}` negates. A
 * `[clause]` drops itself, not the sentence, when anything inside it fails. Every word outside a
 * slot is static and generic: no proper noun, nothing of any one pilot or run, and the one pronoun the pilot's own look's
 * (`pronounOf`). A slot never spells out a raw id (`RAW`): it takes its generic noun, or fails. */
import {isRecord} from '../run-record.ts';
import {WRECK_SALVAGE,type Category} from './catalogue.ts';
import {KINDS,LUMINOSITY,NO_CLASS,PREFIXES,SPECTRAL} from './stars.ts';
import {seedOf} from './imager.ts';
import {INVOLVEMENT,depicted,type Scored} from './moments.ts';
import type {Scene} from './oracle.ts';
import type {SubjectKind} from './refs.ts';
import {creatureClause} from './species.ts';

export type Kind='selfie'|'scene';
type Sentence=readonly string[];
type Ctx=Record<string,unknown>;

/** The selfie's cameras, one a seed (`CAMERA_ORDER[seed % 3]`), as the camera spike worded them (experiments/camera-spike/README.md).
 * Naming the viewpoint and where things sit in the frame re-posed the shot; a camera that named the seat came back as the
 * shoulder shot, and the shoulder shot alone gave every flight the same picture. The eyes go only in the side view, which
 * shows the face. Carl, 2026-10-19: the worm's-eye camera is dropped. */
export const CAMERAS={
  shoulder:"from the pilot's seat of {picture.own}, {picture.cockpit}, through {picture.canopy} onto {picture.view}, the pilot[, {look}], small in the lower left corner",
  side:'a side view across the cockpit of {picture.own}, {picture.cockpit}: the pilot[, {look}], seen in profile from {picture.their} left, {picture.gaze} on the canopy at the right of the frame, through {picture.canopy} onto {picture.view}',
  wide:'a wide shot of the whole cockpit of {picture.own} from behind, {picture.cockpit}, the pilot[, {look}], small in {picture.their} seat at the centre, through {picture.canopy} onto {picture.view}',
} as const;
export const CAMERA_ORDER=['shoulder','side','wide'] as const;
export const COCKPIT='a worn starship cockpit of brass and leather';
/** Where a scene's camera stands: just behind the ship, outside it, onto open space. Live 2026-10-19 (kvothe 0d8e53df): docked,
 * "onto open space and a black starfield" and "the berths of First Step Memorial Station close outside" in one prompt, and
 * open space wins. */
export const CAMERA='{style}: from just behind {picture.own}, out onto open space and a black starfield, its stern small in the lower left corner';
/** Docked, the view keeps one anchor in space. Live 2026-10-19 (recipe2 renders): with the open-space words gone, every
 * docked view went planet-side (a hangar onto a desert, cargo lifters as airships over terrain). */
// Live 2026-10-19 (recipe3, 0d8e53df): "black space and stars beyond" still drew a ground-side hangar and airfield; a station hanging
// in black space, its docking ring close outside, drew a station in space.
const ANCHOR='the station hanging in black space among the stars';
export const DOCKED=`{?picture.docked}{style}: from just behind {picture.own}, out onto {picture.view}, ${ANCHOR}, its stern small in the lower left corner`;
/** The subject, by its kind: named from the one reference sent, one design clause from the catalog, then its pose. An item is
 * no picture's subject: never a thing flying in space (live 2026-10-18, kvothe a28932b8: Copper Wiring flew like a missile
 * through rocks), and on the console it hardly showed (`CANOPY_SUBJECTS`). */
// Live 2026-10-19 (recipe3, 3db6ff6c): a proper name draws nothing or a mangled sign ("MARKET PRIAME"); the subject is named by
// its kind, the caption carries the names.
const NAMED:Record<Exclude<SubjectKind,'item'>,string>={
  ship:'{?subject.kind=ship}the [{subject.faction:pirate} ]{subject.role|subject.kind:vessel} from <image1>[ with {subject.weapon_slots:mounts}]',
  creature:'{?subject.kind=creature}the creature from <image1>[, {subject.name:creature}]',
};
/** A fought subject's size, by the kind of picture: a scene's sits in the upper right, a selfie's fills the canopy. */
const SIZE:Record<Kind,string>={selfie:'large and filling the canopy',scene:'large and close in the upper right'};
const posed=(kind:Kind,named:string)=>`${named}, [{?subject.fought}${SIZE[kind]}, ]{picture.pose}`;
export const SUBJECT={ship:posed('scene',NAMED.ship),creature:posed('scene',NAMED.creature)};
/** What fills a selfie's canopy when no ship or creature is the subject: docked, the docking ring and what the station does;
 * mining, the body mined; else the place ahead. An item is no subject of a selfie: a prop on the console hardly showed (camera
 * spike: neither did the mission's objective marker), and the loose pass draws what is outside. */
export const CANOPY_SUBJECTS={
  docked:['the docking ring close outside, filling the canopy, {dock_action}','the docking ring close outside, filling the canopy'],
  // Live 2026-10-18 (kvothe 3db6ff6c): 19 yields of argon and hydrogen at a gas cloud; "loose rock" is a belt's.
  extraction:['{?where.poi_type=gas_cloud}a glowing gas cloud, large and filling the canopy, the harvester drawing it in',
    '{?where.poi_type=ice_field}a tumbling chunk of ice, large and filling the canopy, a mining beam cutting into it, loose ice spraying',
    'a tumbling asteroid, large and filling the canopy, a mining beam cutting into it, loose rock spraying'],
  space:['{place} ahead, large and filling the canopy'],
} satisfies Record<string,Sentence>;
/** A station's work, seen at its docking ring. */
export const DOCK_ACTIONS:Partial<Record<Depicted,Sentence>>={economy:['its cargo lifters at work'],crafting:["the station's {venue:lower} working"]};
/** One sentence. A selfie: the camera, the subject, what lies beyond it and the sun's light. A scene, docked: the camera onto the
 * setting, then the subject; in space: the camera, the subject and the setting; with no subject the setting alone. */
const LOOSE='{style}: {picture.camera}; ';
export const TEMPLATES:Record<Kind,readonly Sentence[]>={
  selfie:[[...[NAMED.ship,NAMED.creature].map(n=>`${LOOSE}${posed('selfie',n)}[, {picture.beyond}][, under {picture.light}].`),
    `${LOOSE}{picture.canopy_subject}[, {picture.beyond}][, under {picture.light}].`]],
  scene:[[...[SUBJECT.ship,SUBJECT.creature].map(s=>`${DOCKED}; ${s}.`),`${DOCKED}.`,
    ...[SUBJECT.ship,SUBJECT.creature].map(s=>`${CAMERA}; ${s}[, {picture.setting}][, under {picture.sun}].`),`${CAMERA}; {picture.setting}.`,`${CAMERA}.`]],
};

type Depicted=Exclude<Category,'system'>|'wreck';
/** What the subject does, in its own parts relative to us, by its kind; `{?fought}` when its event is the pilot's own fight. A
 * ship is a subject only from a fight (refs.ts `subjectOf`); one the pilot only heard of is far off, trading fire with its
 * `other_side`. Live 2026-10-19 (kvothe cd295081): "its guns firing" and then "muzzle flashes at its gun mounts" were drawn as
 * engine exhaust; of three wordings tried on one seed, tracer bolts from the turrets read as guns. An item has no pose. */
export const POSES:Record<Exclude<SubjectKind,'item'>,Sentence>={
  ship:['{?fought}dives straight at us nose-first, bright tracer bolts streaking from its turrets toward us','trading fire with {other_side:a} in the distance, broadside to us',
    'trading fire in the distance, broadside to us'],
  creature:['{?fought}lunges straight at us head-first, its limbs flung wide','glides across the stars above us, its belly toward us'],
};
/** The setting's tail, by the lead event's category (`rest` with no moment: the ship where it ended). Slots are the lead's own
 * fields (`SLOT_SOURCES`), but the gunner and its weapon are the moment's. System & connection is never depicted. A station's
 * settings (economy, holdings, crafting) are docked views, so they name the docking ring; a proper name alone draws nothing
 * (live 2026-10-19, recipe2: "Void Gate swinging into view" and "the lights of Bharani Star" drew an empty window), so a place
 * in space is what its POI's kind can show (`PLACES`). */
export const SETTINGS:Record<Depicted|'rest',Sentence>={
  combat:["{gunner}'s {weapon} flashing beyond","{gunner}'s guns flashing beyond",'{weapon} flashing beyond','weapons fire crossing the dark'],
  hazard:["{gunner}'s {weapon} flashing beyond","{gunner}'s guns flashing beyond",'{weapon} flashing beyond','debris tumbling past'],
  economy:["the cargo lifters of the station's docking ring at work"],
  // Live 2026-10-18 (kvothe 3db6ff6c): 19 yields of argon and hydrogen at a gas cloud; "loose rock" is a belt's.
  // Live 2026-10-19 (recipe6, e04015fe and a28932b8): "the mining beam lit, loose rock tumbling beyond" left the canopy empty; the
  // body mined is the thing outside.
  extraction:['{?where.poi_type=gas_cloud}the harvester drawing in a glowing gas cloud','{?where.poi_type=ice_field}a mining beam cutting into a tumbling chunk of ice ahead, loose ice spraying',
    'a mining beam cutting into a tumbling asteroid ahead, loose rock spraying[, under {sun}]'],
  crafting:["the station's {venue:lower} working","the station's docking ring"],
  travel:['{place} ahead'],
  // Live 2026-10-19 (kvothe 7b7030a8): exploration objectives met on arrival at suns drew "a blazing sun" and nothing of the work.
  missions:['an objective marker glowing on the console, {place} beyond'],
  discovery:['{scanners} sweeping us with scanners','a never-seen {found} glowing ahead'],
  progression:['a new commendation glowing on the dash'],
  holdings:["the station's docking ring"],
  faction:['ships holding formation beyond'],
  social:['a message lit on the console'],
  // Extraction from a wreck (catalogue.ts WRECK_SALVAGE), not a deposit.
  wreck:["{?wreck_foe=creature}a creature's carcass drifting beyond",'the wreck drifting beyond'],
  rest:['{place} beyond'],
};
/** The view when docked for a setting that is not a station's (the rest, a mission, a level, a message): the station's own
 * structure is what there is to see. Live 2026-10-19 (recipe2, 0d8e53df): "the berths" was drawn as bunk beds. */
// Live 2026-10-17 (kvothe ae04e821): a level or a message is inside the cockpit, no view ("a new commendation glowing on the dash").
export const DOCK_VIEW:Sentence=["the station's lit docking ring close outside"];
/** A sun by its Morgan–Keenan class (stars.ts): its letter's colour and its luminosity class, the first of a range; a letter
 * that names its own kind (a brown dwarf, a carbon star) by that; anything unreadable `NO_CLASS`. "M2III" is "a red giant sun". */
export function sunOf(cls:string|null|undefined):string {
  const m=/^(esd|usd|sd)?(D[A-Z]*|W[NCOR]*|[OBAFGKMLTYCRNS])(\d(?:\.\d+)?)?(.*)$/.exec((cls??'').trim()),letter=m?.[2]?.[0]??'',colour=SPECTRAL[letter];
  if(!m||!colour)return NO_CLASS;
  const lum=Object.keys(LUMINOSITY).find(k=>(m[4]??'').startsWith(k)),kind=m[1]?PREFIXES[m[1]]:lum===undefined?undefined:LUMINOSITY[lum];
  if(kind==='white dwarf'||letter==='D')return 'a white dwarf sun';
  if(kind===undefined&&KINDS[letter])return a(`${colour} ${KINDS[letter]}`);
  return a(`${colour} ${kind?`${kind} `:''}sun`);
}
/** What a POI's kind shows from the canopy; a sun is `sunOf` its class. Every system has a sun, so the system's stands in when
 * the kind is not known. */
export const PLACES:Record<string,string>={sun:NO_CLASS,planet:'a looming planet',asteroid_belt:'a field of tumbling asteroids',
  gas_cloud:'a glowing gas cloud',ice_field:'a field of drifting ice',nebula:'a glowing nebula',station:"a station's lit structure",relic:'an ancient drifting relic'};
/** The canopy cracked when the lead is a fight or a hazard, or the hull is low. */
// Live 2026-10-19 (recipe5, cd295081): "a big rounded cracked canopy" drew no cracks; the glass's own clause brought them back.
export const CANOPY={cracked:'a canopy, its glass cracked and webbed,',whole:'the canopy'};
/** Below this share of its max hull the ship is drawn damaged (`cracked`). */
export const CRACKED_HULL=0.75;
export const SLOT_SOURCES:Record<string,string>={
  gunner:'the moment\'s best `battle_damage` on the pilot whose `attacker_id` is no participant of its battle: "the station" when its `attacker_name` names one',
  weapon:'that shot\'s last `weapons_fired`, its last two words, lower-cased and pluralised ("Scrap Flak Battery": "flak batteries")',
  scanners:'a `scan_detected`: how many distinct `scanner_ship_class` the moment\'s scans and its own name, as "a ship" or "two ships"',
  venue:'a craft\'s `venue`, lower-cased ("Copper Wire Mill": "copper wire mill")',
  place:'a sun POI by `sunOf` its class; else `PLACES` for `where.poi_type` (the depicted lead\'s POI kind, from its frames); else the system\'s sun; else "a distant sun"',
  sun:'`sunOf` the system\'s sun class (`where.sun`, the `sun` POI of the system\'s `get_system` chart, moments.ts `poisOf`)',
  found:'"creature" when the event names a species; else "signal"',

  wreck_foe:'what the last fight within 15 minutes before the salvage was against (moments.ts `wrecks`): `creature` or `ship`',
};
/** The caption: groups joined by ` · `, each group's parts that resolve joined by `, `. */
export const CAPTION:readonly (readonly Sentence[])[]=[
  [['{?where.docked_at}{where.base_name|where.docked_at:name}'],['{where.poi_name|where.poi:name}'],['{where.system_name|where.system:name}']],
  [['hull {status.hull}/{status.max_hull}'],['fuel {status.fuel}/{status.max_fuel}'],['hold {status.cargo_used}/{status.cargo_capacity}'],['{status.credits:n} cr']],
  [['{?lately.fights.count}lately: {lately.fights:fights}','lately: no fights'],
    ['{lately.wallet.change:signed} cr over {lately.span.hours:hours}']],
];

/** Where each slot's fact comes from in the runtime dir, for the README's annotated template. */
export const SOURCES:Record<string,string>={
  'style':'SPACEMOLT_IMAGE_STYLE, else the short style in imager.ts',
  'picture.own':'`status.ship_role` as a vessel, with "a" ("Freighter": "a freighter", "Miner": "a miner ship"); else "the pilot\'s ship"',
  'status.ship_name':'catalog.json `ships[].name` for the ship class',
  'status.ship_class':'the depicted lead\'s ship as the frames give it (its battle row, a death\'s `ship_lost`, the last reply\'s `ship.class_id`), else `run` ended `end_state.ship_class`, else the last ship the frames named in the scope, else the newest journal line with `ship_class`, else combat.json\'s newest fight at or before the end',
  'picture.canopy':`"${CANOPY.cracked}" when the lead event is the pilot's own fight or death, or the end hull is below ${CRACKED_HULL*100}% of its max or \`flags.hull_low\`, else "${CANOPY.whole}"`,
  'subject.kind':'refs.ts `subjectOf`: the moment\'s best-scoring event with a subject, and in it a ship fought (a `ship_class` identity of a combat or hazard event), else a creature (`species`), else an item (`item`)',
  'subject.name':'an item\'s catalog.json `name`, lower-cased, a trailing mark number cut; a creature\'s as the game named it in the moment (species.ts `speciesName`), for its name\'s clause',
  'subject.faction':'catalog.json `ships[].faction`: "pirate" when it is, else nothing','subject.role':'catalog.json `ships[].class` as a vessel ("Cruiser": "cruiser", "Assault": "assault ship")',
  'subject.weapon_slots':'catalog.json `ships[].weapon_slots`, in words: "five gun mounts"; none drops the clause',
  'picture.pose':'`POSES` for the subject\'s kind',
  'subject.fought':'refs.ts `subjectOf`: the subject\'s event is the pilot\'s own fight',
  'picture.camera':'`CAMERAS[CAMERA_ORDER[seed % 3]]` (the seed is the run id\'s, imager.ts `seedOf`), filled: the ship, the cockpit, the canopy, the view, the look (oracle.ts `pilotLook`: SOUL.md\'s build, hair and clothing), and in the side view `picture.gaze`',
  'picture.canopy_subject':'`CANOPY_SUBJECTS`: docked, the docking ring and `DOCK_ACTIONS` for the lead\'s category; mining, the body by `where.poi_type`; else `{place}` ahead',
  'picture.beyond':'docked, the station hanging in black space; a fight\'s, a find\'s or any other lead\'s `SETTINGS`, but none for mining, travel, a mission or the rest, whose place is the subject',
  'picture.light':'`picture.sun`, unless the sun is itself the subject',
  'picture.setting':'`SETTINGS` for the lead event\'s category (`rest` with no moment), from its fields',
  'picture.sun':'`sunOf` the system\'s sun class (`where.sun`), as light beside a subject',
  'picture.view':'a station\'s setting (economy, holdings, crafting) as it stands, else `DOCK_VIEW`',
  'picture.docked':'the lead\'s setting is a station\'s (economy, holdings, crafting), or `where.docked_at` and it is the rest, a mission\'s, a level\'s or a message\'s',
  'where.docked_at':'the depicted lead\'s place as the frames give it (the last reply\'s `location`), else `run` ended `end_state.docked_at`',
  'where.poi':'the depicted lead\'s place as the frames give it, else `run` ended `end_state.poi`','where.system':'the depicted lead\'s place as the frames give it, else `run` ended `end_state.system`',
  'where.base_name':'names.json, else the journal\'s own text (line `text`, command `summary`, call `did`) up to the end',
  'where.poi_name':'names.json, else the journal\'s own text up to the end','where.system_name':'galaxy.json `systems[].name`',
  'status.hull':'`run` ended `end_state.hull`','status.max_hull':'`run` ended `end_state.max_hull`',
  'status.fuel':'`run` ended `end_state.fuel`','status.max_fuel':'`run` ended `end_state.max_fuel`',
  'status.cargo_used':'`run` ended `end_state.cargo_used`','status.cargo_capacity':'`run` ended `end_state.cargo_capacity`',
  'status.credits':'`run` ended `end_state.credits`',
  'lately.span.hours':'the window\'s first `run` started to this run\'s `ended` (at most ten runs or six hours)',
  'lately.fights.count':'the pilot\'s battles in the window from the frames when they cover it (moments.ts `fightsOf`: one per battle it started or joined), else journal `push` battle_ended lines in the window',
  'lately.fights':'"1 fight, won|lost" or "N fights, W won|all lost": the count as above, won by its ending (`battle_ended` `reason`, `defeat` when the pilot died in it; combat.json `ending` on the journal path)',
  'lately.wallet.change':'`end_state.credits` less the window\'s first `start_state.credits`',
};

const human=(id:string)=>id.replace(/_/g,' ');
const ostr=(v:unknown)=>typeof v==='string'&&v?v:null;
const NUMBERS=['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve'];
const a=(v:string)=>`${/^[aeiou]/i.test(v)?'an':'a'} ${v}`;
/** A ship class as something drawable: the class when it is a vessel's noun, else the class and "ship". */
const VESSEL=/(ship|creature|cruiser|dreadnought|freighter|fighter|carrier|tanker|liner|shuttle|yacht|scout|courier|interceptor|frigate|hauler|runner|cutter|coaster|tender|tourer|transport|whaler|monitor|raider|smuggler|interdictor)$/;
const vessel=(cls:string)=>{const c=cls.toLowerCase();return VESSEL.test(c)?c:`${c} ship`;};
const plural=(w:string)=>/[^aeiou]y$/.test(w)?`${w.slice(0,-1)}ies`:/(s|x|z|ch|sh)$/.test(w)?`${w}es`:`${w}s`;
/** A raw id (a player's, a creature instance's, a wreck's): a hex run no name has. Live 2026-10-19 (kvothe 11:19Z): "Crt Dc1f7b404… fills the view". */
const RAW=/[0-9a-f]{16,}/i;
const FORMAT:Record<string,(v:unknown)=>string|null>={
  name:v=>human(String(v)),lower:v=>String(v).toLowerCase(),a:v=>a(String(v)),vessel:v=>vessel(String(v)),
  pirate:v=>v==='pirate'?'pirate':null,
  n:v=>Number(v).toLocaleString('en-US'),
  signed:v=>`${Number(v)>=0?'+':'-'}${Math.abs(Number(v)).toLocaleString('en-US')}`,
  hours:v=>{const h=Number(v);return h<1?`${Math.max(1,Math.round(h*60))} minutes`:h<1.05?'1 hour':`${h.toFixed(1).replace(/\.0$/,'')} hours`;},
  mounts:v=>{const n=Number(v);return n>0?`${NUMBERS[n]??n} gun mount${n===1?'':'s'}`:null;},
  creature:v=>creatureClause(String(v)),
  fights:v=>{const r=isRecord(v)?v:{},n=Number(r.count),w=Number(r.won);return `${n.toLocaleString('en-US')} ${n===1?'fight':'fights'}, ${n===1?w?'won':'lost':w?`${w.toLocaleString('en-US')} won`:'all lost'}`;},
};

const get=(ctx:Ctx,path:string):unknown=>path.split('.').reduce<unknown>((v,k)=>isRecord(v)?v[k]:undefined,ctx);
const empty=(v:unknown)=>v===null||v===undefined||v===''||(Array.isArray(v)&&!v.length)||(typeof v==='number'&&!Number.isFinite(v))||(isRecord(v)&&!Object.keys(v).length);
const truthy=(v:unknown)=>!empty(v)&&v!==false&&v!==0;

function guard(expr:string,ctx:Ctx):boolean {
  const [path='',other]=expr.split('==');
  if(other!==undefined)return !empty(get(ctx,path))&&get(ctx,path)===get(ctx,other);
  const [p='',wordIs]=expr.split('=');
  return wordIs===undefined?truthy(get(ctx,p)):get(ctx,p)===wordIs;
}
function slot(body:string,ctx:Ctx):string|null {
  if(body.startsWith('?')||body.startsWith('!'))return guard(body.slice(1),ctx)===body.startsWith('?')?'':null;
  const [paths='',...fmts]=body.split(':');
  const value=paths.split('|').map(p=>get(ctx,p)).find(v=>!empty(v));
  if(value===undefined)return null;
  let out:unknown=value;
  for(const f of fmts){const fn=FORMAT[f];if(!fn)throw new Error(`no formatter ${f}`);out=fn(out);if(!out)return null;}
  return RAW.test(String(out))?null:String(out);
}
/** `text` filled from `ctx`, or null when a slot or guard outside any clause fails. */
function fill(text:string,ctx:Ctx):string|null {
  let out='';
  for(let i=0;i<text.length;) {
    const c=text[i];
    if(c==='['||c==='{') {
      const close=c==='['?']':'}';let depth=0,j=i;
      for(;j<text.length;j++){if(text[j]===c)depth++;else if(text[j]===close&&--depth===0)break;}
      const inner=text.slice(i+1,j);
      if(c==='[')out+=fill(inner,ctx)??'';
      else {const got=slot(inner,ctx);if(got===null)return null;out+=got;}
      i=j+1;
    } else {out+=c;i++;}
  }
  return out;
}
const sentence=(alts:Sentence,ctx:Ctx)=>{for(const alt of alts){const got=fill(alt,ctx);if(got!==null)return got.replace(/\s+/g,' ').trim();}return null;};

/** A setting's slots from the lead's own fields, worded by kind, never by name. The gunner is the moment's. */
function slotsOf(e:Scored,scope:readonly Scored[]):Ctx {
  const id=(k:string)=>e.identities.find(i=>i.kind===k)?.id??null,f=(k:string)=>e.facts[k];
  const shot=[...scope].sort((x,y)=>y.score-x.score).find(x=>ostr(x.facts.gunner)),last=ostr(shot?.facts.weapons)?.split('|').at(-1);
  // Live 2026-10-19 (kvothe 06:01Z): the scans before the pirate's ambush were two Lemmings' and a Lawn Dart's, three frames for one sweep.
  const scanners=e.type==='scan_detected'?new Set([e,...scope.filter(x=>x.type==='scan_detected')].flatMap(x=>ostr(x.facts.scanner_ship_class)??[])).size:0,gunner=ostr(shot?.facts.gunner);
  return {gunner:gunner&&/\bstation\b/i.test(gunner)?'the station':null,weapon:last?plural(last.split(/\s+/).slice(-2).join(' ').toLowerCase()):null,
    scanners:scanners>1?`${NUMBERS[scanners]??scanners} ships`:scanners?'a ship':null,venue:ostr(f('venue')),found:id('species')?'creature':'signal',wreck_foe:ostr(f('wreck_foe'))};
}
/** The canopy is cracked only by the pilot's own fight or death, or a hull below `CRACKED_HULL` of its max (or the mood's walk-away
 * line, `flags.hull_low`) at the run's end, the one hull the Scene keeps. Live 2026-10-20 (kvothe ee6a2789, 06:17Z): moment 2 was a
 * battle_alert, the Dialectic trading fire with a creature at Propus, not the pilot's fight, and it was drawn through cracked glass
 * with the hull at 110/110. */
function cracked(s:Scene,lead:Scored|undefined):boolean {
  const own=!!lead&&lead.involvement===INVOLVEMENT.self&&(lead.category==='combat'||lead.type==='player_died');
  const {hull,max_hull}=s.status;
  return own||!!s.flags.hull_low||hull!==null&&max_hull!==null&&max_hull>0&&hull<CRACKED_HULL*max_hull;
}
/** Settings that are a station's: the pilot is docked at their moment whatever the place says; and those that are docked when
 * the place says so. A fight, a jump or a find is in space. */
const STATION=new Set<string>(['economy','holdings','crafting']),BERTHED=new Set<string>(['rest','missions','progression','social']);
const isDepicted=(c:string):c is Depicted=>c in SETTINGS&&c!=='rest';
const settingOf=(e:Scored|undefined):Depicted|'rest'=>!e?'rest':WRECK_SALVAGE.has(e.type)?'wreck':isDepicted(e.category)?e.category:'rest';

/** The look's pronoun, from its own words; "their" when it says none. */
export const pronounOf=(look:string|null)=>/\b(?:man|boy|he|his)\b/i.test(look??'')?'his':/\b(?:woman|girl|she|her)\b/i.test(look??'')?'her':'their';
/** Leads whose place is the selfie's subject, so nothing lies beyond it. */
const OWN_PLACE=new Set<string>(['extraction','travel','missions','rest']);
const SPACE_VIEW='open space and a black starfield';

/** The picture's words that are not a Scene fact as it stands: the pilot's ship, the canopy, the subject's pose, the setting,
 * the view through the canopy, and the selfie's camera (by `seed`, the run id's by default) and what fills its canopy. */
export function picture(s:Scene,seed=seedOf(s.run_id)):{own:string;canopy:string;pose:string|null;setting:string|null;view:string|null;docked:boolean;sun:string|null;
  camera:string;cockpit:string;their:string;gaze:string;canopy_subject:string|null;beyond:string|null;light:string|null} {
  const scope=s.moment?.events??[],lead=s.moment?depicted(s.moment)?.lead:undefined,at=settingOf(lead),sun=s.where.sun?sunOf(s.where.sun):null;
  const place=s.where.poi_type==='sun'?sunOf(s.where.poi_class):PLACES[s.where.poi_type??'']??sun??'a distant sun';
  const ctx={...s,place,sun,...lead?slotsOf(lead,scope):{}};
  const docked=STATION.has(at)||!!s.where.docked_at&&BERTHED.has(at),their=pronounOf(s.look);
  const dock_action=sentence((at==='rest'?undefined:DOCK_ACTIONS[at])??[],ctx);
  const canopy_subject=sentence(docked?CANOPY_SUBJECTS.docked:at==='extraction'?CANOPY_SUBJECTS.extraction:CANOPY_SUBJECTS.space,{...ctx,dock_action});
  const named=!!s.subject&&s.subject.kind!=='item',onPlace=!named&&!docked&&at!=='extraction';
  const base={own:s.status.ship_role?a(vessel(s.status.ship_role)):"the pilot's ship",canopy:cracked(s,lead)?CANOPY.cracked:CANOPY.whole,
    pose:s.subject&&s.subject.kind!=='item'?sentence(POSES[s.subject.kind],{...s.subject}):null,
    setting:sentence(SETTINGS[at],ctx),view:sentence(STATION.has(at)?SETTINGS[at]:DOCK_VIEW,ctx),docked,sun,
    cockpit:COCKPIT,their,gaze:`${their} ${s.eyes??'eyes'}`,canopy_subject,
    beyond:docked&&!named?ANCHOR:OWN_PLACE.has(at)&&!named?null:sentence(SETTINGS[at],ctx),light:onPlace&&place===sun?null:sun};
  const camera=fill(CAMERAS[CAMERA_ORDER[seed%CAMERA_ORDER.length]??'shoulder'],{...s,picture:{...base,view:docked?"the station's lit docking ring":SPACE_VIEW}})??'';
  return {...base,camera:camera.replace(/\s+/g,' ').trim()};
}

/** The filled template, one sentence, the style leading it; `subject` when it names the subject's art as `<image1>`. A selfie's
 * camera is the seed's (`picture`). */
export function promptOf(kind:Kind,scene:Scene,style:string,seed=seedOf(scene.run_id)):{text:string;subject:boolean} {
  const text=TEMPLATES[kind].flatMap(s=>sentence(s,{...scene,style,picture:picture(scene,seed)})??[]).join(' ');
  return {text,subject:text.includes('<image1>')};
}
export const prompt=(kind:Kind,scene:Scene,style:string,seed?:number)=>promptOf(kind,scene,style,seed).text;
// A part that repeats the one before it is dropped. Live 2026-10-19 (kvothe 06:03Z): docked at a base whose POI shares its
// id, the caption read "First Step Memorial Station, First Step Memorial Station, First Step".
export const caption=(scene:Scene)=>CAPTION.map(group=>group.flatMap(s=>sentence(s,{...scene})??[]).filter((p,i,ps)=>p!==ps[i-1]).join(', ')).filter(Boolean).join(' · ');

const slotsIn=(text:string)=>[...text.matchAll(/\{([?!]?)([^}]+)\}/g)].map(m=>({guard:m[1]??'',body:m[2]??''}));
/** Every Scene path a template reads. */
export const pathsIn=(text:string)=>slotsIn(text).flatMap(s=>s.guard?(s.body.includes('==')?s.body.split('=='):[s.body.split('=')[0]??'']):(s.body.split(':')[0]??'').split('|'));

/** The template for `kind` as markdown: each sentence's alternatives in order, slots as written,
 * each path's source, and when the sentence drops. Read from `TEMPLATES` itself, so it cannot drift. */
export function annotate(kind:Kind):string {
  const out:string[]=[];
  TEMPLATES[kind].forEach((alts,i)=>{
    const statik=alts.length===1&&!slotsIn(alts[0]??'').length;
    const last=alts.at(-1)??'';
    const always=!slotsIn(last.replace(/\[[^\]]*\]/g,'')).length;
    out.push(`${i+1}. ${statik?'**STATIC**':always?'**always** (the last form has no required slot)':'**drops** when no form below resolves (a required slot is empty or a guard fails)'}`);
    for(const alt of alts) {
      out.push(`   - \`${alt}\``);
      for(const path of [...new Set(pathsIn(alt))])out.push(`     - \`{${path}}\`: ${SOURCES[path]??'(no source recorded)'}`);
    }
  });
  return out.join('\n');
}

/** The poses and settings as markdown, then where each setting slot comes from. */
export function annotateWords():string {
  const list=(alts:Sentence)=>alts.map(f=>`\`${f}\``).join(' / ');
  return ['- selfie cameras, by `seed % 3`:',...CAMERA_ORDER.map(k=>`  - **${k}**: \`${CAMERAS[k]}\``),
    '- what fills a selfie\'s canopy with no ship or creature:',...Object.entries(CANOPY_SUBJECTS).map(([k,p])=>`  - **${k}**: ${list(p)}`),
    '- a station\'s work at its docking ring:',...Object.entries(DOCK_ACTIONS).map(([k,p])=>`  - **${k}**: ${list(p??[])}`),
    '- poses, by the subject\'s kind:',...Object.entries(POSES).map(([k,p])=>`  - **${k}**: ${list(p)}`),
    '- settings, by the lead\'s category:',...Object.entries(SETTINGS).map(([c,p])=>`  - **${c}**: ${list(p)}`),
    `- docked, not a station's setting: ${list(DOCK_VIEW)}`,'- places, by the POI\'s kind:',...Object.entries(PLACES).map(([k,p])=>`  - **${k}**: \`${p}\``),
    `- the canopy: \`${CANOPY.cracked}\` / \`${CANOPY.whole}\``,'- setting slots:',...Object.entries(SLOT_SOURCES).map(([k,v])=>`  - \`{${k}}\`: ${v}`)].join('\n');
}
