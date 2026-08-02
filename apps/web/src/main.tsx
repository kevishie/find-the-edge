import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { createGamesClient } from "./api";
import { bootstrapRuntime } from "./runtime-config";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <App
      gamesClient={createGamesClient(
        bootstrapRuntime(window, {
          mode:
            import.meta.env.MODE === "production"
              ? "production"
              : "development",
        }),
      )}
    />
  </StrictMode>,
);
