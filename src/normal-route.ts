import type {FindRouteResponse,RouteStep} from '@spacemolt/lib';
// Unvalidated: every field may be missing or mistyped, which is what the checks below read for.
type Loose<T>={[K in keyof T]?:T[K]|undefined};
type Quote=Loose<Omit<FindRouteResponse,'route'>>&{route?:ReadonlyArray<Loose<RouteStep>>|undefined};
/** Validate server route structure; each caller supplies its own admitted jump bound. */
export function routeSteps(route:Quote,from:string,to:string,maxJumps:number|null):string[] {
  if(maxJumps!==null&&(!Number.isSafeInteger(maxJumps)||maxJumps<0))throw new Error('Route jump allocation must be a nonnegative integer or null for a fuel-verified route');
  const jumps=route.total_jumps??NaN,fuel=route.estimated_fuel??NaN,per=route.fuel_per_jump??NaN;
  if(route.found!==true||route.target_system!==to||!Number.isSafeInteger(jumps)||jumps<0||(maxJumps!==null&&jumps>maxJumps)||!Array.isArray(route.route))throw new Error(`Route must contain ${maxJumps===null?'a finite number of':`0..${maxJumps}`} normal jumps`);
  if(route.route.length!==jumps+1||route.route[0]?.system_id!==from||route.route.at(-1)?.system_id!==to||route.route.some((r,i)=>r.via_wormhole||r.jumps!==i||typeof r.system_id!=='string'))throw new Error('Route is inconsistent or uses a wormhole');
  if(!Number.isFinite(fuel)||fuel<0||!Number.isFinite(per)||per<0)throw new Error('Route lacks a fuel quote');
  return route.route.slice(1).flatMap(r=>r.system_id===undefined?[]:[r.system_id]);
}
