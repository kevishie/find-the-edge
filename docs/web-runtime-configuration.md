# Web runtime configuration

The static web host must install its external identity/session integration before the application module runs. It does so without exposing credentials in the build:

1. Register an async access-token function as an own data property, for example `window.__FTE_TOKEN_PROVIDERS__.hostSession = async () => session.getAccessToken()`.
2. Build the web application first with `pnpm --filter @find-the-edge/web build` so `apps/web/dist` exists.
3. Generate `runtime-config.js` during deployment with `pnpm generate:web-runtime-config -- --api-base https://api.example.com --provider-key hostSession --output apps/web/dist/runtime-config.js`.
4. Serve that artifact at `/runtime-config.js`. `index.html` loads it before the application module.

The provider must return the current access token as a string. The browser bootstrap applies an abort signal, a bounded timeout, whitespace and size checks, and exposes only redacted error categories. Provider exceptions and token contents are never displayed or logged by this contract.

The checked-in artifact is intentionally unusable. A plain `pnpm --filter @find-the-edge/web build` therefore cannot silently connect to an API. The hosting layer is responsible for replacing it and for choosing/configuring its own auth SDK; this repository contract does not bundle one.
