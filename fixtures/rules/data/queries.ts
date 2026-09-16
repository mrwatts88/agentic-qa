// VIOLATES data.sql.no-concatenated-query
// VIOLATES data.privacy.no-personal-data-in-logs
import { db } from "./client";
import { logger } from "./logger";

export async function findUserByEmail(email: string) {
  logger.info("looking up user", { email });

  const rows = await db.query(
    "select * from users where email = '" + email + "'",
  );
  return rows[0];
}
