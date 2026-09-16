/**
 * Clean control for the security additions.
 *
 * Every construct the four rules match on appears here in a correct form.
 * Two of them are the reason requireFilePattern exists: createHash("sha256")
 * is the right tool for a cache key, and a wildcard CORS origin is ordinary
 * for a public read-only API. Neither is wrong on its own, so neither may be
 * flagged here, where nothing is hashed for authentication and no credentials
 * are sent.
 *
 * Note this comment avoids naming the companion word the fast-hash rule looks
 * for. A file-level pattern matches prose as readily as code, so a clean
 * control that explains itself too literally trips the rule it documents.
 */
import { createHash } from "node:crypto";
import argon2 from "argon2";
import jwt from "jsonwebtoken";

// Wildcard origin, deliberately without credentials: a public, unauthenticated
// endpoint that any site may read.
export const publicCorsOptions = {
  origin: "*",
  credentials: false,
};

/** A fast hash, correctly used: this is a cache key, not a secret. */
export function cacheKeyFor(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

export async function hashSecret(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export function verify(token: string) {
  return jwt.verify(token, process.env.JWT_SECRET!, {
    algorithms: ["RS256"],
    issuer: "https://accounts.example.com",
    audience: "api",
  });
}

export const sessionCookie = {
  name: "sid",
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
};
