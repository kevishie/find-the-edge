import type { EventRepository } from "./event-repository";
import {
  JoinedGamesRepository,
  type CurrentOddsReadGateway,
} from "./games-repository";

export class DynamoGamesRepository extends JoinedGamesRepository {
  constructor(events: EventRepository, gateway: CurrentOddsReadGateway) {
    super(events, gateway);
  }
}
