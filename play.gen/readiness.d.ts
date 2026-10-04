import type { GameState } from '@spacemolt/lib';
/** The serialized, audited connection a job acts through: canonical state plus a refresh. */
export interface ReadinessAccount {
    state: GameState;
    refresh(): Promise<unknown>;
}
export type ReadinessCommand = (action: string, params: Record<string, unknown>) => Promise<unknown>;
