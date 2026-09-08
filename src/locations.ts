import { SpacemoltClient, fetchStations } from '@spacemolt/lib';

const publicData = new SpacemoltClient();

/** Public directory discovery; never opens a player connection. */
export async function industryLocations(systemId: string | undefined, params: Record<string, unknown>) {
  if (!systemId) return {status:'blocked',reason:'Current system is unknown'};
  const maxJumps = Number(params.max_jumps ?? 2), limit = Number(params.limit ?? 10);
  if (!Number.isInteger(maxJumps) || maxJumps < 1 || maxJumps > 5 || !Number.isInteger(limit) || limit < 1 || limit > 30) throw new Error('max_jumps must be 1..5 and limit 1..30');
  const [map, directory] = await Promise.all([publicData.map(), fetchStations(publicData.httpBaseUrl)]);
  const distances = new Map<string, number>([[systemId, 0]]);
  const queue = [systemId];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!, hops = distances.get(id)!;
    if (hops >= maxJumps) continue;
    for (const next of map.system(id)?.connections ?? []) if (!distances.has(next)) {
      distances.set(next, hops + 1); queue.push(next);
    }
  }
  const stations = directory.stations.filter(station => distances.has(station.system_id)).map(station => ({
    system_id: station.system_id, system_name: station.system_name, hops: distances.get(station.system_id)!,
    station_name: station.name, base_id: station.base_id, poi_id: station.poi_id, services: station.services,
  })).sort((a,b) => a.hops - b.hops || a.station_name.localeCompare(b.station_name));
  return {origin_system:systemId, max_jumps:maxJumps, total_stations:stations.length, stations:stations.slice(0,limit),
    limitation:'Public station directory and map connections only. Observe live resources, market depth, route costs and docking access before committing travel.'};
}
