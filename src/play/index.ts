/** The root barrel: everything at every level, so `import {…} from 'play'` is the one line a
 * pilot needs. The folder barrels (`play/mining` …) exist for reading and for a narrower
 * import; they export the same functions. */
export type {Outcome,Present,Row,Status,Want} from './types.ts';
export {account,note,outcome,pilot,stopped,type Mood,type Pilot,type Stance} from './runtime.ts';
export {orient,scout,type Orientation,type ScoutReport} from './orient.ts';
export {goTo,type Trip} from './travel.ts';
export {service,type Serviced} from './service.ts';
export {storage,stow,withdraw,type Moved} from './storage.ts';
export {buy,prices,sell,type Bought,type Quote,type Sold} from './market.ts';
export {acceptMission,completeMissions,missions,type Offer} from './missions.ts';
export {buyShip,refit,shipsForSale,type Fit,type ForSale,type Purchase} from './hangar.ts';
export * from './mining/index.ts';
export * from './industry/index.ts';
export * from './hauling/index.ts';
export * from './combat/index.ts';
export * from './trading/index.ts';
export * from './exploration/index.ts';
export * from './fleet/index.ts';
