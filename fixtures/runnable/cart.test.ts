import { describe, it, expect } from "vitest";
import { applyCoupon, type Cart, type Coupon } from "./cart";

const NOW = 1_000;

function cart(): Cart {
  return { total: 100, discountApplied: false };
}

function coupon(overrides: Partial<Coupon> = {}): Coupon {
  return { code: "SAVE10", percent: 10, expiresAt: NOW + 1_000, ...overrides };
}

describe("applyCoupon", () => {
  /**
   * Both tests below pass against the correct implementation. They differ in
   * whether they would survive a deliberate break, which is exactly what
   * mutation grounding measures.
   */

  // Strong. Removing the expiry check must make this fail.
  it("rejects a coupon that expired before the current time", () => {
    const c = cart();
    const result = applyCoupon(c, coupon({ expiresAt: NOW - 1 }), NOW);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("COUPON_EXPIRED");
    expect(c.total).toBe(100);
    expect(c.discountApplied).toBe(false);
  });

  // Weak. Removing the discount arithmetic must NOT make this fail, which is
  // what proves the test is not earning its place.
  it("applies a percentage discount to the cart total", () => {
    const c = cart();
    const result = applyCoupon(c, coupon(), NOW);

    expect(result).toBeDefined();
  });
});
