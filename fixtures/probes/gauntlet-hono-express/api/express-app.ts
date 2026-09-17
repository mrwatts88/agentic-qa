import express from "express";
import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const pool = new pg.Pool();
const app = express();

app.get("/orders/:id", async (req, res) => {
  const rows = await pool.query(`select * from orders where id = ${req.params.id}`);
  res.json(rows.rows);
});

app.get("/preview", async (req, res) => {
  const r = await fetch(req.query.url as string);
  res.send(await r.text());
});

app.get("/files/:name", async (req, res) => {
  res.send(await readFile(path.join("/srv/uploads", req.params.name)));
});

app.get("/login/done", (req, res) => res.redirect(req.query.next as string));

app.post("/thumbnail", (req, res) => {
  exec(`convert ${req.body.file} thumb.png`);
  res.send("ok");
});

app.post("/calc", (req, res) => {
  res.json({ result: eval(req.body.expr) });
});

app.get("/hello", (req, res) => res.send(`<p>Hello ${req.query.name}</p>`));
