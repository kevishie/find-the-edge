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

Fixture mode needs no `.env` file, provider key, AWS account, or paid service. See [local development](docs/local-development.md) for environment profiles, validation behavior, and troubleshooting.

## Quality gates

```sh
pnpm check
```

The test harness separates fast deterministic checks from browser coverage:

```sh
pnpm test
pnpm coverage
pnpm exec playwright install chromium # one-time local browser install
pnpm test:e2e
```

Vitest runs package and React tests. The starter coverage policy requires 50% statements, functions, and lines plus 40% branches for the web app. Playwright runs the shell smoke suite at desktop and mobile widths and retains screenshots, video, traces, and the HTML report when a test fails. Tests use fixtures only and require no secrets or provider access.

The canonical product and betting rules live in `docs/product-philosophy.md`, `docs/frameworks`, `models`, and `prompts`. The BMAD plan remains in `_bmad-output`.
