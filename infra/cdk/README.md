# CDK Foundation

This package synthesizes an environment-aware empty foundation stack. It creates no AWS resources, reads no credentials for local synthesis, and has no deploy script.

```sh
pnpm --filter @find-the-edge/infra-cdk synth
```

`FTE_AWS_STAGE` defaults to `local`. When CDK supplies an account and region they are attached to the stack environment; neither value is committed.
