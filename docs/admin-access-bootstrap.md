# Admin access bootstrap

Admin access is disabled by default. Choose exactly one ceremony before enabling
the routes; the configuration rejects ambiguous or incomplete combinations.

## Fresh, empty environment

1. Compute the expected account ID for the owner's normalized phone number using
   the same account pepper used by the identity runtime.
2. Set `FTE_ADMIN_ACCESS_ENABLED=true`, `FTE_OWNER_ACCOUNT_ID` to that exact ID,
   and `FTE_ADMIN_FRESH_BOOTSTRAP=true`. Leave
   `FTE_ADMIN_BOOTSTRAP_VERIFIED` unset or `false`.
   In the protected deployment workflow, select `fresh`; preflight translates
   that explicit choice into these CDK inputs and the runtime receives
   `FTE_ADMIN_BOOTSTRAP_MODE=fresh`.
3. Deploy through the normal reviewed release process, then have only the owner
   complete a verified login. That login atomically creates the identity account,
   owner singleton, super-admin authorization, directory and account mapping, and
   one immutable bootstrap audit event.
4. Verify that aggregate before the next release. Replace the fresh-bootstrap
   fence with `FTE_ADMIN_BOOTSTRAP_VERIFIED=true` only after verification.

No runtime scan chooses the owner, and a non-owner cannot create the first account
while fresh bootstrap is armed.

## Environment with existing accounts

Do not use `FTE_ADMIN_FRESH_BOOTSTRAP`. Keep admin access disabled, run the
reviewed offline migration or recovery command in dry-run mode, inspect its exact
transaction, then apply it using the command's explicit confirmation controls.
After independently verifying the stored owner aggregate, set
`FTE_ADMIN_BOOTSTRAP_VERIFIED=true` and enable admin access in a later reviewed
release. In the protected deployment workflow, select `verified` and provide
the exact owner account ID. A verified-mode runtime refuses login if the owner,
authorization, directory, mapping, or bound audit evidence is incomplete; it
never performs bootstrap.

The offline provisioner requires an exact AWS account, region, stage, stack,
and table plus a stable change ID and canonical occurrence timestamp. Its dry
run binds those resources with AWS read calls and prints the complete redacted
DynamoDB transaction. Apply additionally requires the mode-specific confirmation.
Recovery uses the change ID as durable idempotency evidence and atomically
removes `super-admin` from the previous owner while preserving every unrelated
reviewer or promoter role on both accounts.

Migration, recovery, deployment, and changing deployed-stage feature flags are
operator actions; application startup never performs them automatically.
