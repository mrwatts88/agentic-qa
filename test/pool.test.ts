import { describe, it, expect } from "vitest";
import { pool } from "../src/pool";
import { DEFAULT_CONFIG } from "../src/config";
import { STOP_HOOK_TIMEOUT_S } from "../src/init";
import { JUDGING_WINDOW_MS } from "../src/stop";

describe("pool", () => {
  it("runs every item when there is no deadline", async () => {
    const results = await pool([1, 2, 3], 2, async (n) => n * 2);

    expect(results).toEqual([2, 4, 6]);
  });

  it("starts nothing once the deadline has passed", async () => {
    const started: number[] = [];

    await pool([1, 2, 3], 2, async (n) => started.push(n), Date.now() - 1);

    expect(started).toEqual([]);
  });

  it("stops starting items at the deadline, and lets running ones finish", async () => {
    const finished: number[] = [];
    const deadline = Date.now() + 30;

    await pool(
      [1, 2, 3, 4],
      1,
      async (n) => {
        await new Promise((done) => setTimeout(done, 50));
        finished.push(n);
      },
      deadline,
    );

    expect(finished).toEqual([1]);
  });
});

/**
 * A Stop hook that outlives its timeout is cancelled with nothing reported: a
 * real session built a feature and none of it was checked. The window in which
 * Stop starts judgments, plus one judgment that started at its very end, has to
 * fit inside the timeout `init` writes.
 */
describe("the Stop hook's time", () => {
  it("fits the judging window and one last judgment inside the hook timeout", () => {
    expect(JUDGING_WINDOW_MS + DEFAULT_CONFIG.judge.timeoutMs).toBeLessThan(STOP_HOOK_TIMEOUT_S * 1000);
  });
});
