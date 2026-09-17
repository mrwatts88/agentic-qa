import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Adapter, ToolFinding, ToolRun } from "./types.js";
import { pool } from "../../pool.js";
import { ensureBinary, GITLEAKS } from "../../tools/provision.js";

/**
 * The config is the upstream default ruleset, vendored at the version
 * `GITLEAKS.version` pins, so the rules are pinned and reviewable rather than
 * whatever a binary happens to embed. Re-vendor both together; never edit the
 * config by hand.
 */

export function bundledGitleaksConfig(): string {
  return fileURLToPath(new URL("../../../config/gitleaks.toml", import.meta.url));
}

/** gitleaks scans one path per invocation, and one costs about 20ms. */
const CONCURRENCY = 8;

interface Leak {
  RuleID: string;
  Description: string;
  File: string;
  StartLine: number;
}

function scan(
  binary: string,
  cwd: string,
  file: string,
  config: string,
): Promise<Leak[] | NodeJS.ErrnoException> {
  return new Promise((done) => {
    execFile(
      binary,
      [
        "dir", file,
        "--config", config,
        "--no-banner",
        // The secret never reaches our output, the terminal or the agent.
        "--redact",
        "--report-format", "json",
        "--report-path", "-",
        "--exit-code", "0",
        "--log-level", "error",
      ],
      { cwd, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return done(err as NodeJS.ErrnoException);
        try {
          done(JSON.parse(stdout || "[]") as Leak[]);
        } catch (parseErr) {
          done(parseErr as Error);
        }
      },
    );
  });
}

/**
 * The vendored config's rule ids and global path allowlist, read without a TOML
 * parser: the file is generated upstream and its shape is regular.
 */
function readConfig(path: string): { ids: Set<string>; allowPaths: RegExp[] } {
  const text = readFileSync(path, "utf8");
  const ids = new Set([...text.matchAll(/^id = "([^"]+)"/gm)].map((m) => m[1]));

  const block = text.match(/^\[allowlist\][\s\S]*?^paths = \[([\s\S]*?)^\]/m)?.[1] ?? "";
  const allowPaths: RegExp[] = [];
  for (const [, source] of block.matchAll(/'''(.*?)'''/g)) {
    // Go's inline (?i) has no JavaScript equivalent; it becomes a flag.
    const insensitive = source.startsWith("(?i)");
    try {
      allowPaths.push(new RegExp(insensitive ? source.slice(4) : source, insensitive ? "i" : ""));
    } catch {
      // An RE2-only construct. Skipping it can only make isLive say "live" for
      // a file gitleaks would skip, which is the harmless direction.
    }
  }
  return { ids, allowPaths };
}

/**
 * The pinned binary, downloaded on first use. Offline and never downloaded, a
 * gitleaks already on the PATH is the fallback: a different version is still
 * far better than no secret scan.
 */
async function provisioned(): Promise<string> {
  try {
    return await ensureBinary(GITLEAKS);
  } catch {
    return "gitleaks";
  }
}

export function gitleaks(configFile = bundledGitleaksConfig(), binary?: string): Adapter {
  let config: ReturnType<typeof readConfig> | undefined;
  const load = () => (config ??= readConfig(configFile));

  return {
    tool: "gitleaks",

    // Secrets turn up in any file: .env, Terraform, YAML, docs.
    handles: () => true,

    async run(cwd, files): Promise<ToolRun> {
      const exe = binary ?? (await provisioned());
      const results = await pool(files, CONCURRENCY, (file) => scan(exe, cwd, file, configFile));

      const findings: ToolFinding[] = [];
      for (const result of results) {
        if (result instanceof Error) {
          if ((result as NodeJS.ErrnoException).code === "ENOENT") {
            return { status: "unavailable", reason: "gitleaks is not installed" };
          }
          return { status: "unavailable", reason: `gitleaks failed: ${result.message}` };
        }
        for (const leak of result) {
          findings.push({
            rule: leak.RuleID,
            file: leak.File.split("\\").join("/"),
            line: leak.StartLine,
            message: leak.Description,
            redact: true,
          });
        }
      }
      return { status: "ran", findings };
    },

    async isLive(_cwd, rule, file) {
      const { ids, allowPaths } = load();
      return ids.has(rule) && !allowPaths.some((p) => p.test(file));
    },
  };
}
