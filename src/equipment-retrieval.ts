import {SpacemoltClient,fetchStations,type Account} from '@spacemolt/lib';
import type {Home} from './execution-policy.ts';
import {canonicalReadinessBlockers} from './readiness.ts';
import {details} from './response-details.ts';
import {type IndustryCommand} from './industry.ts';

type Wire=Record<string,any>;
export interface EquipmentStation extends Home {services?:string[];station_name?:string}
export interface EquipmentRetrievalControls {
  checkpoint?:()=>Promise<void>;
  travel:(destination:EquipmentStation)=>Promise<unknown>;
  service:()=>Promise<unknown>;
  save?:(receipt:Wire)=>void;
}

const amount=(rows:Wire[]|undefined,id:string)=>{
  if(!Array.isArray(rows))throw new Error('Canonical cargo or storage inventory unavailable');
  return rows.filter(row=>row?.item_id===id).reduce((sum,row)=>sum+Number(row.quantity??0),0);
};
const quantities=(rows:Wire[]|undefined)=>{
  if(!Array.isArray(rows))throw new Error('Canonical cargo inventory unavailable');
  const result:Record<string,number>={};
  for(const row of rows)result[row.item_id]=(result[row.item_id]??0)+Number(row.quantity??0);
  return result;
};
const sameQuantities=(a:Record<string,number>,b:Record<string,number>)=>{
  const keys=new Set([...Object.keys(a),...Object.keys(b)]);
  return [...keys].every(key=>(a[key]??0)===(b[key]??0));
};
const containsModules=(actual:Wire[]|undefined,expected:Wire[])=>Array.isArray(actual)&&expected.every(row=>
  actual.some(current=>current.module_id===row.module_id&&current.type_id===row.type_id));

/** Remote storage summaries prove candidate locations, never their item contents. */
export async function assessOwnedMiningEquipment(account:Account,command:IndustryCommand,stations?:EquipmentStation[]) {
  await account.refresh();
  const mining=account.state.modules?.find(row=>Number(row.stats?.mining_power)>0);
  if(mining)return {status:'ready',mining_module:{module_id:mining.module_id,type_id:mining.type_id}};
  if(amount(account.cargo as Wire[],'mining_laser_i')>0)return {status:'ready_to_fit',source:'cargo',item_id:'mining_laser_i'};
  if(!account.location?.docked_at)return {status:'blocked',reason:'Dock before checking personal storage locations'};
  const storage=details(await command('spacemolt_storage/view',{}));
  if(amount(storage.items,'mining_laser_i')>0)return {status:'ready_to_fit',source:'local_storage',item_id:'mining_laser_i',base_id:account.location.docked_at};
  if(!Array.isArray(storage.locations))return {status:'blocked',reason:'Personal storage location summary unavailable; remote ownership is unverified'};
  const directory=stations??(await fetchStations(new SpacemoltClient().httpBaseUrl)).stations.map(row=>({...row,station_name:row.name,rationale:'Typed public station identity for owned-equipment retrieval',observed_at:new Date().toISOString()}));
  const candidates=storage.locations.map((location:Wire)=>{
    const matches=directory.filter(station=>station.base_id===location.base_id&&station.system_id===location.system);
    return matches.length===1?{base_id:matches[0]!.base_id,system_id:matches[0]!.system_id,poi_id:matches[0]!.poi_id,
      station_name:matches[0]!.station_name,item_count:location.item_count,
      services:matches[0]!.services,destination:matches[0],status:'contents_unverified'}:{base_id:location.base_id,system_id:location.system,status:'identity_unresolved'};
  }).filter((row:Wire)=>row.base_id!==account.location?.docked_at);
  return candidates.length?{status:'retrieval_candidates',item_id:'mining_laser_i',candidates,
    limitation:'Remote storage summaries do not identify individual items. Prepare verifies Mining Laser I only after docking; absence there blocks without purchasing.'}:
    {status:'blocked',reason:'No observed remote personal-storage location can be resolved'};
}

/** Retrieve and fit one owned laser, preserving displaced cabin and exact starting custody. */
export async function retrieveOwnedMiningEquipment(account:Account,command:IndustryCommand,destination:EquipmentStation,home:EquipmentStation,controls:EquipmentRetrievalControls) {
  if(!destination?.base_id||!destination.system_id||!destination.poi_id)throw new Error('Choose one observed equipment storage station');
  if(!home?.base_id||!home.system_id||!home.poi_id)throw new Error('Remembered home is unresolved; choose home before equipment retrieval');
  if(destination.services&&!destination.services.includes('storage'))throw new Error('Equipment destination has no observed personal storage service');
  const receipt:Wire={status:'running',item_id:'mining_laser_i',destination,home};
  const save=()=>controls.save?.(structuredClone(receipt));
  await account.refresh();
  const blockers=canonicalReadinessBlockers(account.state);
  if(blockers.length)throw new Error(blockers.join('; '));
  if(!account.location?.system_id||account.location.in_transit)throw new Error('Equipment retrieval requires a stable observed location');
  const startingCargo=quantities(account.cargo as Wire[]),startingModules=structuredClone(account.state.modules!);
  const shipId=account.ship!.id,startingCredits=account.credits;
  receipt.before={location:structuredClone(account.location),cargo:structuredClone(account.cargo),modules:startingModules,ship:structuredClone(account.ship),credits:startingCredits};save();
  const assertIdentity=()=>{
    if(account.ship?.id!==shipId)throw new Error('Ship changed during equipment retrieval; reconcile before further work');
    const invalid=canonicalReadinessBlockers(account.state);if(invalid.length)throw new Error(invalid.join('; '));
  };
  try {
    const existing=account.state.modules!.find(row=>Number(row.stats?.mining_power)>0);
    if(existing) {
      receipt.fitted_module=structuredClone(existing);
      receipt.return=await controls.travel(home);receipt.final_service=await controls.service();await account.refresh();assertIdentity();
      if(account.location?.docked_at!==home.base_id||account.location.in_transit||account.ship!.fuel!==account.ship!.max_fuel||
        account.ship!.hull!==account.ship!.max_hull||account.ship!.shield!==account.ship!.max_shield)throw new Error('Existing mining fit did not reach verified serviced home');
      if(!sameQuantities(quantities(account.cargo as Wire[]),startingCargo)||!containsModules(account.state.modules as Wire[],startingModules))throw new Error('Existing mining fit return did not preserve cargo and module custody');
      receipt.status='completed';receipt.after={location:structuredClone(account.location),cargo:structuredClone(account.cargo),modules:structuredClone(account.state.modules),ship:structuredClone(account.ship),credits:account.credits};save();return receipt;
    }
    const carriedAtStart=amount(account.cargo as Wire[],'mining_laser_i');
    await controls.checkpoint?.();
    if(carriedAtStart<1)receipt.outbound=await controls.travel(destination);
    else if(!account.location?.docked_at) {
      const here=account.location;
      const dock=here?.system_id===home.system_id&&here.poi_id===home.poi_id?home:
        here?.system_id===destination.system_id&&here.poi_id===destination.poi_id?destination:undefined;
      if(!dock)throw new Error('Carried Mining Laser I requires an observed current station before refitting');
      receipt.outbound=await controls.travel(dock);
    }
    await account.refresh();assertIdentity();
    const carriedLaser=amount(account.cargo as Wire[],'mining_laser_i');
    if(carriedLaser<1&&account.location?.docked_at!==destination.base_id)throw new Error('Equipment storage arrival is not verified');
    if(!account.location?.docked_at||account.location.in_transit)throw new Error('Mining refit requires a verified dock');
    const storageBefore=carriedLaser>0?undefined:details(await command('spacemolt_storage/view',{}));
    if(storageBefore&&(storageBefore.base_id!==destination.base_id||amount(storageBefore.items,'mining_laser_i')<1))throw new Error('Mining Laser I is not verified in personal storage at the chosen station');
    const utility=account.state.modules!.filter(row=>row.slot==='utility');
    const cabin=utility.find(row=>row.type_id==='economy_passenger_cabin');
    const needsSlot=utility.length>=account.ship!.utility_slots;
    if(needsSlot&&!cabin)throw new Error('No utility slot and no supported passenger cabin can be preserved for the mining refit');
    const laserRow=carriedLaser>0?(account.cargo as Wire[]).find(row=>row.item_id==='mining_laser_i'):storageBefore!.items.find((row:Wire)=>row.item_id==='mining_laser_i');
    const laserSize=laserRow?.size,cabinSize=needsSlot?cabin?.size:0;
    if(!Number.isFinite(laserSize)||laserSize<0||!Number.isFinite(cabinSize)||cabinSize!<0)throw new Error('Exact laser and displaced-cabin sizes are required before refitting');
    const requiredSpace=(carriedLaser>0?0:laserSize)+(needsSlot?cabinSize:0);
    if(account.ship!.cargo_capacity-account.ship!.cargo_used<requiredSpace)throw new Error('Cargo capacity cannot preserve the retrieved laser and displaced cabin');
    if(storageBefore){receipt.storage_before=storageBefore;save();}

    if(storageBefore) {
      await controls.checkpoint?.();
      await command('spacemolt_storage/withdraw',{item_id:'mining_laser_i',quantity:1});await account.refresh();assertIdentity();
      const storageAfter=details(await command('spacemolt_storage/view',{}));
      if(storageAfter.base_id!==destination.base_id||amount(storageBefore.items,'mining_laser_i')-amount(storageAfter.items,'mining_laser_i')!==1||
        amount(account.cargo as Wire[],'mining_laser_i')!==(startingCargo.mining_laser_i??0)+1)throw new Error('Accepted laser withdrawal custody is unverified; do not replay');
      receipt.storage_after=storageAfter;save();
    }

    let displaced:Wire|undefined;
    if(needsSlot) {
      displaced=structuredClone(cabin!);
      await controls.checkpoint?.();await command('spacemolt/uninstall_mod',{id:cabin!.module_id});await account.refresh();assertIdentity();
      if(account.state.modules!.some(row=>row.module_id===cabin!.module_id)||amount(account.cargo as Wire[],cabin!.type_id)!==(startingCargo[cabin!.type_id]??0)+1||
        !containsModules(account.state.modules as Wire[],startingModules.filter(row=>row.module_id!==cabin!.module_id)))throw new Error('Displaced passenger cabin custody was not preserved exactly');
      receipt.displaced_module=displaced;save();
    }
    const ids=new Set(account.state.modules!.map(row=>row.module_id));
    await controls.checkpoint?.();await command('spacemolt/install_mod',{id:'mining_laser_i'});await account.refresh();assertIdentity();
    const fitted=account.state.modules!.filter(row=>!ids.has(row.module_id)&&row.type_id==='mining_laser_i'&&row.slot==='utility'&&Number(row.stats?.mining_power)>0);
    const expectedLaserCargo=(startingCargo.mining_laser_i??0)+(storageBefore?1:0)-1;
    if(fitted.length!==1||amount(account.cargo as Wire[],'mining_laser_i')!==expectedLaserCargo||
      !containsModules(account.state.modules as Wire[],startingModules.filter(row=>row.module_id!==displaced?.module_id)))throw new Error('Exact mining-laser installation or preserved module custody is unverified');
    receipt.fitted_module=structuredClone(fitted[0]);save();

    receipt.remote_service=await controls.service();
    receipt.return=await controls.travel(home);
    receipt.final_service=await controls.service();await account.refresh();assertIdentity();
    if(account.location?.docked_at!==home.base_id||account.location.in_transit)throw new Error('Equipment retrieval did not return to remembered home');
    if(account.ship!.fuel!==account.ship!.max_fuel||account.ship!.hull!==account.ship!.max_hull||account.ship!.shield!==account.ship!.max_shield)throw new Error('Equipment retrieval final service is incomplete');
    const finalCargo=quantities(account.cargo as Wire[]),expected={...startingCargo};
    if((expected.mining_laser_i??0)>0)expected.mining_laser_i!--;
    if(displaced)expected[displaced.type_id]=(expected[displaced.type_id]??0)+1;
    if(!sameQuantities(finalCargo,expected))throw new Error('Final cargo differs from starting custody plus the preserved displaced cabin');
    if(!containsModules(account.state.modules as Wire[],startingModules.filter(row=>row.module_id!==displaced?.module_id))||
      !account.state.modules!.some(row=>row.module_id===fitted[0]!.module_id&&row.type_id==='mining_laser_i'))throw new Error('Final fitted-module custody is unverified');
    receipt.status='completed';receipt.after={location:structuredClone(account.location),cargo:structuredClone(account.cargo),modules:structuredClone(account.state.modules),ship:structuredClone(account.ship),credits:account.credits};
    receipt.cash_delta=account.credits!-startingCredits!;save();return receipt;
  } catch(error) {
    receipt.status='blocked';receipt.error=String(error);save();throw error;
  }
}
