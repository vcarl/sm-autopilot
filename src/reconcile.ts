/** What the world did to the pilot with no command behind it (S41, C13).
 *
 * The ship can be moved by death, capture, or a fleet that kicks it, and none of those
 * announces itself in the state a script reads. The game pushes `player_died` (carrying
 * `respawn_base` and the lost ship) and `ship_captured` as typed notifications, and a fleet
 * kick arrives as an `action_result` with no request_id; this runner subscribes to none of
 * them. So every cause below is INFERRED from a live read — the four location fields plus
 * ship identity, hull and crew — and never a claim the server made. The inference is only
 * ever used to name what happened; the decision it drives is the same for all of them:
 * stop, and reconcile from live state before acting.
 */
import type {GameState} from '@spacemolt/lib';
import type {ReadinessAccount} from './readiness.ts';

export type MoveCause='respawn'|'captured'|'fleet_kick'|'unknown';
/** Where the last command left the pilot. The four location fields S41 names, plus the two
 * that say whether this is still the same ship with a crew to fly it. */
export interface Position {
  ship_id:string|null;system_id:string|null;poi_id:string|null;
  docked_at:string|null;in_transit:boolean;incapacitated:boolean;
}
export interface Reconciliation {
  moved:boolean;
  cause?:MoveCause;
  from:Position;to:Position;
  /** The fields that differed, in the words of the two reads. Empty when nothing moved. */
  evidence:string;
}

export const position=(state:GameState):Position=>{
  const {ship,location}=state??{};
  return {ship_id:ship?.id??null,system_id:location?.system_id??null,poi_id:location?.poi_id??null,
    docked_at:location?.docked_at??null,in_transit:Boolean(location?.in_transit),
    incapacitated:Boolean(ship?.incapacitated)};
};

const FIELDS=['ship_id','system_id','poi_id','docked_at','in_transit','incapacitated'] as const;

/** The pilot's own respawn point, as the player record gives it (`set_home` sets it). */
const atHome=(to:Position,state:GameState)=>{
  const player=state?.player;
  if(!player?.home_base)return false;
  return to.docked_at===player.home_base||
    (Boolean(player.home_poi)&&to.poi_id===player.home_poi&&
      (!player.home_system||to.system_id===player.home_system));
};

function classify(from:Position,to:Position,state:GameState):MoveCause {
  const ship=state?.ship;
  const whole=typeof ship?.hull==='number'&&typeof ship.max_hull==='number'&&ship.hull>=ship.max_hull;
  const relocated=to.ship_id!==from.ship_id||to.system_id!==from.system_id||
    to.poi_id!==from.poi_id||to.docked_at!==from.docked_at;
  // A death is only visible as its aftermath: a hull made whole at the pilot's own respawn
  // base, usually in a different ship because the old one was lost with the pilot.
  if(relocated&&whole&&atHome(to,state))return 'respawn';
  // Boarding is what the state can show: `incapacitated` is "no fit crew can operate your
  // ship", which is the boarding outcome, not a capture flag — the capture itself is only
  // ever announced in a `ship_captured` push.
  if(to.incapacitated&&!from.incapacitated)return 'captured';
  // Somewhere else, under way from nowhere, in the same ship: someone else moved it.
  if(relocated&&!to.in_transit&&to.ship_id===from.ship_id)return 'fleet_kick';
  return 'unknown';
}

/** Read the world and compare it with what the last command left. Issues no command: the
 * whole point is to find out what is true before anything else is sent.
 *
 * `read:false` is for the one caller that has just taken that read itself — an arrival wait
 * refreshes at its own deadline — so the comparison uses the freshest read rather than
 * spending a second one on it.
 */
export async function reconcileMove(account:ReadinessAccount,expected:Position,
  options:{read?:boolean}={}):Promise<Reconciliation> {
  if(options.read!==false)await account.refresh();
  const to=position(account.state);
  const differences=FIELDS.filter(field=>to[field]!==expected[field])
    .map(field=>`${field} ${JSON.stringify(expected[field])} -> ${JSON.stringify(to[field])}`);
  if(!differences.length)return {moved:false,from:expected,to,evidence:''};
  return {moved:true,cause:classify(expected,to,account.state),from:expected,to,
    evidence:differences.join('; ')};
}

/** A respawn is the world putting the pilot home, which is a juncture the agent can answer
 * from where it stands; anything else needs a reading before the pilot acts again. */
export const movedOutcome=(cause?:MoveCause):'blocked'|'failed'=>cause==='respawn'?'blocked':'failed';
