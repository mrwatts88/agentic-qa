/**
 * Deleting an order through the admin API.
 *
 * Deliberately worded without naming a verdict. The judge reads whole files, so
 * a header announcing what a fixture is supposed to prove is evidence handed to
 * the thing under test.
 */
import { Hono } from "hono";
import { orderRepo } from "./repositories/orderRepo";

export const app = new Hono();

app.delete("/orders/:id", async (c) => {
  const session = c.get("session");
  if (!session) {
    return c.json({ error: "UNAUTHENTICATED" }, 401);
  }

  const removed = await orderRepo.deleteById(c.req.param("id"));
  if (!removed) {
    return c.json({ error: "NOT_FOUND" }, 404);
  }

  return c.body(null, 204);
});
