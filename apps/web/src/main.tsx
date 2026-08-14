import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { createGamesClient } from "./api";
import { bootstrapRuntime } from "./runtime-config";
import { createProductRefusalHandler, defaultSessionStore } from "./session";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) throw new Error("Root element not found");

const runtime = bootstrapRuntime(window, {
  mode: import.meta.env.MODE === "production" ? "production" : "development",
});
const gamesClient = createGamesClient(runtime, fetch, {
  authorize: async () => {
    const token = await defaultSessionStore.authorize();
    const session = defaultSessionStore.getSnapshot();
    return token !== null && session?.token === token
      ? { token, accountId: session.accountId }
      : null;
  },
  refuse: createProductRefusalHandler(defaultSessionStore, {
    currentPath: () =>
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    navigate: (path) => window.location.assign(path),
  }),
});
// Install renewal before the router's first beforeLoad and before App's
// prefetch effect can authorize a request with a near-expiry startup token.
defaultSessionStore.setRefresher(
  gamesClient.ok && gamesClient.value.refreshSession
    ? (token, signal) => gamesClient.value.refreshSession!(token, signal)
    : null,
);

createRoot(root).render(
  <StrictMode>
    <App gamesClient={gamesClient} sessionRefresherInstalled />
  </StrictMode>,
);
