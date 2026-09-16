/**
 * Reading a single order through the admin API.
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
