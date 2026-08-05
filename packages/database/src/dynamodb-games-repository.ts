import type { EventRepository } from "./event-repository";
import {
  JoinedGamesRepository,
  type CurrentOddsReadGateway,
  type GameDetailSportsbook,
} from "./games-repository";

export class DynamoGamesRepository extends JoinedGamesRepository {
  constructor(
    events: EventRepository,
    gateway: CurrentOddsReadGateway,
    detailSportsbooks?: readonly GameDetailSportsbook[],
  ) {
    super(
      events,
      gateway,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      detailSportsbooks,
    );
  }
}
