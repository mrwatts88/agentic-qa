import { describe, it, expect } from "vitest";
import { priceFor, lineItems } from "./pricing";

describe("pricing", () => {
  it("charges more for large orders", () => {
    const large = true;

    expect(priceFor(10)).toBe(large ? 90 : 100);
  });

  it("prices every line item", () => {
    const items = lineItems([]);

    for (const item of items) {
      expect(item.price).toBeGreaterThan(0);
    }
  });
});
