/** The lib refused to send at all (`cannot send: account is reconnecting`, `cannot send on a closed socket`):
 * nothing reached the game, so the outcome is known. A ConnectionClosedError, but never a lost reply. */
export declare const notSent: (error: unknown) => boolean;
/**
 * The reply is gone, not the outcome: the command may still have landed. Reconcile, never retry blind.
 * Only a transport drop (ConnectionClosedError) or a server-reported ambiguous outcome
 * (SpacemoltError with a pending command or a timeout/pending code) counts as lost — a plain
 * Error/AssertionError (e.g. a test fixture's own assertion) or a definitive SpacemoltError
 * rejection is a real failure, not an ambiguous one.
 */
export declare const replyLost: (error: unknown) => boolean;
/** A failure as the journal and the gap texts say it: its code or name, then its message. */
export declare const causeText: (error: unknown) => string;
