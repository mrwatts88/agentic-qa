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
 */
import { describe, it, expect } from "vitest";
import { persistSession, readSession } from "./session";

describe("persistSession", () => {
  it("round-trips a session token through browser storage", () => {
    localStorage.setItem("authToken", "test-token-value");

    expect(readSession()).toBe("test-token-value");
  });

  it("overwrites a previously stored token rather than appending", () => {
    localStorage.setItem("authToken", "first");
    persistSession("second");

    expect(readSession()).toBe("second");
  });
});
