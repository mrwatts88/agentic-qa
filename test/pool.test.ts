import { describe, it, expect } from "vitest";
import { pool } from "../src/pool";

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
