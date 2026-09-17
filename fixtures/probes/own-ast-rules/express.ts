import express from "express";
import cors from "cors";
import session from "cookie-session";
import crypto from "node:crypto";

const app = express();
app.use(cors({ origin: "*", credentials: true }));
app.use(session({ name: "sid", keys: ["k"], httpOnly: false }));

app.post("/login", (req, res) => {
  const digest = crypto.createHash("md5").update(req.body.password).digest("hex");
  res.cookie("sid", digest, { httpOnly: false });
  res.json({ ok: true });
});
