---
title: "FTE-074: Experiment Detail Error State"
type: "bugfix"
created: "2026-08-14"
status: "done"
baseline_revision: "22aa8d7c983c82ddb88e142152b08a3937d9b7a2"
---

## Intent

The live staging experiment-detail route remains on its loading state when the
experiment id is invalid or the detail request rejects. Render a bounded error
state instead, while preserving cancellation, session authority, immutable
evidence, and all mutation controls.

## Acceptance criteria

- A rejected, unavailable, or invalid experiment-detail request leaves the
  loading state and renders a stable alert.
- A canceled or replaced request produces no late error or data write.
- Detail state is owned by the exact client and route id so a previous
  experiment cannot flash after navigation.
- Capability and mutation authorization behavior is unchanged.
- Focused web tests, typecheck, lint, formatting, and diff checks pass.

## Scope

- `apps/web/src/experiments.tsx`
- `apps/web/src/App.test.tsx`
- this focused implementation record

No API, infrastructure, provider, billing, product-access, Cognito, or
production-data change is permitted.

## Verification

- Full web suite: 10 files, 437 tests passed.
- Web typecheck and lint passed.
- Focused formatting and `git diff --check` passed.
- Live failure reproduced before the fix: `/experiments/probe` logged an
  invalid-id client error while remaining on the loading state.
