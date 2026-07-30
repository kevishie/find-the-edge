# Local Development

FIND THE EDGE runs in fixture mode without provider keys, AWS credentials, or paid services.

## Prerequisites

- Node.js 20.19 or newer; Node 22.12 or newer is the CI baseline.
- pnpm 10 through the repository `packageManager` declaration.

## First run

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open the local Vite URL. The Edge Lab and `/sports/:sportKey/events` explorer use committed fixtures and make no provider or AI calls.

## Environment profiles

Copy `.env.example` to `.env` only when you need to override a safe local default. `.env` and all `.env.*` files remain ignored; `.env.example` is the only committed exception.

- `local` is the default. It requires no variables and sets fixture mode.
- `provider` requires `ODDS_API_KEY`. The blank example is a placeholder, not a working or safe default.
- `aws` requires `AWS_REGION` and `FTE_AWS_STAGE`. AWS access keys must never be stored in repository env files.

Packages must call `validateEnvironment(input, profile)` at their own startup boundary. Missing profile-specific variables and malformed common values produce `ConfigValidationError` with structured `variable`, `code`, and `message` fields. A package must not require variables for adapters it is not using.

## Quality and tests

```sh
pnpm check
pnpm coverage
pnpm test:e2e
```

Install the local E2E browser once with `pnpm exec playwright install chromium`. No command above requires a real provider, cloud account, production database, or secret.

## Troubleshooting

- A configuration error names every missing or malformed variable; select `local` when working only with fixtures.
- If Playwright cannot find Chromium, run the one-time install command above.
- If the Node engine check fails, use a supported Node release at or above 20.19.
