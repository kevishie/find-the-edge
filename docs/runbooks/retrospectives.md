# Retrospectives

Retrospectives are immutable review artifacts built after a completed performance report. Each version binds an exact cohort, report revision, evidence cutoff, and separate decision-time and post-decision evidence digests. They never promote a strategy or execute a candidate.

## Bounded rebuild

1. Start from an exact `performance-report:*` ID and its bound `cohort:*` ID. Do not use a current pointer as evidence.
2. Query the frozen cohort members and resolve the exact evaluation, grade, result, opening price, and eligible closing price IDs. Stop if an ID, cutoff, or digest disagrees.
3. Invoke the scheduled performance worker or `RetrospectiveBuilder` with the exact completed report. A retry returns the existing version. A corrected report creates vN+1 linked to the current predecessor.
4. Never widen the cohort to reconstruct non-plays. False-negative review remains `not-evaluable` until a frozen non-play universe exists.

Regular reads query `RETROSPECTIVES` or `RETROSPECTIVE#<id>` partitions. Scans are prohibited. Cursors are signed and bound to the list scope.

## Review and rollback

Only a JWT from the dedicated reviewer client carrying `events/retrospectives:approve` and membership in `fte-retrospective-reviewers` may submit a review. The ordinary web client cannot request approval scope. The server supplies reviewer identity and time. Requests must include an idempotency key, expected `draft` state, expected state version, and a bounded reason-coded body. Stale or conflicting requests return conflict without partial state, candidate, or audit updates.

Approval accepts a non-executable candidate for later experiment design. It does not change prompts, data configuration, strategy state, schedules, money mode, or deployments. There is therefore no runtime rollback. To correct evidence or request changes, preserve the prior version and create a linked revision from a new immutable performance report.

## Retention and monitoring

The DynamoDB table uses point-in-time recovery and retain-on-delete. Retrospective rows have no TTL. Monitor `RetrospectiveFailures`, `RetrospectiveValidationFailures`, `RetrospectiveLatency`, `RetrospectiveReplays`, build/member/candidate counts, review success/conflict/forbidden counts, and route-specific API 5xx alarms. Conflict/forbidden alarms use only the fixed review-route dimension; no reviewer or retrospective IDs become metric dimensions. Logs may contain safe counts and version IDs, never notes, reviewer subjects, prompts, licensed evidence, or raw provider data.
