// VIOLATES be.layer.no-db-client-outside-repository (a handler, not a repository)
// VIOLATES be.validation.no-unvalidated-request-body (no schema parse anywhere)
import { Hono } from "hono";
import { sql } from "drizzle-orm";

export const app = new Hono();

app.post("/orders", async (c) => {
  const body = await c.req.json();
  await sql`insert into orders (total) values (${body.total})`;
  return c.json({ ok: true });
});
