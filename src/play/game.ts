/** The `Game` service: the one connection, every game failure classified once (docs/EFFECT.md
 * §Services, §Errors). `replyLost` (command-boundary.ts) is the one definition of a lost reply:
 * the lib's `ConnectionClosedError`, a pending command, or an uncertain code. Never exported from
 * a barrel: the pilot never sees Effect.
 *
 * ponytail: `GameLive` sends through the lib's `send` seam, not the typed facade, so the
 * existing fake account (which has only `send`) runs under it; `bind()` hands it the binding's
 * journalled `command()` path (journal line, reconnect-and-wait, the Tired check) as that `send`.
 * Typed, decoded domain methods come with the units. */
import {SpacemoltError, type Account} from '@spacemolt/lib';
import {Context, Effect, Layer} from 'effect';
import {replyLost} from '../command-boundary.ts';
import {ReplyLost, refusal, type GameError} from './codes.ts';

export {Depleted, HoldFull, InBattle, Rejected, ReplyLost, type GameError} from './codes.ts';

/** `cause` to its tag. The only reader of `SpacemoltError`. Anything that is neither the lib's
 * refusal nor a lost reply is a bug, not a game outcome: it is rethrown, and `tryPromise`
 * makes a throwing `catch` a defect. */
export const classify = (action: string) => (cause: unknown): GameError => {
  if (replyLost(cause)) return new ReplyLost({action, cause});
  if (cause instanceof SpacemoltError) return refusal({action, code: cause.code, message: cause.message});
  throw cause;
};

export class Game extends Context.Service<Game, {
  /** One command, `tool/action`, as the bridge's command seam names it. */
  readonly command: (action: string, params?: Record<string, unknown>) => Effect.Effect<unknown, GameError>;
}>()('Game') {}

/** Over the lib's `send`, widened to `unknown` replies so the fake account fits as it is. */
export const GameLive = (account: {readonly send: (...args: Parameters<Account['send']>) => Promise<unknown>}) => Layer.succeed(Game, {
  command: (action, params = {}) => {
    const [tool = '', name = ''] = action.split('/');
    return Effect.tryPromise({try: () => account.send(tool, name, params), catch: classify(action)});
  },
});
