export declare const CHAT_FILE = "chat.jsonl";
/** One `chat_message` frame: kept as a `post` line, offered to the run, or journalled as undecodable.
 * Never throws: it runs on the socket's push. `self` is this pilot's player id: its own echo never
 * pauses its own run. */
export declare function hearChat(runtime: string, payload: unknown, self?: string): void;
/** A message this pilot sent, as the game confirmed it: the gate's "answered". */
export declare function recordSent(runtime: string, sent: {
    channel: string;
    to?: string | undefined;
    content: string;
    sent_at?: number;
}): void;
/** The unread counts a reply carried (`dock` does), when it carried them. */
export declare function noteUnread(runtime: string, reply: unknown): void;
/** Listen on the account that outlives every run. Called once from `main()`; a freighter's account never is. */
export declare function chatJournal(account: {
    on: (type: string, handler: (payload: Record<string, unknown>) => void) => unknown;
    player?: {
        id?: string;
    } | undefined;
}, runtime: string): void;
