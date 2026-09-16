import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { extractTests, extractRelativeImports } from "../src/contracts/extract";

const sample = fileURLToPath(
  new URL("../fixtures/sample/coupon.test.ts", import.meta.url),
);
const runnable = fileURLToPath(
  new URL("../fixtures/runnable/cart.test.ts", import.meta.url),
);

const sampleTests = extractTests(sample, "coupon.test.ts");

describe("extractTests", () => {
  it("finds every test in a file without picking up the describe blocks", () => {
    expect(sampleTests).toHaveLength(5);
    expect(sampleTests.map((t) => t.title)).toContain("rejects an expired coupon");
    expect(sampleTests.map((t) => t.title)).not.toContain("applyCoupon");
  });

  it("records the full chain of enclosing describe blocks in order", () => {
    const nested = sampleTests.find((t) => t.title === "does not create an order");

    expect(nested?.describePath).toEqual([
      "checkout",
      "when the payment provider declines",
    ]);
  });

  it("builds an id from the file, the describe chain and the title", () => {
    const nested = sampleTests.find((t) => t.title === "does not create an order");

    expect(nested?.id).toBe(
      "coupon.test.ts::checkout > when the payment provider declines > does not create an order",
    );
  });

  it("uses the test title as the description when there is no docblock", () => {
    const plain = sampleTests.find((t) => t.title === "rejects an expired coupon");

    expect(plain?.description).toBe("rejects an expired coupon");
    expect(plain?.descriptionSource).toBe("title");
  });

  /**
   * Regression. The first implementation read only the closest leading comment,
   * so an unrelated line comment sitting between the docblock and the test hid
   * the docblock completely and the test was judged on its title instead.
   */
  it("reads an @describes docblock even when a line comment sits between it and the test", () => {
    const documented = sampleTests.find((t) => t.title === "refuses to stack");

    expect(documented?.descriptionSource).toBe("docblock");
    expect(documented?.description).toBe(
      "Stacking two coupons is refused: the second call leaves the cart total exactly as the first coupon left it, and reports STACKING.",
    );
  });

  it("joins a multi-line docblock into one line and strips the comment markers", () => {
    const documented = sampleTests.find((t) => t.title === "refuses to stack");

    expect(documented?.description).not.toContain("*");
    expect(documented?.description).not.toContain("\n");
  });

  it("reports the line each test starts on", () => {
    for (const test of sampleTests) {
      expect(test.line).toBeGreaterThan(0);
    }
  });
});

describe("extractRelativeImports", () => {
  it("resolves a relative import with no extension to the TypeScript file on disk", () => {
    const imports = extractRelativeImports(runnable);

    expect(imports).toHaveLength(1);
    expect(imports[0].endsWith("/fixtures/runnable/cart.ts")).toBe(true);
  });

  it("ignores package imports so only first-party code is offered for mutation", () => {
    const imports = extractRelativeImports(runnable);

    expect(imports.some((p) => p.includes("vitest"))).toBe(false);
  });
});
