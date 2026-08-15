---
title: 'Add application favicon'
type: 'chore'
created: '2026-08-14'
status: 'done'
route: 'one-shot'
---

# Add application favicon

## Intent

**Problem:** The web app does not declare or ship a branded browser favicon.

**Approach:** Convert the approved Claude Design SVG into a multi-resolution ICO, publish it with the web app, and reference it through Vite's deployment-aware base URL.

## Suggested Review Order

- The document head declares the icon's bundled sizes through Vite's deployment base.
  [`index.html:5`](../../apps/web/index.html#L5)
