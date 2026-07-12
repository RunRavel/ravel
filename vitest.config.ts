import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Filesystem-watch tests (chokidar, in polling mode) need a little headroom.
    testTimeout: 10000,
  },
});
