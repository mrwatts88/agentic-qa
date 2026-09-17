import express from "express";

const app = express();

app.get("/login/done", (req, res) => res.redirect(req.query.next as string));

export default app;
