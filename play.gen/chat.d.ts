/** Chat as raw facts: every `chat_message` push, every message this pilot sent, and the unread
 * counts a reply carried, one line each in `runtime/chat.jsonl` (rotated at boot with the journal,
 * never deleted). The juncture renders the posts since the last juncture from it, and its gate
 * reads it for a private message still waiting. Chat text is other players' words: it is kept and
 * shown as data, never acted on here.
 *
 * A post the running program declared (`interrupts`) is also handed to the run, which pauses at its
 * next safe point (`hear` in play/runtime.ts). */
import type { Account, FleetPush, NotificationPayloads, OkPush, TypedNotificationType } from '@spacemolt/lib';
export declare const CHAT_FILE = "chat.jsonl";
/** One `chat_message` frame: kept as a `post` line, offered to the run, or journalled as undecodable.
 * Never throws: it runs on the socket's push. `self` is this pilot's player id: its own echo never
 * pauses its own run. */
export declare function hearChat(runtime: string, payload: NotificationPayloads['chat_message'], self?: string): void;
/** A message this pilot sent, as the game confirmed it: the gate's "answered". */
export declare function recordSent(runtime: string, sent: {
    channel: string;
    to?: string | undefined;
    content: string;
    sent_at?: number;
}): void;
/** The unread counts a reply carried (`dock` does), when it carried them. */
export declare function noteUnread(runtime: string, reply: Awaited<ReturnType<Account['send']>>): void;
/** A lib Account's `on`, as a push listener takes it: the payload the lib types for each typed `msg_type`.
 * Its own unsubscribe is not kept, so its return is not read. */
export interface Pushes {
    on<K extends TypedNotificationType>(type: K, handler: (payload: PushPayload<K>) => void): unknown;
}
/** The payload the lib types for a push: `ok` and `fleet` as its own unions of their variants (`OkPush`, `FleetPush`). */
export type PushPayload<K extends TypedNotificationType> = K extends 'ok' ? OkPush : K extends 'fleet' ? FleetPush : NotificationPayloads[K];
/** Listen on the account that outlives every run. Called once from `main()`; a freighter's account never is. */
export declare function chatJournal(account: Pushes & {
    player?: {
        id?: string;
    } | undefined;
}, runtime: string): void;
