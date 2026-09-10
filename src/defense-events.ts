import type {Account} from '@spacemolt/lib';
import type {BridgeQueue} from './bridge-input.ts';

interface DefenseExecution {
  requestDefense():void;
  respondToDanger():Promise<unknown>;
}

/** Push callbacks only wake the existing owner; they never send game commands. */
export function watchDefense(account:Pick<Account,'on'|'onReconnected'|'state'>,execution:DefenseExecution,queue:BridgeQueue,onError:(error:unknown)=>void) {
  let queued=false,dirty=false,closed=false;
  const wake=()=>{
    if(closed)return;
    execution.requestDefense();dirty=true;
    if(queued)return;
    queued=true;
    queue.enqueue(async()=>{
      try {
        do {dirty=false;await execution.respondToDanger();}while(dirty);
      } catch(error) {onError(error);}
      finally {queued=false;}
    });
  };
  const own=()=>account.state.player?.id;
  const participant=(payload:{participants:Array<{player_id:string}>})=>{
    const id=own();if(id&&payload.participants.some(p=>p.player_id===id))wake();
  };
  const unsubscribers=[
    account.on('battle_started',participant),
    account.on('battle_alert',participant),
    account.on('battle_update',participant),
    account.on('battle_joined',payload=>{if(own()&&payload.player_id===own())wake();}),
    account.on('battle_damage',payload=>{if(own()&&payload.target_id===own())wake();}),
    // Auth consumes logged_in frames; this hook runs after refresh and resubscription.
    account.onReconnected(wake),
  ];
  wake();
  return ()=>{closed=true;for(const unsubscribe of unsubscribers)unsubscribe();};
}
