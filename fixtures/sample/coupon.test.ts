/**
 * Fixture suite for the contract checker. These tests are never executed;
 * they exist so the extractor and judge can be validated against cases with
 * known-correct verdicts. Expected verdicts are recorded in expected.json.
 */
import { describe, it, expect, vi } from "vitest";
import { applyCoupon, checkout } from "./cart";

describe("applyCoupon", () => {
  // EXPECT: upheld - assertions pin rejection, reason, and unchanged total.
  it("rejects an expired coupon", () => {
    const cart = { total: 100 };
    const result = applyCoupon(cart, { code: "OLD", expired: true });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("COUPON_EXPIRED");
    expect(cart.total).toBe(100);
  });

  // EXPECT: violated - toBeDefined passes whether or not the coupon applied.
  it("applies a percentage discount to the cart total", () => {
    const cart = { total: 100 };
    const result = applyCoupon(cart, { code: "SAVE10", percent: 10 });

    expect(result).toBeDefined();
  });

  /**
   * @describes Stacking two coupons is refused: the second call leaves the
   * cart total exactly as the first coupon left it, and reports STACKING.
   */
  // EXPECT: upheld - docblock description, assertions match it precisely.
  it("refuses to stack", () => {
    const cart = { total: 100 };
    applyCoupon(cart, { code: "SAVE10", percent: 10 });
    const second = applyCoupon(cart, { code: "SAVE20", percent: 20 });

    expect(second.ok).toBe(false);
    expect(second.error).toBe("STACKING");
    expect(cart.total).toBe(90);
  });

  // EXPECT: unverifiable - the description cannot be falsified.
  it("works correctly", () => {
    const cart = { total: 100 };
    expect(applyCoupon(cart, { code: "SAVE10", percent: 10 }).ok).toBe(true);
  });
});

describe("checkout", () => {
  describe("when the payment provider declines", () => {
    // EXPECT: violated - asserts only on the mock configured in this test.
    it("does not create an order", async () => {
      const charge = vi.fn().mockResolvedValue({ declined: true });
      await checkout({ total: 100 }, { charge });

      expect(charge).toHaveBeenCalledWith(100);
    });
  });
});
