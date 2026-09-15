import {ConnectionClosedError,SpacemoltError} from '@spacemolt/lib';

const uncertainCodes=new Set(['mutation_timeout','query_timeout','connect_timeout','connection_closed','disconnected','invalid_response','action_pending']);
const knownRejection=(error:unknown)=>error instanceof SpacemoltError&&!error.pendingCommand&&!uncertainCodes.has(error.code);

/**
 * The reply is gone, not the outcome: the command may still have landed. Reconcile, never retry blind.
 * Only a transport drop (ConnectionClosedError) or a server-reported ambiguous outcome
 * (SpacemoltError with a pending command or a timeout/pending code) counts as lost — a plain
 * Error/AssertionError (e.g. a test fixture's own assertion) or a definitive SpacemoltError
 * rejection is a real failure, not an ambiguous one.
 */
export const replyLost=(error:unknown)=>error instanceof ConnectionClosedError||(error instanceof SpacemoltError&&(Boolean(error.pendingCommand)||uncertainCodes.has(error.code)));

/** A composite operation cannot swallow an ambiguous send and then continue. */
export class CommandBoundary {
  sent=false;
  completed=false;
  private failure:unknown;
  private failed=false;

  assertHealthy() { if(this.failed)throw this.failure; }

  async run<T>(operation:(sent:()=>void,completed:()=>void)=>Promise<T>):Promise<T> {
    this.assertHealthy();
    this.sent=false;
    this.completed=false;
    try {
      return await operation(()=>{this.sent=true;},()=>{this.completed=true;});
    } catch(error) {
      if(this.completed||(this.sent&&!knownRejection(error))) {
        this.failed=true;
        this.failure=error;
      }
      throw error;
    }
  }

  status(error:unknown) {
    return {
      outcome_unknown:this.sent&&!this.completed&&!knownRejection(error),
      fatal:this.failed||this.completed||(this.sent&&!knownRejection(error)),
      action_completed:this.completed,
    };
  }
}
