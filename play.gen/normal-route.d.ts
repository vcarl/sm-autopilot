import type { FindRouteResponse, RouteStep } from '@spacemolt/lib';
type Loose<T> = {
    [K in keyof T]?: T[K] | undefined;
};
type Quote = Loose<Omit<FindRouteResponse, 'route'>> & {
    route?: ReadonlyArray<Loose<RouteStep>> | undefined;
};
/** Validate server route structure; each caller supplies its own admitted jump bound. */
export declare function routeSteps(route: Quote, from: string, to: string, maxJumps: number | null): string[];
export {};
