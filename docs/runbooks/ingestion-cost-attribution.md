# Ingestion cost attribution baseline

This procedure creates the evidence baseline for FTE-075. It is read-only: the
collector resolves the deployed CloudFormation stack and ingestion table, then
reads CloudWatch, DynamoDB Contributor Insights, and Cost Explorer. It does not
change the table or any monitoring configuration.

## Prerequisites

- Run after the FTE-075 metrics and Contributor Insights configuration have
  been deployed through the normal reviewed deployment path.
- Use AWS credentials for the same account as the target stage, with read
  access to CloudFormation, DynamoDB table metadata and Contributor Insights,
  CloudWatch metrics and insight reports, STS identity, and Cost Explorer.
- Select a settled, completed UTC period. `--from` is inclusive and `--to` is
  exclusive; both are `YYYY-MM-DD` UTC boundaries. Do not include the current
  UTC day. Cost Explorer data should have finished settling before capture.
- Confirm the `aws:cloudformation:stack-name` generated cost-allocation tag is
  active in the payer account. The collector uses that tag to constrain Cost
  Explorer to the same foundation stack as the resolved table; an account-wide
  DynamoDB bill is not a comparable scope and is rejected.
- The `FindTheEdge/DynamoCapacity` metrics must include the requested `Stage`
  dimension. The collector filters it exactly, alongside bounded
  operation/prefix/resource labels, without exposing a table name or full key.

## Capture

From the repository root:

```sh
pnpm ingestion-cost:baseline -- \
  --stage prod \
  --from 2026-08-01 \
  --to 2026-08-08 \
  --region us-east-1 \
  --output _bmad-output/implementation-artifacts/fte-075-ingestion-cost-baseline.json
```

The output path must not already exist. This guards a reviewed baseline against
accidental replacement. Choose a new path or deliberately remove an obsolete
artifact in a separate reviewed change.

The command exits nonzero and creates no output when the stack/table cannot be
resolved exactly, any required native/custom/Contributor Insights/billing
series is missing or empty, there is no attributable prefix capacity, or the
request-cost model differs from settled request-usage charges by more than 15%.

## Reading the artifact

- `nativeCapacity` is the authoritative CloudWatch sum of table and GSI read
  and write request units.
- `attributedCapacity.topFivePrefixes` ranks only capacity measured by the
  `FindTheEdge/DynamoCapacity` request wrapper. Total, read, and write shares
  use the corresponding native table-plus-index capacity as their denominator,
  so residual work remains visible. They are not Contributor Insights
  percentages.
- `explicitResidual` contains measured `MIXED` transactions and
  `UNATTRIBUTED` operations. The collector never allocates transaction totals
  across items.
- `unobservedResidual` is native table-plus-index capacity minus all custom
  observed capacity. It preserves failed conditions, uninstrumented callers,
  and other unknowable work instead of guessing.
- `contributorInsights.prefixAccessEvidence` is independently sanitized access
  frequency evidence. Full contributor keys are reduced to bounded prefixes in
  memory and are never written. Access counts must never be presented as
  capacity share.
- `costReconciliation` uses native table-plus-index request units and the
  recorded on-demand assumptions: USD $0.125 per million read request units and
  USD $0.625 per million write request units. It compares only matching settled
  DynamoDB read/write request usage from Cost Explorer, scoped by the exact
  foundation-stack cost-allocation tag. Every returned Cost Explorer period
  must have `Estimated=false`. Storage, backups, streams, other stacks, and
  unrelated DynamoDB charges are outside this request-unit model.

Preserve the exact window and artifact for FTE-078. Its post-change measurement
must rerun this same command and methodology so the comparison is honest.
