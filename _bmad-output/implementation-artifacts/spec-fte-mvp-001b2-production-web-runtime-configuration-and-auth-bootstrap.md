---
title: 'FTE-MVP-001B2 Production Web Runtime Configuration and Auth Bootstrap'
type: 'feature'
created: '2026-08-01'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'e6069f9'
final_revision: '46a764b'
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** The static web build has no production artifact that supplies the deployed API base or connects an external identity/session shell to an async access-token provider. C cannot safely construct its client or display configuration/auth failures.

**Approach:** Add a hosting-neutral runtime-config artifact contract, generation/validation command, and browser bootstrap that resolves a named async token provider from an injected registry. Expose bounded, abortable token acquisition with redacted typed failures; add no games UI.

## Boundaries & Constraints

**Always:** Runtime artifact contains only schema version, validated absolute HTTPS API base (localhost HTTP allowed only in explicit development/test mode), and a bounded provider key; it never contains a token, secret, issuer credential, or executable user content. Production `index.html` loads the external runtime artifact before the module entry. A build/deploy command generates the artifact from explicit environment inputs using atomic output and validates exact keys/escaping; missing/invalid inputs fail the command. Browser bootstrap validates exact plain data, resolves `window` provider registry by own data property, requires a function, and returns a typed configuration result rather than throwing before React. Token acquisition is async, races an AbortSignal plus bounded timeout, trims/rejects empty/oversized tokens, and maps provider details to redacted typed categories without logging. The checked-in development placeholder contains no usable API or token and fails visibly when consumed.

**Block If:** A hosting-neutral static artifact cannot connect to a real external session provider without choosing a specific auth SDK; stop at the named provider-registry contract and document the host obligation.

**Never:** Add login UI/auth SDK, static bearer tokens, `VITE_*` secrets, `local-e2e-token` fallback, games UI/API calls, backend/CDK resources, eval/dynamic code strings, provider error text in user messages, indefinite token waits, or serve-only injection as the production mechanism.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Generate | Valid prod API base/provider key/output | Exact non-secret JS artifact | Atomic success |
| Invalid artifact | Missing/extra keys, unsafe URL/key/prototype/accessor | No bootstrap client | Typed config error |
| Provider | Registered async provider returns token | Trimmed bounded token | Success |
| Provider failure | Missing/reject/throw/empty/oversize/timeout/abort | No secret/detail leak | Typed redacted error |
| Placeholder | Default static build not configured | App can render configuration error | Never blank crash |

</intent-contract>

## Code Map

- `apps/web/src/runtime-config.ts` -- exact runtime types/bootstrap/provider lookup/token timeout/redaction.
- `apps/web/public/runtime-config.js`, `index.html` -- non-secret placeholder and pre-module load.
- `scripts/generate-web-runtime-config.mjs` -- atomic deploy artifact generator/validator.
- `apps/web/src/runtime-config.test.ts`, script tests -- browser/config/security/boundary coverage.
- package scripts/docs if needed -- explicit generation command and host provider obligation.

## Tasks & Acceptance

**Execution:**
- [x] runtime bootstrap -- implement exact nonthrowing config/provider resolution and bounded redacted token acquisition.
- [x] static artifact/generator -- load a safe placeholder in production HTML and generate validated atomic deployment artifact from explicit inputs.
- [x] tests/docs -- cover malformed/prototype/accessor/URL/key/provider/timeout/abort/token bounds and artifact escaping/atomic failure; document host registry contract.

**Acceptance Criteria:**
- Given a generated artifact and registered provider, when bootstrap/token acquisition runs, then a validated API base and token are returned without embedding credentials.
- Given any malformed config/provider failure, when consumed, then a typed redacted error is returned and no synchronous pre-render throw or indefinite loading occurs.
- Given a production build, when inspected, then `runtime-config.js` loads before main and contains no token/fallback secret.
- Given full gates, then no games UI, backend/CDK, auth SDK, or serve-only production mechanism enters this slice.

## Spec Change Log

## Review Triage Log

- Patch 3: no bad-spec or intent findings. Patched M2: reject embedded C0/DEL/ASCII URL whitespace consistently in browser and generator; make generated artifact mode deterministically public-readable (`0644`) for initial and replacement writes. Patched L1: document that the production web build creates `dist` before generation.
- Deferred L4 host obligations: a hostile/non-cooperative provider can still perform late side effects after timeout because the hosting provider owns cancellation behavior; deployment must serialize concurrent generators for one output; deployment must define whether symlink output paths are permitted. These are hosting policy obligations and do not expand this hosting-neutral bootstrap slice.

## Verification

Implementation facts: hosting-neutral runtime data and named provider registry only; no auth SDK, token, games UI, API/backend, or CDK changes. The placeholder is deliberately unusable and the host obligation is documented in `../../docs/web-runtime-configuration.md`.

**Commands:**
- `pnpm --filter @find-the-edge/web test` -- bootstrap/provider tests pass.
- `node --test scripts/generate-web-runtime-config.test.mjs` -- generator tests pass.
- `pnpm check` -- workspace gates and production web build pass.
