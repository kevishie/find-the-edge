import type { PerformanceMetricSink } from "./cohort-builder.js";

export class EmfPerformanceMetricSink implements PerformanceMetricSink {
  constructor(private readonly write: (value: string) => void = console.log) {}
  emit(metric: Readonly<Record<string, string | number>>) {
    const numeric = Object.fromEntries(
      Object.entries(metric).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    );
    const dimensions = Object.fromEntries(
      Object.entries(metric).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    this.write(
      JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: "FindTheEdge/Performance",
              Dimensions: [Object.keys(dimensions)],
              Metrics: Object.keys(numeric).map((Name) => ({
                Name,
                Unit: Name.endsWith("Latency") ? "Milliseconds" : "Count",
              })),
            },
          ],
        },
        ...dimensions,
        ...numeric,
      }),
    );
  }
}
