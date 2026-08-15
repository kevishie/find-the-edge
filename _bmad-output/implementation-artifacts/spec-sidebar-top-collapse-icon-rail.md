---
title: 'Top sidebar collapse control and compact icon rail'
type: 'feature'
created: '2026-08-14'
status: 'done'
review_loop_iteration: 0
baseline_commit: '269478994a644b7245484fc23f643dd45777de56'
context:
  - '{project-root}/_bmad-output/planning-artifacts/ux-design-specification.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The desktop sidebar currently exposes collapse/expand as a labeled button in the footer, while the supplied design places a compact circular chevron control at the upper sidebar boundary. The existing collapsed rail is functional but does not match the reference's centered crown, divided navigation stack, active icon tile, and clean footer treatment.

**Approach:** Preserve the existing navigation routes, 244px expanded width, 68px collapsed width, persistence behavior, mobile navigation behavior, and accessible labels. Move the same collapse action to a circular control attached to the top/right sidebar edge, restyle the collapsed navigation as the supplied icon rail, and store the downloaded full-app HTML as a versioned design reference under `templates/`.

## Boundaries & Constraints

**Always:** Keep the current route set and route order (Events, Splits, Watchlist, Scanner); use the existing route-appropriate glyphs; keep the active route visually distinct with both a purple left rail and tinted tile; retain keyboard operation, focus visibility, tooltip/title text, screen-reader names, `aria-pressed`, and `fte.navCollapsed` persistence; keep the desktop shell widths and the existing mobile breakpoint behavior; preserve the crown-only brand in collapsed mode.

**Ask First:** Adding routes or placeholder icons not backed by current product screens; changing desktop sidebar widths, mobile bottom navigation, session/sign-out behavior, or global brand artwork; deleting or replacing an existing template with the imported reference.

**Never:** Ship the prototype-only Design navigation group; render inaccessible icon-only controls; move the toggle back into the footer; remove the original downloaded file until the versioned project copy has been verified; alter unrelated product screens or backend code.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Expanded desktop | Shell opens with no saved collapsed preference | Full brand and labeled navigation render; circular left-pointing control sits at the upper sidebar boundary | If storage is unavailable, interaction still works for the current session |
| Collapsed desktop | User activates the collapse control | Sidebar becomes a 68px icon rail; crown, divider, centered route icons, active tile/rail, session status, and right-pointing expand control remain visible | Accessible labels and titles expose each icon's meaning |
| Persisted preference | `fte.navCollapsed` is `1` on load | Shell initializes directly in compact mode without changing route content | Invalid/unavailable storage falls back to expanded mode |
| Mobile viewport | Viewport is at or below the existing breakpoint | Existing compact mobile navigation owns route switching; desktop rail and collapse control remain hidden | No horizontal overflow is introduced by the off-edge control |

</frozen-after-approval>

## Code Map

- `templates/Find The Edge - Full App.html` -- Versioned copy of the supplied full-app visual reference.
- `apps/web/src/App.tsx` -- Desktop shell markup, route links, persisted collapsed state, and accessible collapse control.
- `apps/web/src/styles.css` -- Expanded/collapsed sidebar geometry, icon tile styling, boundary-positioned toggle, responsive behavior, and focus/motion rules.
- `apps/web/src/App.test.tsx` -- Shell navigation behavior and accessibility regression coverage.

## Tasks & Acceptance

**Execution:**
- [x] `templates/Find The Edge - Full App.html` -- move the supplied downloaded prototype into the project with a stable filename and verify the copy before removing the source.
- [x] `apps/web/src/App.tsx` -- place the existing collapse action alongside the brand at the sidebar boundary and keep route icons/labels semantic in both states.
- [x] `apps/web/src/styles.css` -- reproduce the reference's circular top control and collapsed icon rail while retaining current shell dimensions and responsive behavior.
- [x] `apps/web/src/App.test.tsx` -- cover toggle location/labels, expanded-to-collapsed state, icon-only accessible names, persistence, and mobile hiding.

**Acceptance Criteria:**
- Given an authenticated desktop product route, when the shell is expanded, then the collapse control appears at the top/right sidebar boundary and no collapse control remains in the footer.
- Given the shell is collapsed, when navigation is inspected visually or by assistive technology, then each current route is a centered icon with an accessible name and the active route has a purple rail plus tinted rounded tile.
- Given collapse state changes, when the app reloads, then the prior state is restored from `fte.navCollapsed` without changing the active route.
- Given a viewport at the existing mobile breakpoint, when the shell renders, then desktop navigation and its boundary toggle are hidden and the existing mobile navigation remains available.
- Given reduced motion is requested, when the sidebar state changes, then the layout does not animate.

## Spec Change Log

## Design Notes

The screenshots are treated as the visual source of truth for placement and hierarchy: full lockup in expanded mode, crown centered in compact mode, a thin divider below the brand, an overlap-style circular chevron at the sidebar/content boundary, muted inactive glyphs, and a purple active tile with a left accent. Only the four routes currently advertised by the production shell are rendered; the longer prototype menu is not reintroduced.

The imported reference was copied byte-for-byte before the Downloads source was removed. SHA-256: `719afcfcda9c6095934f86af0ed31d8797571dbd1bdae00f34bd025f7f8339ad`. It is an executable generated prototype and is covered by `templates/README.md`; it must remain a design reference rather than an application dependency.

## Verification

**Commands:**
- `pnpm --filter @find-the-edge/web test -- App.test.tsx` -- expected: shell navigation tests pass.
- `pnpm --filter @find-the-edge/web typecheck` -- expected: no TypeScript errors.
- `pnpm --filter @find-the-edge/web lint` -- expected: no lint errors.

**Manual checks (if no CLI):**
- Compare expanded and collapsed desktop states with both supplied screenshots at the same visual scale; confirm control placement, active tile, icon alignment, footer/session separation, and absence of horizontal clipping.

**Results (2026-08-14):** 439 web tests passed; web type checking and lint completed without errors. Expanded and collapsed states were visually inspected at 1440x900. The corrected compact rail kept the 68px boundary control centered on the sidebar edge, contained the sign-out control within 47.5px, and introduced no body overflow. At 768x900 the desktop control was hidden, the sidebar occupied one 768px column, and body scroll width remained 768px.

## Suggested Review Order

**Shell interaction**

- Start with the stateful shell, accessible route labels, and boundary control.
  [`App.tsx:1050`](../../apps/web/src/App.tsx#L1050)

- Inspect the deterministic SVG chevrons and shell-level control placement.
  [`App.tsx:1171`](../../apps/web/src/App.tsx#L1171)

**Compact geometry**

- Verify the 244px/68px grid, clipped sidebar, and independently scrolling links.
  [`styles.css:1012`](../../apps/web/src/styles.css#L1012)

- Confirm the fixed control follows both sidebar widths without exposing overflow.
  [`styles.css:1156`](../../apps/web/src/styles.css#L1156)

- Check the compact session controls remain contained and keyboard accessible.
  [`styles.css:6847`](../../apps/web/src/styles.css#L6847)

**Regression coverage**

- Review collapse persistence, active route, hidden labels, and top-edge placement assertions.
  [`App.test.tsx:1921`](../../apps/web/src/App.test.tsx#L1921)

- Review graceful behavior when navigation preference storage is unavailable.
  [`App.test.tsx:1976`](../../apps/web/src/App.test.tsx#L1976)

**Reference safety**

- Keep executable prototype files isolated from production application code.
  [`README.md:1`](../../templates/README.md#L1)

- Use the imported full-app prototype only as a visual reference.
  [`Find The Edge - Full App.html:1`](../../templates/Find%20The%20Edge%20-%20Full%20App.html#L1)
