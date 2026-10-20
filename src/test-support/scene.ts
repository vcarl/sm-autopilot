/** A Scene with every optional fact empty, for the picture template and reference tests. */
import {CATEGORY} from '../picture/catalogue.ts';
import type {Scored} from '../picture/moments.ts';
import type {Scene} from '../picture/oracle.ts';

export const blankScene=():Scene=>({
  juncture_id:null,run_id:'r1',started:null,ended:'2026-10-17T02:52:34.911Z',outcome:null,mood:null,
  where:{system:null,system_name:null,poi:null,poi_name:null,poi_type:null,poi_class:null,sun:null,docked_at:null,base_name:null,security:null,empire:null},
  status:{hull:null,max_hull:null,fuel:null,max_fuel:null,credits:null,cargo_used:null,cargo_capacity:null,cargo:[],
    ship_class:null,ship_class_seen_at:null,ship_class_seen_after_end:false,ship_name:null,ship_faction:null,ship_role:null},
  work:null,company:{creatures:[],nearby:[],ships:[]},
  lately:{runs:[],span:{start:'2026-10-17T02:42:36.813Z',end:'2026-10-17T02:52:34.911Z',hours:0.17},wallet:{start:null,end:null,change:null},
    fights:{count:0,won:0,lost:0,other:0,last_opponent:null},trades:{bought:{},sold:{},places:[]},deaths:0,strandings:0,systems:[]},
  flags:{in_battle:false,hull_low:null,fuel_low:null,fresh_from:null},moment:null,subject:null,look:null,eyes:null,names:{},scope:{start:'2026-10-17T02:42:36.813Z',end:'2026-10-17T02:52:34.911Z'},
});

/** Kvothe's scene for juncture c5f4c0ff, cut down from the live journal (2026-10-17 02:52Z). */
export const kvotheScene=():Scene=>{
  const s=blankScene();
  return {...s,juncture_id:'c5f4c0ff13a249238deb5ba5359a7654',run_id:'83f3d908-7d64-498b-baaf-64da7525ef43',outcome:'done',mood:'Focused',
    where:{...s.where,system:'the_telescope',system_name:'The Telescope',poi:'mobile_capital',poi_name:'Mobile Capital',docked_at:'frontier_station',base_name:'Frontier Station'},
    status:{...s.status,hull:80,max_hull:80,fuel:120,max_fuel:120,credits:316653,cargo_used:32,cargo_capacity:75,cargo:[{item_id:'copper_piping',quantity:29}],
      ship_class:'cobble',ship_class_seen_at:'2026-10-17T02:44:34.099Z',ship_class_seen_after_end:false,ship_name:'Cobble',ship_faction:'outerrim',ship_role:'Miner'},
    company:{creatures:[],nearby:[{poi:'the_telescope_entangled_drift',poi_name:'The Telescope Entangled Drift',species:'veil_ray',count:2,seen_at:'2026-10-17T00:15:03.187Z'}],ships:[]},
    lately:{...s.lately,span:{start:'2026-10-16T23:45:59.276Z',end:'2026-10-17T02:52:34.911Z',hours:3.11},wallet:{start:301660,end:316653,change:14993},
      fights:{count:15,won:11,lost:0,other:4,last_opponent:'Veil-Ray'}},
    flags:{in_battle:false,hull_low:false,fuel_low:false,fresh_from:'hunt'}};
};

/** A scored event for a moment, its category from the catalogue. */
export const scoredEvent=(type:string,o:Partial<Scored>={}):Scored=>({at:'2026-10-17T02:40:00.000Z',ms:Date.parse('2026-10-17T02:40:00.000Z'),type,variant:null,
  category:CATEGORY.get(type)??'uncatalogued',involvement:1,delta:{},identities:[],note:null,facts:{},approximate:true,score:1,rarity:0.5,change:0.5,first:0,habituation:1,...o});
/** `scene` with a moment of `lead` and `supporting`, and `earlier` events before it in the scope. */
export const withMoment=(scene:Scene,lead:Scored,supporting:Scored[]=[],earlier:Scored[]=[],names:Record<string,string>={}):Scene=>({...scene,names,
  moment:{start:lead.at,end:lead.at,score:lead.score,raw:lead.score,approximate:true,events:[lead,...supporting],lead,supporting,earlier,
    identities:[lead,...supporting].flatMap(e=>e.identities)}});

// Carl approved this text for the death at Kael Arsenal (2026-10-19, kvothe 06:03Z, juncture cd295081): oracle.test.ts draws it
// from the frames, prompts.test.ts from a Scene. "its guns firing", then "muzzle flashes at its gun mounts", drew as engine exhaust; tracer bolts read as guns.
// Names became kinds (recipe3: a name draws nothing or a mangled sign).
// Carl, 2026-10-19: the camera spike's loose pass, its shoulder camera (seed % 3 = 0), no style frame.
export const CD295081="hand-inked illustration, warm lamplight, deep indigo shadows, fine crosshatching: from the pilot's seat of a blockade runner, a worn starship cockpit of brass and leather, through a canopy, its glass cracked and webbed, onto open space and a black starfield, the pilot, small in the lower left corner; the pirate cruiser from <image1> with five gun mounts, large and filling the canopy, dives straight at us nose-first, bright tracer bolts streaking from its turrets toward us, the station's flak batteries flashing beyond.";
