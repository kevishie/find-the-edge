import type { EventRepository } from "./event-repository";
import {
  JoinedGamesRepository,
  type CurrentOddsReadGateway,
  type GameDetailSportsbook,
} from "./games-repository";

export class MemoryGamesRepository extends JoinedGamesRepository {
  constructor(
    events: EventRepository,
    gateway: CurrentOddsReadGateway,
    sportsbookIds: readonly string[] = ["fixture-book"],
    now: () => Date = () => new Date(),
    detailSportsbooks?: readonly GameDetailSportsbook[],
  ) {
    super(
      events,
      gateway,
      sportsbookIds,
      now,
      undefined,
      detailSportsbooks?.[0]?.id ?? sportsbookIds[0] ?? "fixture-book",
      undefined,
      detailSportsbooks,
    );
  }
}
