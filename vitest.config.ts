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
    // Several suites start real scanners from cold, and on a small CI runner
    // they share the CPU with a real opengrep scan, which uses every core. A
    // hook test once timed out at the 5s default there and its late output
    // leaked into the next test. A genuine hang still fails at this limit.
    testTimeout: 30_000,
  },
});
