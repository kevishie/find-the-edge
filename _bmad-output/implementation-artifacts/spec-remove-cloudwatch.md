---
title: 'Constrain CloudWatch to free-tier critical alarms'
type: 'chore'
created: '2026-08-16'
status: 'done'
review_loop_iteration: 0
baseline_commit: '9ab90e4985d38b58e3c46f0f835a805d69dc274a'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** FIND THE EDGE previously provisioned 101 noisy CloudWatch alarms plus logs and custom metrics, causing alert flapping and material spend. Removing all monitoring would also eliminate inexpensive detection of failures on the ingestion paths that matter most.

**Approach:** Keep the completed removal of CloudWatch Logs, custom metrics, Contributor Insights, and noncritical alarms, then provision only eight account-wide standard alarm metrics across the two deployed stacks: four in staging and four in production. Use free AWS/Lambda and AWS/SQS service metrics, sustained-failure thresholds, and ALARM-only email actions.

## Boundaries & Constraints

**Always:** Keep total repository-owned alarm metrics at eight across the known staging and production stacks, leaving two of the current ten-metric CloudWatch free-tier allowance unused. Staging monitors Live Odds errors/DLQ and Provider Landing errors/DLQ; production monitors Live Odds errors/DLQ and Upcoming Events worker errors/DLQ. Every alarm directly references one standard AWS service metric, uses a five-minute period, requires two breaching datapoints out of three, treats missing data as non-breaching, and sends notifications only when entering `ALARM`. Keep alarm email configuration optional and validated. Preserve the zero-log, zero-custom-metric implementation and all application behavior.

**Ask First:** Adding any ninth repository-owned alarm metric, enabling CloudWatch Logs or custom metrics, monitoring a new stage/region/account, changing the critical-path selection, or deleting/changing DynamoDB and unrelated AWS resources.

**Never:** Add OK/recovery notifications, metric math, high-resolution alarms, dashboards, Logs Insights, Contributor Insights, EMF, CloudWatch log delivery permissions, or broad `cloudwatch:*`/`logs:*` deployment permissions. Never claim the account is free if unrelated account usage consumes the shared allowance.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Staging synth | `stage=staging` | Exactly four direct alarms for Live Odds and Provider Landing errors/DLQs | Synthesis test fails on extra/nonstandard alarms |
| Production synth | `stage=prod` | Exactly four direct alarms for Live Odds and Upcoming Events errors/DLQs | Synthesis test fails on extra/nonstandard alarms |
| Other-stage synth | Local or legacy development | No alarms | Synthesis test fails if an unbudgeted stage adds alarms |
| Transient failure | One breaching five-minute period | No alert or recovery email | Missing data is non-breaching |
| Sustained failure | Two of three periods breach | One ALARM transition notification when configured | No OK action is attached |

</frozen-after-approval>

## Code Map

- `infra/cdk/src/foundation.ts` -- defines ingestion workers/queues and the capped stage-specific alarm set.
- `infra/cdk/src/foundation.test.ts` -- synthesis guards for alarm count, metric namespaces, tuning, actions, and continued absence of logs/custom metrics.
- `infra/cdk/src/app.ts` and `.github/workflows/deploy-phase1.yml` -- validate and pass the optional critical alarm email.
- `infra/github-actions-deploy-role.yml` -- grants only CloudWatch alarm lifecycle actions required by CloudFormation.
- `scripts/phase1-launch.mjs` -- permits only the two exact legacy retained-log removals and legacy API access-log drift needed to unblock this migration.
- `docs/cloudwatch-shutdown.md` -- operational migration and shared free-tier budget caveat.

## Tasks & Acceptance

**Execution:**
- [x] `infra/cdk/src/foundation.ts` -- add the eight-account-wide-budget stage-specific standard alarm design and ALARM-only notification topic.
- [x] `infra/cdk/src/foundation.test.ts` -- prove staging/prod each synthesize four permitted alarms, other stages synthesize none, and logs/custom telemetry remain absent.
- [x] `infra/cdk/src/app.ts`, `.github/workflows/deploy-phase1.yml`, and `infra/github-actions-deploy-role.yml` -- restore only validated critical-email input and least-privilege alarm deployment actions.
- [x] `scripts/phase1-launch.mjs` and tests -- preserve fail-closed retained-resource/drift guards while allowing only the exact legacy log cleanup required by this migration.
- [x] `docs/cloudwatch-shutdown.md` and active deployment docs -- document the exact alarm budget, tuning, shared-account caveat, and retained-log cleanup.

**Acceptance Criteria:**
- Given staging and production templates together, when synthesized, then they contain eight direct standard-resolution alarm metrics, no OK actions, and no alarms in other stages.
- Given repository infrastructure and runtime source, when inspected, then it contains no CloudWatch Logs resources/destinations/permissions, EMF envelopes, custom CloudWatch metrics, Contributor Insights, or broad CloudWatch/Logs IAM grants.
- Given focused and workspace checks, when run, then infrastructure, deployment, API, worker, build, and browser behavior passes unchanged.

## Spec Change Log

- 2026-08-16 human renegotiation: replaced the zero-CloudWatch goal with eight direct critical-path alarm metrics across staging and production. Kept all completed log/custom-metric removal and avoided restoring the known-bad 101-alarm, recovery-email configuration.
- 2026-08-16 review patch: added narrowly scoped retained-log and legacy API-stage drift allowances, exact alarm-to-resource assertions, SNS confirmation guidance, and legacy development-stack inventory. Preserved all unrelated retained-resource and drift failures.

## Design Notes

The eight-alarm budget is account-aware: each deployed stack owns four alarms, not eight. Existing logical IDs are reused where possible so deployment updates the selected alarms and deletes the rest. AWS free-tier allowances are shared with unrelated account usage, so repository synthesis can enforce its own contribution but cannot guarantee the final bill independently.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/infra-cdk test` -- exact alarm-budget and zero-log synthesis assertions pass.
- `pnpm check` -- all workspace quality gates pass.
- `rg -n 'CloudWatchMetrics|AWS::Logs|cloudwatch:\*|logs:\*|AWSLambdaBasicExecutionRole' infra apps scripts .github` -- no prohibited integration remains outside negative tests.
- `git diff --check` -- patch has no whitespace errors.

## Suggested Review Order

**Critical monitoring budget**

- Defines the four-per-stage, eight-account-wide alarm boundary and sustained-failure tuning.
  [`foundation.ts:1765`](../../infra/cdk/src/foundation.ts#L1765)

- Proves each alarm targets its exact Lambda or queue with no recovery action.
  [`foundation.test.ts:38`](../../infra/cdk/src/foundation.test.ts#L38)

**Cost-producing telemetry removal**

- Custom Lambda roles deliberately omit automatic CloudWatch Logs delivery permissions.
  [`foundation.ts:156`](../../infra/cdk/src/foundation.ts#L156)

- API observations remain bounded structured data without embedded metric envelopes.
  [`handler.ts:1701`](../../apps/api/src/handler.ts#L1701)

- Worker metric adapters remain inert while preserving business execution paths.
  [`provider-landing-lambda.ts:55`](../../apps/workers/src/provider-landing-lambda.ts#L55)

**Safe migration**

- Allows removal of only the two exact legacy retained log groups.
  [`phase1-launch.mjs:43`](../../scripts/phase1-launch.mjs#L43)

- Permits only the known pre-migration API access-log drift shape.
  [`phase1-launch.mjs:1055`](../../scripts/phase1-launch.mjs#L1055)

**Deployment and operations**

- Grants CloudFormation only alarm lifecycle permissions, never broad CloudWatch or Logs access.
  [`github-actions-deploy-role.yml:37`](../../infra/github-actions-deploy-role.yml#L37)

- Documents SNS confirmation, legacy-stack inventory, and exact retained-log cleanup.
  [`cloudwatch-shutdown.md:1`](../../docs/cloudwatch-shutdown.md#L1)
