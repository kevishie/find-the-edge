import type { EventRepository } from "./event-repository";
import {
  JoinedGamesRepository,
  type CurrentOddsReadGateway,
} from "./games-repository";

export class MemoryGamesRepository extends JoinedGamesRepository {
  constructor(
    events: EventRepository,
    gateway: CurrentOddsReadGateway,
    sportsbookIds: readonly string[] = ["fixture-book"],
    now: () => Date = () => new Date(),
  ) {
    super(events, gateway, sportsbookIds, now);
  }
}
