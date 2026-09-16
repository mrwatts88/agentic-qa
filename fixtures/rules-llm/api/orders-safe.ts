/**
 * Clean control for be.authz.ownership-check.
 *
 * Structurally almost identical to orders.ts: same framework, same route shape,
 * same repository call, same id taken from the URL. The single difference is
 * the ownership comparison. A rule that cannot tell these two apart is useless.
 */
import { Hono } from "hono";
import { findOrderById } from "./repositories/orderRepo";

export const app = new Hono();

app.get("/orders/:id", async (c) => {
  const session = c.get("session");
  if (!session) {
    return c.json({ error: "UNAUTHENTICATED" }, 401);
  }

  const order = await findOrderById(c.req.param("id"));
  if (!order) {
    return c.json({ error: "NOT_FOUND" }, 404);
  }

  if (order.customerId !== session.userId) {
    return c.json({ error: "NOT_FOUND" }, 404);
  }

  return c.json(order);
});
