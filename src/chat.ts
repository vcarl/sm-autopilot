/** Chat as raw facts: every `chat_message` push, every message this pilot sent, and the unread
 * counts a reply carried, one line each in `runtime/chat.jsonl` (rotated at boot with the journal,
 * never deleted). The juncture renders the posts since the last juncture from it, and its gate
 * reads it for a private message still waiting. Chat text is other players' words: it is kept and
 * shown as data, never acted on here.
 *
 * A post the running program declared (`interrupts`) is also handed to the run, which pauses at its
 * next safe point (`hear` in play/runtime.ts). */
import {appendFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {Result,Schema,Struct} from 'effect';
import {replyBody} from './storage.ts';
import {journalRun} from './run-record.ts';
import {hear} from './play/runtime.ts';
import * as Wire from './wire.gen.ts';

export const CHAT_FILE='chat.jsonl';

/** The push's fields this code reads, picked from the spec. The spec marks all of them optional; a
 * post with no channel or no content is not a post, and is journalled as undecodable. */
const Frame=Wire.Notification_chat_message.schema.mapFields(Struct.pick(['channel','content','sender','sender_id',
  'poi_id','system_id','target_id','target_name','timestamp']));
const decodeFrame=Schema.decodeUnknownResult(Frame);
const Unread=Wire.DockResponse.mapFields(Struct.pick(['unread_chat']));
const decodeUnread=Schema.decodeUnknownResult(Unread);

/** One line of the chat record. */
function append(runtime:string,entry:Record<string,unknown>):void {
  mkdirSync(runtime,{recursive:true});
  appendFileSync(join(runtime,CHAT_FILE),`${JSON.stringify({at:new Date().toISOString(),...entry})}\n`,{mode:0o600});
}

/** One `chat_message` frame: kept as a `post` line, offered to the run, or journalled as undecodable.
 * Never throws: it runs on the socket's push. `self` is this pilot's player id: its own echo never
 * pauses its own run. */
export function hearChat(runtime:string,payload:unknown,self?:string):void {
  const read=decodeFrame(payload);
  if(Result.isFailure(read)) {journalRun(runtime,{why:read.failure.message},'chat_undecodable');return;}
  const {channel,content,timestamp,...where}=read.success;
  if(channel===undefined||content===undefined) {
    journalRun(runtime,{why:`a chat_message with no ${channel===undefined?'channel':'content'}`,keys:Object.keys(read.success)},'chat_undecodable');
    return;
  }
  const at=timestamp??new Date().toISOString();
  append(runtime,{event:'post',channel,content,...where,...timestamp?{sent_at:timestamp}:{}});
  if(self!==undefined&&where.sender_id===self)return;
  if(hear({channel,content,sender:where.sender,sender_id:where.sender_id,at}))
    journalRun(runtime,{channel,sender:where.sender??null,sender_id:where.sender_id??null},'chat_interrupt');
}

/** A message this pilot sent, as the game confirmed it: the gate's "answered". */
export function recordSent(runtime:string,sent:{channel:string;to?:string|undefined;content:string;sent_at?:number}):void {
  append(runtime,{event:'sent',channel:sent.channel,...sent.to?{target_id:sent.to}:{},content:sent.content,
    ...sent.sent_at===undefined?{}:{sent_at:sent.sent_at}});
}

/** The unread counts a reply carried (`dock` does), when it carried them. */
export function noteUnread(runtime:string,reply:unknown):void {
  const read=decodeUnread(replyBody(reply));
  if(Result.isSuccess(read)&&read.success.unread_chat)append(runtime,{event:'unread',counts:read.success.unread_chat});
}

/** Listen on the account that outlives every run. Called once from `main()`; a freighter's account never is. */
export function chatJournal(account:{on:(type:string,handler:(payload:Record<string,unknown>)=>void)=>unknown;player?:{id?:string}|undefined},
  runtime:string):void {
  account.on('chat_message',payload=>hearChat(runtime,payload,account.player?.id));
}
