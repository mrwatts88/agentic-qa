import { Hono } from "hono";
import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import jwt from "jsonwebtoken";
import pg from "pg";

const pool = new pg.Pool();
const app = new Hono();

app.get("/orders/:id", async (c) => {
  const rows = await pool.query(`select * from orders where id = ${c.req.param("id")}`);
  return c.json(rows.rows);
});

app.get("/preview", async (c) => {
  const res = await fetch(c.req.query("url")!);
  return c.text(await res.text());
});

app.get("/files/:name", async (c) => {
  const data = await readFile(path.join("/srv/uploads", c.req.param("name")));
  return c.body(data);
});

app.get("/login/done", (c) => c.redirect(c.req.query("next")!));

app.post("/thumbnail", async (c) => {
  const { file } = await c.req.json();
  exec(`convert ${file} thumb.png`);
  return c.text("ok");
});

app.post("/calc", async (c) => {
  const { expr } = await c.req.json();
  return c.json({ result: eval(expr) });
});

app.get("/search", (c) => {
  const re = new RegExp(c.req.query("q")!);
  return c.json({ ok: re.test("x") });
});

app.get("/hello", (c) => c.html(`<p>Hello ${c.req.query("name")}</p>`));

app.get("/me", (c) => {
  const claims = jwt.decode(c.req.header("authorization")!.slice(7));
  return c.json(claims);
});

export function newSessionId(): string {
  return Math.random().toString(36).slice(2);
}

export default app;
