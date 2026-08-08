import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // Dependencies change on a different cadence from app code, so a
          // separate vendor chunk stays byte-identical across most deploys
          // and repeat visitors only re-download the app chunk.
          if (id.includes("node_modules")) return "vendor";
          return undefined;
        },
      },
    },
  },
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
