// The Effect-native `play`: what a pilot script imports. Every function is an Effect that needs `Game`.
export {
  Game, orient, scout, goTo, mine, sell, service, prices, readMarket, salvage, hunt, disengage,
  missions, acceptMission, completeMissions, note,
  InBattle, NotDocked, HoldFull, NoWreck, UnknownPlace, NoFuel, ServerBusy, NotAtBelt, NoBuyer,
  NothingHere, HullCritical, NoSlots, UnknownMission, NothingCompletable,
  Present, MarketRow, MarketBook, RowSchema,
} from './core.ts';
export type {GameError, Row, Mission, Quote, Scouted, Arrived, Sold, Salvaged, Hunted, Completed} from './core.ts';
