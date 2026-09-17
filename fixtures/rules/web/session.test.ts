/**
 * Clean control for the whole class of rules that match on dangerous-looking
 * strings.
 *
 * This is a test file, and it deliberately contains the exact constructs
 * fe.storage.no-token-in-local-storage and fe.env.no-secret-in-public-env match
 * on. Writing that string in a test is how you prove production code must not.
 * None of those rules may fire here.
 *
 * This case was missing when the corpus was first written, and the hook found
 * it by firing on the tool's own test suite.
 *
 * It also holds the shapes the test-structure rules must leave alone: a loop
 * that only builds data, nullish coalescing, optional chaining, and an optional
 * parameter.
 */
import { describe, it, expect } from "vitest";
import { persistSession, readSession } from "./session";

function seed(value?: string): void {
  localStorage.setItem("authToken", value ?? "seed");
}

describe("persistSession", () => {
  it("round-trips a session token through browser storage", () => {
    localStorage.setItem("authToken", "test-token-value");

    expect(readSession()).toBe("test-token-value");
  });

  it("keeps only the last of several stored tokens", () => {
    const tokens: string[] = [];
    for (let i = 0; i < 3; i++) {
      tokens.push(`token-${i}`);
    }
    tokens.forEach((token) => {
      persistSession(token);
    });

    const stored = readSession() ?? "none";
    expect(stored?.length).toBe("token-2".length);
    expect(stored).toBe(tokens.at(-1));
  });

  it("overwrites a previously stored token rather than appending", () => {
    seed("first");
    persistSession("second");

    expect(readSession()).toBe("second");
  });
});
