import {Effect} from 'effect';
import {mineToFullEffect,type MineOptions} from '../mine.ts';
import {GameLive} from '../play/game.ts';
import {FakeLibGoalAccount} from './fake-lib-account.ts';

export type MineServer={ship:{id:string;cargo_used:number;cargo_capacity:number};location:{system_id:string;poi_id?:string;docked_at?:string};cargo:{item_id:string;quantity:number}[]};
export const dig=(fake:FakeLibGoalAccount<MineServer>,quantity:number)=>{
  fake.server.cargo=[{item_id:'ore',quantity:(fake.server.cargo[0]?.quantity??0)+quantity}];
  fake.server.ship.cargo_used+=quantity;
};
/** A ship at a belt with room for 10. `mine` is the server's answer: it may change the world and then throw. */
export const mineWorld=(mine:(fake:FakeLibGoalAccount<MineServer>)=>unknown,location:MineServer['location']={system_id:'sol',poi_id:'belt'})=>{
  const fake:FakeLibGoalAccount<MineServer>=new FakeLibGoalAccount<MineServer>(
    {ship:{id:'s1',cargo_used:0,cargo_capacity:10},location,cargo:[]},{spacemolt:{mine:()=>mine(fake)}});
  const send=(action:string,params:Record<string,unknown>)=>{const [tool='',name='']=action.split('/');return fake.send(tool,name,params);};
  return {fake,send,mines:()=>fake.calls.filter(c=>c.action==='mine').length};
};
export const mineLive=(w:ReturnType<typeof mineWorld>)=>GameLive({send:w.send,refresh:()=>w.fake.refresh()});
/** The twin run to its outcome; a game failure or defect rejects. */
export const mineTwin=(w:ReturnType<typeof mineWorld>,options?:MineOptions)=>
  Effect.runPromise(mineToFullEffect(w.fake,options).pipe(Effect.provide(mineLive(w))));
