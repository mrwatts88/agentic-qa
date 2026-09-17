import { Hono } from "hono";
import { cors } from "hono/cors";
import { setCookie } from "hono/cookie";
import { createHash } from "node:crypto";

const app = new Hono();

app.use("*", cors({ origin: "*", credentials: true }));

app.post("/login", async (c) => {
  const { password } = await c.req.json();
  const digest = createHash("sha256").update(password).digest("hex");
  setCookie(c, "sid", digest, { httpOnly: false, secure: true });
  return c.json({ ok: true });
});

export default app;
