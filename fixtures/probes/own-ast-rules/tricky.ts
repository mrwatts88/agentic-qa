import { cors } from "hono/cors";
import { createHash } from "node:crypto";

const opts = {
  credentials: true,
  // wildcard, split over lines and after credentials
  origin:
    "*",
};
export const middleware = cors(opts);

export function checksum(file: Buffer) {
  return createHash("sha256").update(file).digest("hex");
}

export function hashPassword(user: { password: string }) {
  return createHash("sha256").update(user.password).digest("hex");
}

// httpOnly: false is fine to mention in a comment
export const note = "set httpOnly: false only in tests";
