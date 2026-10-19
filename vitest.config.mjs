import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.mjs"],
    // The harness sibling symlinks (`frontend`, `backend`) point at separate
    // repos with their own test suites; never recurse into them. Keep these
    // patterns inside this checkout: a reusable workflow may check the harness
    // out into a directory named bng-metric-backend, so ../bng-metric-backend
    // would exclude the harness root itself.
    exclude: ["**/node_modules/**", "frontend/**", "backend/**"],
  },
});
