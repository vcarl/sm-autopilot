/** Owning production. Advanced stage: level-N facilities need corporation_management N, cost
 * 10,000 (personal quarters, the prerequisite) to millions, and bill rent every ~17 minutes
 * that, unpaid for ~3 days, loses the facility for good. */
import type {FacilityJobListResponse,FacilityPersonalBuildResponse,FacilityTypeSummary,OwnedFacilityEntry} from '@spacemolt/lib';
import type {Outcome} from '../../types.ts';

/** The owned entry (`rent_per_cycle`, `missed_rent_cycles`, `arrears_owed`) beside the one
 * number the game does not compute: how many cycles the wallet covers. */
export type Owned=OwnedFacilityEntry&{runway_cycles:number;jobs:FacilityJobListResponse['jobs']};

/** Your facilities and their rent bill, plus the types buildable here (`buildable`,
 * `build_cost`, `level`). Reads only (`facility/owned`, `facility/types`, `facility/job_list`).
 * `next` warns when any runway is under 260 cycles. */
export function facilities():Promise<Outcome<{owned:Owned[];buildable:FacilityTypeSummary[]}>> {throw new Error('unimplemented');}

/** Build a personal facility here (quarters first; the game requires them). Refused when
 * `build_cost` plus 260 cycles of rent would breach `credit_reserve`, or the skill level is
 * short. Costs the build price; earns passive corporation_management xp thereafter. */
export function buildFacility(type:string):Promise<Outcome<FacilityPersonalBuildResponse>> {throw new Error('unimplemented');}

/** Queue a production job at a facility you own (`facility/job_add`). Inputs from this
 * base's store. Refused when inputs or fee are short. Outputs land in the store when done;
 * `craft` with `preset:'prefer_own'` routes to it automatically thereafter. */
export function queueJob(facilityId:string,recipeId:string,quantity:number):Promise<Outcome<FacilityJobListResponse>> {throw new Error('unimplemented');}
