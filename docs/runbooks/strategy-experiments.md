# Strategy experiments and promotion

Walk-forward experiments compare immutable deployed baseline and challenger artifacts over exact chronological train, tune, and holdout windows. They grade only real shadow decisions bound to authoritative result evidence. They never create a wager, train a model, or activate a strategy automatically.

## Promotion procedure

1. Confirm the train, tune, and holdout half-open windows are chronological and their event/member manifests do not overlap.
2. Confirm baseline and challenger reports use the identical holdout event universe and result-evidence manifest.
3. Review every configured sample, ROI/interval, CLV, calibration, drawdown, and baseline-regression gate. Missing metrics fail closed.
4. Confirm the challenger artifact digest and deployed revision in the registry.
5. Using the dedicated `strategy-promoters` identity, approve the exact experiment digest and state version with a reason and unique idempotency key.
6. Append a future-effective activation. Existing paper-run manifests remain unchanged.

## Rollback

Rollback is another append-only activation targeting a previously approved, still-deployed artifact. Supply the current activation ID as the optimistic concurrency check. Set the effective time in the future. Never edit an earlier activation, experiment, decision, evaluation, or run.

## Recovery and investigation

- A failed leakage or evidence-lineage result is retained. Correct source evidence or create new non-overlapping windows; do not delete the failure.
- A stale state/digest or activation conflict means another reviewer acted first. Reload immutable history and deliberately retry with a new idempotency key.
- An unavailable metric is not zero. Repair the authoritative performance report and create a new experiment.
- An unknown artifact version blocks scheduling. Confirm the deployed registry contains the exact version and digest; do not substitute the newest version.
- Search safe metrics by `success`, `failed`, `leakage`, `gate-failed`, approval conflict, activation conflict, and unknown artifact. Logs must contain IDs/counts only—never JWT subjects, prompts, licensed payloads, or evidence bodies.

## Historical guarantees

Evidence-use lineage, failed challengers, approvals, activations, rollbacks, and every baseline remain immutable. An activation only affects paper runs scheduled at or after its effective instant; earlier run manifests continue to identify their original strategy version.
