import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // fixtures/ holds deliberately-broken suites used as judge ground truth.
    // They are parsed by the extractor, never executed.
    exclude: ["**/node_modules/**", "**/dist/**", "fixtures/**"],
    // Unit tests never download a scanner or its rules. A test that needs a
    // real binary uses one already installed or cached, and says so with a
    // skip; tests of provisioning itself inject a fake downloader.
    env: { AGENTIC_QA_NO_DOWNLOAD: "1" },
  },
});
