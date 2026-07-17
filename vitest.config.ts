import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // PGlite cold-start + running every migration in beforeAll can flirt with
    // the default 10s hookTimeout on Windows when Docker is competing for
    // resources; will only grow as later phases add migrations.
    hookTimeout: 30_000,
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
