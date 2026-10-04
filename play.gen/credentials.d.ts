/** The one endpoint this runner talks to. */
export declare const GAME_WS_URL = "wss://game.spacemolt.com/ws/v2";
export declare function readCredentials(path: string): {
    username: string;
    password: string;
};
