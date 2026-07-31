import type { UpcomingEventIngestionOrchestrator } from "./upcoming-event-orchestrator";
export const createManualHandler =
  (orchestrator: UpcomingEventIngestionOrchestrator) => (input: unknown) =>
    orchestrator.execute(input);
