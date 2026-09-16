import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // fixtures/ holds deliberately-broken suites used as judge ground truth.
    // They are parsed by the extractor, never executed.
    exclude: ["**/node_modules/**", "**/dist/**", "fixtures/**"],
  },
});
