/**
 * False-positive control for be.layer.no-db-client-outside-repository.
 *
 * This file imports the database client, which is exactly what the rule
 * matches on, but it lives in the repository layer where that is the correct
 * thing to do. The rule must not fire here.
 */
import { sql } from "drizzle-orm";

export async function findUserById(id: string) {
  return sql`select * from users where id = ${id} limit 1`;
}
