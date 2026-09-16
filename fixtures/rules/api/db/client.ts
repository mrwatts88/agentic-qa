/**
 * Clean control for be.layer.no-db-client-outside-repository.
 *
 * This module imports the database driver, which is exactly what the rule
 * matches on, and it is not in the repository layer. It is still correct: the
 * module that constructs the connection pool is the database client itself,
 * and something has to build it before a repository can use it.
 *
 * The rule fired here when it was first pointed at a real application, which
 * is how the gap was found. A pool module is normal architecture, so the rule
 * gained a narrow exemption for the conventional filenames rather than for
 * everything under db/.
 */
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

export const sql = postgres(connectionString, {
  max: 10,
  idle_timeout: 20,
});
