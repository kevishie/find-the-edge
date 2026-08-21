# Identity authorization provisioning

Use the protected **Provision identity authorization** GitHub workflow to set the two server-owned elevated roles. It is the only supported write path. There is no public role-write endpoint, and operators do not edit DynamoDB directly.

## Safety model

- Dispatch `main` only for staging and `production` only for production. The workflow maps the branch to the matching GitHub Environment, CloudFormation stack, table, and dedicated OIDC operator role.
- Account ids are environment-specific peppered digests. Sign in to each environment independently and obtain its `account:<64 lowercase hex>` value from that owned session's capabilities response. Never enter a phone number or session token in GitHub.
- Desired state is complete, not incremental: `none`, `retrospective-reviewer`, `strategy-promoter`, or `both`. `none` revokes elevated authority without deleting its current record or history.
- Dry-run strongly reads only `ACCOUNT#<accountId>/RECORD` and `/AUTHORIZATION`. Apply adds one transaction containing the account fence, conditional current record, and an immutable audit row. It then strongly reads the exact current and audit keys back.
- Every update is optimistic. Apply needs the exact current `updatedAt`, or `absent` for first creation. A stale value fails without a partial write.
- Workflow output contains a short account digest, role names, timestamps, GitHub actor/run handles, and release SHA. It never prints a phone, token, secret, raw row, or raw AWS error.

## One-time preparation

Redeploy `infra/github-actions-deploy-role.yml` from the authorized AWS account in `us-east-1`. The stack adds separate staging and production authorization-operator roles. Record the `StagingAuthorizationOperatorRoleArn` and `ProductionAuthorizationOperatorRoleArn` outputs.

Set `AUTHORIZATION_OPERATOR_ROLE_ARN` in each GitHub Environment to its matching output. Keep the existing environment branch restrictions: `staging` accepts only `main`, and `production` accepts only `production`.

The operator roles permit only caller verification, bounded CloudFormation/table discovery, and `GetItem` plus `TransactWriteItems` on the matching stage table with `ACCOUNT#*` leading keys. They cannot Scan, Query, read Secrets Manager, or use the deployment role.

## Staging procedure

1. Confirm the owned-session role/capability release is deployed and healthy on staging.
2. Sign in at staging with the target owned account. Read the account id from `GET /auth/session/capabilities`; keep the bearer token in the browser and out of GitHub.
3. Dispatch **Provision identity authorization** from `main` with `mode=dry-run`, the complete desired state, that staging account id, `expected_updated_at=absent`, and an empty confirmation. Dry-run ignores the optimistic marker for mutation purposes and reports the actual current roles and timestamp without writing.
4. Review the bounded plan. Dispatch again from the same latest `main` revision with `mode=apply`, the same account and desired state, the reported `updatedAt` or `absent`, and confirmation `SET-ROLES`.
5. Require an `applied` or intentional `no-op` result. An applied result includes the new timestamp and immutable audit key after exact strong readback.
6. In the already signed-in staging browser, call `GET /auth/session/capabilities` again. Confirm the canonical capabilities match the desired roles:
   - `retrospective-reviewer` → `events/retrospectives:approve`
   - `strategy-promoter` → `events/strategies:promote`

Provisioning does not detach Cognito from elevated mutation routes. That cutover remains a later, separately verified FTE-074 step.

## Production procedure

Promote and verify the exact release in production first. Obtain the production account id from a separate production owned session; the staging id is not reusable. Repeat dry-run, apply, storage readback, and browser capability verification from the `production` branch and GitHub Environment.

Do not copy a staging account id, timestamp, operator-role ARN, or workflow run into production. A target, branch, stack, table, or expected-state mismatch fails closed.

## Recovery and rollback

- A conditional conflict means state changed after the plan. Run a fresh dry-run; never guess or bypass the expected timestamp.
- A malformed account, authorization, target, or readback failure is not authority to overwrite storage. Preserve the workflow run and investigate the exact key with a separately reviewed recovery plan.
- To revoke or roll back, run a new dry-run and apply the prior complete role set (or `none`) using the latest `updatedAt`. This appends a new audit; it never edits or deletes history.
- Do not supply an owned token to the workflow or run the provisioner with the broad deployment role as a production shortcut.
