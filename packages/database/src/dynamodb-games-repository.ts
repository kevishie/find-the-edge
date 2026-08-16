import type { EventRepository } from "./event-repository";
import {
  JoinedGamesRepository,
  type CurrentOddsReadGateway,
  type GameDetailSportsbook,
} from "./games-repository";
import type { ClosingLinesRepository } from "./closing-lines-repository";

export class DynamoGamesRepository extends JoinedGamesRepository {
  constructor(
    events: EventRepository,
    gateway: CurrentOddsReadGateway,
    detailSportsbooks?: readonly GameDetailSportsbook[],
    closingLines?: Pick<ClosingLinesRepository, "listFinalized">,
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
      closingLines,
    );
  }
}
