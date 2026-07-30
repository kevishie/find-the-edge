export interface RepositoryPort<Entity> {
  get(id: string): Promise<Entity | null>;
  put(entity: Entity): Promise<void>;
}
