// VIOLATES test.no-mocking-own-modules (relative path means it is our code)
// VIOLATES test.no-conditional-logic
// VIOLATES test.no-assertion-free-test
import { describe, it, expect, vi } from "vitest";

vi.mock("./widgetService");

describe("widget", () => {
  it("builds a widget", () => {
    const widget = { size: 3 };

    if (widget.size > 2) {
      expect(widget.size).toBe(3);
    }
  });

  it("does not explode", () => {
    const result = { ok: true };
    expect(result).toBeDefined();
  });
});
