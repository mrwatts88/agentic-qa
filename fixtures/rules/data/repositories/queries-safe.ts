/**
 * Clean control for the data pack.
 *
 * Contains the exact shapes both data rules look for, done correctly. The
 * tagged template interpolates, but drizzle binds its interpolations as
 * parameters, so this is the right answer and must not be flagged: a rule
 * keying on "${ near SQL" would condemn it. The log line carries an id rather
 * than anything personal.
 *
 * It lives under repositories/ deliberately. The first version sat in data/,
 * where importing the database client correctly tripped the layering rule, and
 * a clean control has to be clean against every rule rather than only the one
 * it is demonstrating.
 */
import { sql } from "drizzle-orm";
import { db } from "../client";
import { logger } from "../logger";

export async function findUserById(userId: string) {
  logger.info("looking up user", { userId });

  const rows = await db.execute(
    sql`select id, created_at from users where id = ${userId}`,
  );
  return rows[0];
}
