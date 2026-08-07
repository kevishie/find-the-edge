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
      detailSportsbooks?.map(({ id }) => id),
      undefined,
      undefined,
      undefined,
      undefined,
      detailSportsbooks,
    );
  }
}
