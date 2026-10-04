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
import type { GameState } from '@spacemolt/lib';
import { Effect } from 'effect';
import type { ReadinessAccount } from './readiness.ts';
export type MoveCause = 'respawn' | 'captured' | 'fleet_kick' | 'unknown';
/** Where the last command left the pilot. The four location fields S41 names, plus the two
 * that say whether this is still the same ship with a crew to fly it. */
export interface Position {
    ship_id: string | null;
    system_id: string | null;
    poi_id: string | null;
    docked_at: string | null;
    in_transit: boolean;
    incapacitated: boolean;
}
export interface Reconciliation {
    moved: boolean;
    cause?: MoveCause;
    from: Position;
    to: Position;
    /** The fields that differed, in the words of the two reads. Empty when nothing moved. */
    evidence: string;
}
export declare const position: (state: GameState) => Position;
/** Read the world and compare it with what the last command left. Issues no command: the
 * whole point is to find out what is true before anything else is sent.
 *
 * `read:false` is for the one caller that has just taken that read itself — an arrival wait
 * refreshes at its own deadline — so the comparison uses the freshest read rather than
 * spending a second one on it (`reconcile`). A failed read is classified as any game step's
 * is (`attempt`): the lib's refusal or a lost reply its tag, anything else a defect.
 */
export declare const reconcileMoveEffect: (account: ReadinessAccount, expected: Position, options?: {
    read?: boolean;
}) => Effect.Effect<Reconciliation, import("./play/codes.ts").GameError, never>;
/** The comparison alone, against the read already taken. */
export declare function reconcile(state: GameState, expected: Position): Reconciliation;
/** A respawn is the world putting the pilot home, which is a juncture the agent can answer
 * from where it stands; anything else needs a reading before the pilot acts again. */
export declare const movedOutcome: (cause?: MoveCause) => "blocked" | "failed";
