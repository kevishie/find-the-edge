export interface RepositoryPort<Entity> {
  get(id: string): Promise<Entity | null>;
  put(entity: Entity): Promise<void>;
}
export * from "./event-ingestion";
export * from "./memory-event-ingestion";
export * from "./dynamodb-event-ingestion";
export * from "./aws-dynamo-gateway";
export * from "./event-errors";
export * from "./event-read-projection";
export * from "./event-repository";
export * from "./dynamodb-event-repository";
export * from "./memory-event-repository";
