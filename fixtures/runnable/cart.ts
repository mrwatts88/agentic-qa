/**
 * A real, working implementation used to validate mutation grounding.
 *
 * Unlike fixtures/sample, this suite actually runs and is green. Mutation
 * grounding needs executable tests: it breaks the implementation on purpose
 * and requires the test to notice.
 */
export interface Cart {
  total: number;
  discountApplied: boolean;
}

export interface Coupon {
  code: string;
  percent: number;
  expiresAt: number;
}

export interface CouponResult {
  ok: boolean;
  error?: string;
}

export function applyCoupon(
  cart: Cart,
  coupon: Coupon,
  now: number,
): CouponResult {
  if (coupon.expiresAt <= now) {
    return { ok: false, error: "COUPON_EXPIRED" };
  }

  if (cart.discountApplied) {
    return { ok: false, error: "STACKING" };
  }

  cart.total = Math.round(cart.total * (1 - coupon.percent / 100));
  cart.discountApplied = true;
  return { ok: true };
}
