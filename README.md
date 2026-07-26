# FIND THE EDGE

A private sports betting intelligence platform for scouting events, comparing sportsbook odds, identifying positive expected value opportunities, and tracking performance.

The current local-first MVP contains a deterministic MLB moneyline Edge Lab. It calculates no-vig fair probability, fair price, EV, and an auditable Play/No Bet decision without external data or AI keys.

## Run locally

Requirements: Node.js 20.19+ and pnpm 10.

```sh
pnpm install
pnpm dev
```

Open the local URL printed by Vite.

## Quality gates

```sh
pnpm check
```

The canonical product and betting rules live in `docs/product-philosophy.md`, `docs/frameworks`, `models`, and `prompts`. The BMAD plan remains in `_bmad-output`.
