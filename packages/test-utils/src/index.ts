export function fixedClock(isoTimestamp: string): () => Date {
  return () => new Date(isoTimestamp);
}
