/** The service counter: fuel, hull and, asked, insurance. Dues wait for a later slice. */
import type { GetBaseResponse } from '@spacemolt/lib';
import { Effect } from 'effect';
import { Game } from './game.ts';
import { Run } from './runtime.ts';
import type { Outcome } from './types.ts';
export interface Serviced {
    /** The counter as it was read before the spend. A posted `fuel_price_all_in` or
     * `repair_price_per_hull` is an estimate; an absent one is not a refusal. */
    base: GetBaseResponse;
    /** The commands sent (`spacemolt/refuel`, `spacemolt/repair`) and what they cost together. */
    issued: string[];
    spent: number;
    /** What this call was asked for and did not do (`insure`, `dues`, partial targets). */
    short: string[];
    /** With `insure`: the counter's quote for the flown hull, and the policy bought when one was. */
    insurance?: Insurance;
    /** True when this call cleared a Tired mood. */
    cleared_tired: boolean;
}
/** The insurance counter's answer. `quote` is `spacemolt_salvage/quote`'s, risk-priced for the hull
 * flown (`fitted_value`, `risk_score` and the `factors` behind it); `policy` is what `insure` bought;
 * `held` is an active policy `spacemolt_salvage/policies` already lists for this hull's class, which
 * is why nothing was quoted or bought. */
export interface Insurance {
    held?: {
        policy_id: string;
        coverage?: number;
        expires_at?: string;
        ship_class?: string;
    };
    quote?: {
        premium?: number;
        coverage?: number;
        fitted_value?: number;
        risk_score?: number;
        refused?: boolean;
        expires_in?: string;
        factors: string[];
    };
    policy?: {
        policy_id?: string;
        premium?: number;
        coverage?: number;
        expires_at?: string;
    };
}
/** One base worth flying to for a service: the call, and everything known about it. A refused (or partially
 * filled) `service` names them in `next`. */
export interface Elsewhere {
    call: string;
    why: string;
    base: string;
}
/** Where else the pilot could be brought up. Only a service clears Tired, so a station that
 * cannot quote what is missing leaves the mood standing: the route to a base that might is the
 * useful line, not a flat reserve.
 *
 * Reads only, and every read may fail — no advice beats a made-up one. What a read cannot answer
 * is said in the row rather than keeping the row off the list: an unverifiable trip the pilot may
 * attempt beats a verified dead end, and the judgement is the pilot's (the live deadlock,
 * 2026-09-24, where the only offered move was a `service()` that refuses every time).
 *
 * The prices are `inspect({id})`'s: it names a base by id and answers with the docked-base body
 * (`InspectResponse.base: GetBaseResponse`). Its reach is **this system only** — the live server
 * refuses a far id with "You can only inspect a point of interest in your current system"
 * (2026-09-24, a run that broke on exactly that) — so it is asked for in-system candidates and
 * not asked at all for a base the journal remembers in another system, whose row says plainly
 * that no price is readable from here. It may also decline in-system, so it is still guarded.
 *
 * The candidates are this system's bases, else the far ones `places.json` has placed. The journal
 * was the far list once, read for docks in `response.result`: on the live journal (2026-09-28) that
 * shape matched nothing, and a Tired pilot one jump from a placed base resupplied "stranded". */
export declare const serviceElsewhereEffect: (docked?: string) => Effect.Effect<Elsewhere[], never, Game>;
export declare const asBase: (body: unknown) => GetBaseResponse;
/** Bring the ship up at the counter you are docked at: full tank and full hull.
 *
 * Over `refuel` + `repair` it adds: the quote read first, the mood's spend margin on the repair
 * (never the fuel: a mood must not strand a ship), the charge checked against the quote, and the
 * post-state read to confirm the fill. A full ship sends nothing. Not docked: `refused`.
 *
 * A counter bills on credits and reports the charge afterwards, so a station that posts no
 * price still refuels and repairs: the posted price is only a pre-flight estimate.
 *
 * A wallet short of the whole bill buys what it can — the fuel first, then the repair if it still
 * fits — and the call is `partial`, with what was not bought in `short` and `why`.
 *
 * Tired: resupplying back inside the margins is what clears it (the mood is derived from the
 * ship), and `cleared_tired` says so.
 *
 * `insure:true` buys cover after the fill (fuel first: cover must not strand a ship): the policies
 * held, then the quote, then `insure`. Cover already
 * held for the hull is reported in `detail.insurance.held` and `did`, and nothing is bought. Not bought is `partial`, with the
 * quote in `detail.insurance` and the reason in `short`. `dues` is accepted and reported in `short`
 * until a later slice implements it. */
export declare const serviceEffect: (opts?: NonNullable<Parameters<typeof service>[0]>) => Effect.Effect<Outcome<Serviced>, never, Game | Run>;
export declare function service(opts?: {
    fuel?: number;
    hull?: number;
    insure?: boolean;
    dues?: boolean | 'all';
}): Promise<Outcome<Serviced>>;
/** Tired's guarantee, kept by the runtime and not left to the script: bring the ship back inside
 * its margins. Docked, service here; otherwise (or when this counter could not clear it) fly to
 * each base `serviceElsewhere` names and service there, until one clears it. `travel:false`
 * services only where the ship stands — a stopped flight does not fly off. Every attempt is
 * journalled as `resupply`, with what triggered it and the ship before and after. Away from a counter the fuel cells aboard are burned first
 * (`burnCells`), which may be all a fuel crossing needs.
 *
 * `cleared` when the ship is no longer Tired; `broke` when a counter was reached but the wallet
 * did not cover what clears it, so earning is the way out; `stranded` otherwise.
 *
 * ponytail: the bases are tried in `serviceElsewhere`'s order (this system first), not by route
 * cost, and a wallet refused here is still flown to the next counter. */
export declare const resupplyEffect: (opts: {
    travel?: boolean;
    trigger: Trigger;
    facts?: Record<string, unknown>;
}) => Effect.Effect<"stranded" | "broke" | "cleared", never, Game | Run>;
type Trigger = 'dock' | 'arrival' | 'call' | 'run_end' | 'route';
/** Tired's guarantee wherever the ship stops: a dock, a goTo's arrival, a call `main()` made
 * itself (`admit`), or between a goTo's legs (`route`, with the leg's `facts`). Docked, service here. Flying to
 * another counter is only for the program's own call (depth 1), or mid-route, where the goTo flies on to
 * its own destination after: inside a helper it would leave the helper at the wrong counter. Never a
 * refusal: the act that docked or arrived reports as it would, and the top-level call's `did` names
 * the resupply. The resupply's own docks and arrivals start none, and a system it flew out of to
 * no counter is not flown out of again this flight (one `stranded` line, not one per call). */
export declare const tiredCheck: (trigger: "dock" | "arrival" | "call" | "route", facts?: Record<string, unknown>) => Effect.Effect<void, never, Game | Run>;
export {};
