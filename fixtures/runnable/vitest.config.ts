import { defineConfig } from "vitest/config";

// This fixture is meant to be executed, so unlike the repo root config it does
// not exclude itself. Run it with: npx vitest run --root fixtures/runnable
export default defineConfig({
  test: {
    include: ["*.test.ts"],
  },
});
