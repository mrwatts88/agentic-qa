// VIOLATES sec.jwt.no-none-algorithm
// VIOLATES sec.password.no-fast-hash
// VIOLATES sec.cookie.session-cookie-must-be-httponly
// VIOLATES sec.cors.no-wildcard-origin-with-credentials
import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";

export const corsOptions = {
  origin: "*",
  credentials: true,
};

export function hashPassword(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

export function verify(token: string) {
  return jwt.verify(token, process.env.JWT_SECRET!, { algorithms: ["none"] });
}

export const sessionCookie = {
  name: "sid",
  httpOnly: false,
  secure: true,
};
