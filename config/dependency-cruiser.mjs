// The dependency-cruiser rule set agentic-qa runs, shipped with the tool for the
// same reason the eslint config is. Only rules the corpus claims block; any
// other violation is a gauntlet note.
//
// Paths are matched against repo-relative module paths. Resolved packages show
// up under node_modules/, and a package that is not installed keeps its bare
// name, so both forms are listed.
const DB_PACKAGES = "(pg|postgres|drizzle-orm|kysely|knex)";

export default {
  forbidden: [
    {
      // Claimed by be.layer.no-db-client-outside-repository. Mirrors that
      // rule's excludePaths, so an exempt file is not reported at all rather
      // than demoted to a note on every run.
      name: "no-db-client-outside-repository",
      severity: "error",
      from: {
        pathNot: [
          "(^|/)(repositories|repository|migrations)/",
          // The module that constructs the pool is the client, not a consumer.
          "(^|/)(db|database)/(client|index|pool)\\.(ts|js)$",
          "\\.(test|spec)\\.(ts|tsx)$",
        ],
      },
      to: {
        path: [
          `(^|/)node_modules/${DB_PACKAGES}(/|$)`,
          `^${DB_PACKAGES}$`,
          // The repo's own client module. This is the violation real code
          // actually contains, and the one no import-name pattern can see.
          "(^|/)(db|database)/(client|index|pool)\\.(ts|js)$",
        ],
      },
    },
    {
      name: "no-circular",
      severity: "warn",
      from: {},
      to: { circular: true },
    },
  ],
};
