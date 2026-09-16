/**
 * Deleting an order through the admin API, scoped to the caller's account.
 *
 * Deliberately worded without naming a verdict, for the same reason as its
 * neighbour: prose is part of what the judge reads.
 */
import { Hono } from "hono";
import { orderRepo } from "./repositories/orderRepo";

export const app = new Hono();

app.delete("/orders/:id", async (c) => {
  const session = c.get("session");
  if (!session) {
    return c.json({ error: "UNAUTHENTICATED" }, 401);
  }

  const removed = await orderRepo.deleteByIdForAccount(
    c.req.param("id"),
    session.accountId,
  );

  if (!removed) {
    return c.json({ error: "NOT_FOUND" }, 404);
  }

  return c.body(null, 204);
});
