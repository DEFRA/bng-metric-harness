import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.mjs"],
    // The harness sibling symlinks (`frontend`, `backend`) point at separate
    // repos with their own test suites; never recurse into them.
    exclude: ["node_modules", "frontend", "backend", "../bng-metric-frontend", "../bng-metric-backend"],
  },
});
