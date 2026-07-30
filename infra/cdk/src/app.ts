import { createFoundationApp } from "./foundation.js";

const stage = process.env["FTE_AWS_STAGE"] ?? "local";
const { app } = createFoundationApp({
  stage,
  ...(process.env["CDK_DEFAULT_ACCOUNT"]
    ? { account: process.env["CDK_DEFAULT_ACCOUNT"] }
    : {}),
  ...(process.env["CDK_DEFAULT_REGION"]
    ? { region: process.env["CDK_DEFAULT_REGION"] }
    : {}),
});

app.synth();
