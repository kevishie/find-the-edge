import {
  App,
  BootstraplessSynthesizer,
  Stack,
  Validations,
  type StackProps,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

export interface FoundationConfig {
  stage: string;
  account?: string;
  region?: string;
}

export class FoundationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
  }
}

export function createFoundationApp(config: FoundationConfig): {
  app: App;
  stack: FoundationStack;
} {
  if (!/^[a-z][a-z0-9-]*$/.test(config.stage)) {
    throw new Error(
      "FTE_AWS_STAGE must start with a lowercase letter and contain only lowercase letters, numbers, or hyphens",
    );
  }

  const app = new App({ analyticsReporting: false });
  const environment =
    config.account && config.region
      ? { account: config.account, region: config.region }
      : undefined;
  const stack = new FoundationStack(
    app,
    `FindTheEdge-${config.stage}-Foundation`,
    {
      description:
        "Synth-only FIND THE EDGE foundation; product resources are added by later stories.",
      synthesizer: new BootstraplessSynthesizer(),
      ...(environment ? { env: environment } : {}),
    },
  );
  Validations.of(stack).acknowledge({
    id: "CloudFormation-Validate::F0001",
    reason:
      "The foundation story intentionally proves a resource-free, non-deploying CDK baseline.",
  });
  return { app, stack };
}
