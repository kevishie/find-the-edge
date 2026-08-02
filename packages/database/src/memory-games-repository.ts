import type { EventRepository } from "./event-repository";
import {
  JoinedGamesRepository,
  type CurrentOddsReadGateway,
} from "./games-repository";

export class MemoryGamesRepository extends JoinedGamesRepository {
  constructor(events: EventRepository, gateway: CurrentOddsReadGateway) {
    super(events, gateway, ["fixture-book"]);
  }
}
