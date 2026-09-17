import { describe, it, expect } from "vitest";
import { guardrailText, rulesForRepo } from "../src/steer";
import { loadRules } from "../src/rules/load";

const corpus = loadRules();

describe("guardrailText", () => {
  const text = guardrailText(corpus);

  it("names every rule it is given, by id", () => {
    expect(corpus.filter((r) => !text.includes(`[${r.id}]`)).map((r) => r.id)).toEqual([]);
  });

  /** The agent should know which rules stop it and which are left to review. */
  it("separates what blocks at the end of a turn from what is reviewed later", () => {
    const [checked, reviewed] = text.split("reviewed before the work is merged");

    expect(checked).toContain("[fe.storage.no-token-in-local-storage]");
    expect(reviewed).toContain("[be.authz.ownership-check]");
    expect(checked).not.toContain("[be.authz.ownership-check]");
  });

  it("tells the agent an exception is the person's to make", () => {
    expect(text).toContain("counts only once a person commits it");
  });

  /**
   * Paid on every session, and read carefully only while short. When the corpus
   * outgrows this, the answer is choosing what to show, not raising the number.
   */
  it("stays short enough to be read", () => {
    expect(text.length).toBeLessThan(4_000);
  });
});

describe("rulesForRepo", () => {
  it("leaves out rules that match no file in the repo", () => {
    const ids = rulesForRepo(corpus, ["api/src/orders.ts"]).map((r) => r.id);

    expect(ids).toContain("be.authz.ownership-check");
    expect(ids).not.toContain("fe.a11y.no-click-handler-on-div");
  });

  it("gives a repo with no code every rule, since all its code is still to be written", () => {
    expect(rulesForRepo(corpus, [])).toHaveLength(corpus.length);
    // What `init` leaves in a new repo is configuration, not code.
    expect(rulesForRepo(corpus, ["qa.config.yaml", ".claude/settings.json"])).toHaveLength(corpus.length);
  });
});
