# FTE-082 Game State Short Probe — 2026-08-14

This is a sanitized derived-evidence summary for the required short,
low-cadence probe. It is not the full MLB lifecycle observation, not an
accuracy verdict, and not approval to begin FTE-083.

## Frozen protocol

- Stage: staging
- Started: `2026-08-14T23:14:28.900Z`
- Completed: `2026-08-14T23:29:29.888Z`
- Cadence: 5 minutes
- Ticks: 4
- Required routes per tick: aggregate, baseball, football, soccer
- Requests completed: 16 of 16
- Derived observations: 1,633
- Derived observation bytes: 1,253,377
- Evidence SHA-256:
  `62e49dcd8df09b2c5b9594b6436156fbabd35293dc9aa6825b4f50c0244fbf12`
- Identity-manifest input SHA-256:
  `3045210876e90d15124bc617ebcc3ac0aa841294232999f1ee0a47bf8d7030cd`
- Normalized identity-manifest SHA-256:
  `7e2db1d7b5308e55cfbcfad36f924357d72f7247b34ee2db5cbf073332589690`
- Truth-header SHA-256:
  `0d59bbfb1037f64a80f9370bd2fc6c596dcd56fd2b80d5348e93b3677a92de15`

The raw paid responses, credentials, request headers, provider event ids,
participant labels, and book-level data are not retained in this artifact.

## Observed route behavior

| Route | Derived rows across four ticks | Observed request latency |
| --- | ---: | ---: |
| Aggregate | 1,082 | 253–659 ms |
| Baseball | 78 | 38–54 ms |
| Football | 64 | 41–69 ms |
| Soccer | 409 | 45–562 ms |

- Every route envelope changed at every tick.
- Aggregate and sport-specific observations had zero missing, extra, semantic,
  temporal, or indeterminate disagreements across all sport comparisons.
- The maximum first-route cadence drift was approximately 1.54 ms. Later
  sequential route dispatches remained within 757 ms of the tick boundary.
- Every response carried a complete authoritative rate window. Remaining
  allowance stayed between 971 and 984 against a frozen reserve of 4.

## Identity finding

The probe rejected the assumption that Game State event ids equal schedule
event ids or UUIDs. The provider exposed bounded home/away identity fields but
no schedule UUID or scheduled-start field in the observed state rows, so the
strict schedule-id manifest mapped no rows.

A separate local, derived-only participant-orientation diagnostic found 9 of
the official 15 next-day MLB fixtures uniquely present at the end of the probe,
0 ambiguous matches, and 6 not yet present. This diagnostic retained no raw
provider labels or ids in the repository.

Consequences for the full-slate protocol:

- Freeze a new identity manifest near first pitch from independently verified,
  oriented participants; do not reuse this short-probe manifest.
- Keep the official 15-game slate as the denominator even if Game State still
  omits fixtures.
- Record missing fixtures as unresolved coverage evidence; never guess an id,
  shrink the denominator, or mint an event.

## What this probe establishes

Can trust within this short window:

- The four closed routes were entitled and returned bounded parseable data.
- Aggregate and sport route projections agreed at aligned ticks.
- Fixed-cadence execution and rate-budget controls operated as designed.

Cannot trust from this probe:

- Schedule ids as Game State ids.
- Current pregame catalogue presence as complete-slate coverage.
- Consensus as an official score or settlement authority.

Unknown until the full observation window:

- Start, break, delay, resumption, final, correction, and post-final retention
  behavior.
- Score/status/clock correctness against independent official checkpoints.
- Final revision frequency and constituent-book disagreement.

FTE-082 remains `in-progress` pending the full 15-game MLB window, independent
truth comparison, dated decision report, adversarial reviews, and approval.
