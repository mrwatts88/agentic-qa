import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import type { Adapter, ToolFinding, ToolRun } from "./types.js";

/**
 * Shipped with the tool, not read from the checked repo. See the config file
 * itself for why.
 */
export function bundledEslintConfig(): string {
  return fileURLToPath(new URL("../../../config/eslint.config.js", import.meta.url));
}

const LINTABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

type EslintInstance = import("eslint").ESLint;

export function eslint(configFile = bundledEslintConfig()): Adapter {
  // One instance per repo root. Constructing it loads the config and every
  // plugin, which is most of the cost of a small run.
  const instances = new Map<string, Promise<EslintInstance>>();

  function instance(cwd: string): Promise<EslintInstance> {
    let found = instances.get(cwd);
    if (!found) {
      found = import("eslint").then(
        ({ ESLint }) =>
          new ESLint({
            cwd,
            overrideConfigFile: configFile,
            errorOnUnmatchedPattern: false,
          }),
      );
      instances.set(cwd, found);
    }
    return found;
  }

  return {
    tool: "eslint",

    handles: (file) => LINTABLE.test(file),

    async run(cwd, files): Promise<ToolRun> {
      const linter = await instance(cwd);
      const results = await linter.lintFiles(files);

      const findings: ToolFinding[] = [];
      for (const result of results) {
        const file = relative(cwd, result.filePath).split("\\").join("/");
        for (const message of result.messages) {
          if (message.ruleId) {
            findings.push({
              rule: message.ruleId,
              file,
              line: message.line ?? 1,
              message: message.message,
            });
          } else if (message.fatal) {
            // A file that does not parse had no rule run on it. Saying nothing
            // would report it as clean.
            findings.push({
              rule: "parse-error",
              file,
              line: message.line ?? 1,
              message: message.message,
            });
          }
          // Anything else without a rule id is eslint talking about itself,
          // such as a file its config does not cover.
        }
      }
      return { status: "ran", findings };
    },

    async isLive(cwd, rule, file) {
      const linter = await instance(cwd);
      const config = await linter.calculateConfigForFile(file);
      const setting = config?.rules?.[rule];
      const level = Array.isArray(setting) ? setting[0] : setting;
      return level !== undefined && level !== 0 && level !== "off";
    },
  };
}
