import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      thresholds: {
        branches: 40,
        functions: 50,
        lines: 50,
        statements: 50,
      },
    },
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
