import {ConnectionClosedError,SpacemoltError} from '@spacemolt/lib';

const uncertainCodes=new Set(['mutation_timeout','query_timeout','connect_timeout','connection_closed','disconnected','invalid_response','action_pending']);

/** The lib refused to send at all (`cannot send: account is reconnecting`, `cannot send on a closed socket`):
 * nothing reached the game, so the outcome is known. A ConnectionClosedError, but never a lost reply. */
export const notSent=(error:unknown)=>error instanceof ConnectionClosedError&&error.message.startsWith('cannot send');

/**
 * The reply is gone, not the outcome: the command may still have landed. Reconcile, never retry blind.
 * Only a transport drop (ConnectionClosedError) or a server-reported ambiguous outcome
 * (SpacemoltError with a pending command or a timeout/pending code) counts as lost — a plain
 * Error/AssertionError (e.g. a test fixture's own assertion) or a definitive SpacemoltError
 * rejection is a real failure, not an ambiguous one.
 */
export const replyLost=(error:unknown)=>error instanceof ConnectionClosedError&&!notSent(error)||(error instanceof SpacemoltError&&(Boolean(error.pendingCommand)||uncertainCodes.has(error.code)));

/** A failure as the journal and the gap texts say it: its code or name, then its message. */
export const causeText=(error:unknown)=>{
  const named=error instanceof SpacemoltError?error.code:error instanceof Error?error.name:'';
  return `${named||'error'}: ${error instanceof Error?error.message:String(error)}`;
};
