type Row = Record<string, any>;
const details=(reply:any):Row=>reply?.structuredContent??reply?.delta?.details??reply??{};
/** One coherent discovery scope; never shared with production or across station visits. */
export async function stationSnapshot(command:(action:string,params?:Row)=>Promise<unknown>,includeFacilities=true) {
  const market=details(await command('spacemolt_market/view_market',{}));
  const storage=details(await command('spacemolt_storage/view',{}));
  const facilities=includeFacilities?details(await command('spacemolt_facility/list',{})):{};
  if(!Array.isArray(market.items)||!Array.isArray(storage.items))throw new Error('Incomplete market/storage snapshot');
  return {market,storage,facilities};
}
