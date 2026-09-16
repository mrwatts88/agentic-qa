/**
 * VIOLATES be.authz.ownership-check.
 *
 * The session is checked, so the caller is definitely logged in. Nothing checks
 * that the order belongs to them, so any logged-in user can read any order by
 * changing the id in the URL.
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

  return c.json(order);
});
