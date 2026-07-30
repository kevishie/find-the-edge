export interface RuntimeConfig {
  environment: "development" | "test" | "production";
  applicationName: string;
}
