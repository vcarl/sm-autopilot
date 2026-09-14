/** Validate server route structure; each caller supplies its own admitted jump bound. */
export function routeSteps(route:any,from:string,to:string,maxJumps:number|null):string[] {
  if(maxJumps!==null&&(!Number.isSafeInteger(maxJumps)||maxJumps<0))throw new Error('Route jump allocation must be a nonnegative integer or null for a fuel-verified route');
  if(route.found!==true||route.target_system!==to||!Number.isSafeInteger(route.total_jumps)||route.total_jumps<0||(maxJumps!==null&&route.total_jumps>maxJumps)||!Array.isArray(route.route))throw new Error(`Route must contain ${maxJumps===null?'a finite number of':`0..${maxJumps}`} normal jumps`);
  if(route.route.length!==route.total_jumps+1||route.route[0]?.system_id!==from||route.route.at(-1)?.system_id!==to||route.route.some((r:any,i:number)=>r.via_wormhole||r.jumps!==i||typeof r.system_id!=='string'))throw new Error('Route is inconsistent or uses a wormhole');
  if(!Number.isFinite(route.estimated_fuel)||route.estimated_fuel<0||!Number.isFinite(route.fuel_per_jump)||route.fuel_per_jump<0)throw new Error('Route lacks a fuel quote');
  return route.route.slice(1).map((r:any)=>r.system_id);
}
