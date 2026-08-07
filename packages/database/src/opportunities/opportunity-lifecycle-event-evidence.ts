import type {
  EventStatus,
  OpportunityLifecycleEventEvidence,
} from "@find-the-edge/domain";
import { assessEventMetadata } from "@find-the-edge/domain";
import type { DynamoGateway } from "../dynamodb-event-ingestion";
import type { OpportunityLifecycleEventFence } from "./opportunity-lifecycle-repository";

export interface OpportunityLifecycleEventRead {
  readonly evidence: OpportunityLifecycleEventEvidence;
  readonly fence: OpportunityLifecycleEventFence;
}
export interface OpportunityLifecycleEventEvidenceSource {
  read(eventId: string, asOf: string): Promise<OpportunityLifecycleEventRead>;
}
const statuses = new Set<EventStatus>([
  "scheduled",
  "postponed",
  "cancelled",
  "started",
  "completed",
  "unknown",
]);

export class DynamoOpportunityLifecycleEventEvidenceSource implements OpportunityLifecycleEventEvidenceSource {
  constructor(private readonly gateway: Pick<DynamoGateway, "get">) {}
  async read(
    eventId: string,
    asOf: string,
  ): Promise<OpportunityLifecycleEventRead> {
    if (new Date(asOf).toISOString() !== asOf)
      throw new Error("opportunity-event-as-of-invalid");
    const pk = `EVENT_DETAIL#${eventId}`;
    const first = await this.gateway.get(pk, "CURRENT");
    if (!first) {
      if (await this.gateway.get(pk, "CURRENT"))
        throw new Error("opportunity-event-fence-changed");
      return {
        evidence: {
          availability: "missing",
          canonicalEventId: eventId,
          canonicalEventVersion: null,
          sportKey: null,
          status: null,
          startsAt: null,
          observedAt: null,
          identity: `${pk}#CURRENT`,
          evidenceId: `${pk}@missing@${asOf}`,
        },
        fence: { pk, sk: "CURRENT", expectedMaterialVersion: null },
      };
    }
    const pointer = first.value as Record<string, unknown> | undefined;
    const version = pointer?.["materialVersion"];
    const sportPk = pointer?.["sportPk"];
    const sportSk = pointer?.["sportSk"];
    if (
      !Number.isSafeInteger(version) ||
      (version as number) < 1 ||
      typeof sportPk !== "string" ||
      typeof sportSk !== "string"
    )
      throw new Error("opportunity-event-pointer-invalid");
    const projection = await this.gateway.get(sportPk, sportSk);
    const stable = await this.gateway.get(pk, "CURRENT");
    if (JSON.stringify(stable) !== JSON.stringify(first))
      throw new Error("opportunity-event-fence-changed");
    const value = projection?.value as Record<string, unknown> | undefined;
    if (
      !value ||
      value["eventId"] !== eventId ||
      value["materialVersion"] !== version ||
      typeof value["sportKey"] !== "string" ||
      !statuses.has(value["status"] as EventStatus) ||
      typeof value["startsAt"] !== "string" ||
      new Date(value["startsAt"]).toISOString() !== value["startsAt"] ||
      typeof value["canonicalFreshness"] !== "string" ||
      new Date(value["canonicalFreshness"]).toISOString() !==
        value["canonicalFreshness"] ||
      value["canonicalFreshness"] > asOf
    )
      throw new Error("opportunity-event-projection-invalid");
    const metadata = assessEventMetadata(
      value["status"] as EventStatus,
      value["canonicalFreshness"],
      asOf,
    );
    const terminalStatus = ["cancelled", "started", "completed"].includes(
      value["status"] as string,
    );
    if (
      !terminalStatus &&
      (metadata.availability !== "complete" ||
        metadata.freshness.state !== "current")
    )
      return {
        evidence: {
          availability: "indeterminate",
          canonicalEventId: eventId,
          canonicalEventVersion: null,
          sportKey: null,
          status: null,
          startsAt: null,
          observedAt: null,
          identity: `${pk}#CURRENT`,
          evidenceId: `${pk}@${String(version)}@indeterminate@${String(value["canonicalFreshness"])}`,
        },
        fence: {
          pk,
          sk: "CURRENT",
          expectedMaterialVersion: version as number,
        },
      };
    return {
      evidence: {
        availability: "current",
        canonicalEventId: eventId,
        canonicalEventVersion: version as number,
        sportKey: value["sportKey"],
        status: value["status"] as EventStatus,
        startsAt: value["startsAt"],
        observedAt: value["canonicalFreshness"],
        identity: `${pk}#CURRENT`,
        evidenceId: `${pk}@${String(version)}@${String(value["status"])}@${String(value["canonicalFreshness"])}`,
      },
      fence: { pk, sk: "CURRENT", expectedMaterialVersion: version as number },
    };
  }
}
