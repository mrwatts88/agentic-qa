import { defineConfig } from "vitest/config";

/**
 * Real Claude Code sessions against the built hooks: `npm run smoke`.
 * Kept out of `npm test`, which must stay free, offline and fast.
 */
export default defineConfig({
  test: {
    include: ["smoke/**/*.smoke.ts"],
    // Each session is a real model round trip or three, with Stop scanning.
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
