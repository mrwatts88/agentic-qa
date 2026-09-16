/**
 * False-positive control for be.validation.no-unvalidated-request-body.
 *
 * This reads the request body, which is what the rule matches on, but it parses
 * it through a schema first. The rule must not fire here.
 */
import { Hono } from "hono";
import { z } from "zod";

const createOrder = z.object({ total: z.number().int().positive() });

export const app = new Hono();

app.post("/orders", async (c) => {
  const body = await c.req.json();
  const order = createOrder.parse(body);
  return c.json({ ok: true, total: order.total });
});
