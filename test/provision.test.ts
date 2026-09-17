import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  binaryPath,
  cacheDir,
  OPENGREP,
  semgrepRulesPath,
  ensureBinary,
  ensureSemgrepRules,
  SEMGREP_RULES,
  type BinarySpec,
  type Download,
} from "../src/tools/provision";
import { opengrep, ruleDirsFor, stableRuleId } from "../src/rules/adapters/opengrep";
import { defaultAdapters } from "../src/rules/adapters/index";
import type { ToolRun } from "../src/rules/adapters/types";

let dir: string;
let previousCache: string | undefined;

function write(relative: string, contents: string): void {
  const path = join(dir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A downloader that serves fixed bytes and counts how often it was asked. */
function serving(bytes: Buffer) {
  const calls: string[] = [];
  const download: Download = async (url) => {
    calls.push(url);
    return bytes;
  };
  return { download, calls };
}

function spec(asset: { sha256: string; member?: string }): BinarySpec {
  const one = { url: "https://example.invalid/tool", ...asset };
  return {
    name: "tool",
    version: "1.0.0",
    assets: { "darwin-arm64": one, "darwin-x64": one, "linux-x64": one, "linux-arm64": one },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentic-qa-provision-"));
  previousCache = process.env.AGENTIC_QA_CACHE;
  process.env.AGENTIC_QA_CACHE = join(dir, "cache");
});

afterEach(() => {
  if (previousCache === undefined) delete process.env.AGENTIC_QA_CACHE;
  else process.env.AGENTIC_QA_CACHE = previousCache;
  rmSync(dir, { recursive: true, force: true });
});

describe("provisioning a pinned binary", () => {
  const bytes = Buffer.from("#!/bin/sh\necho tool\n");

  it("downloads once, installs an executable, and reuses it after", async () => {
    const { download, calls } = serving(bytes);

    const first = await ensureBinary(spec({ sha256: sha256(bytes) }), download);
    const second = await ensureBinary(spec({ sha256: sha256(bytes) }), download);

    expect(first).toBe(second);
    expect(calls).toHaveLength(1);
    expect(execFileSync(first, { encoding: "utf8" })).toBe("tool\n");
  });

  /** A tampered or truncated download must never become something we execute. */
  it("refuses a download whose checksum does not match, and installs nothing", async () => {
    const { download } = serving(bytes);

    await expect(ensureBinary(spec({ sha256: "0".repeat(64) }), download)).rejects.toThrow(
      /failed its checksum.*refusing to run it/,
    );
    expect(existsSync(join(cacheDir(), "bin", "tool-1.0.0"))).toBe(false);
    // No half-built temporary directory left behind for a later run to trip on.
    expect(readdirSync(join(cacheDir(), "bin"))).toEqual([]);
  });

  it("extracts the named member when the release is a tarball", async () => {
    write("pack/tool", "#!/bin/sh\necho packed\n");
    write("pack/README", "not the binary\n");
    execFileSync("tar", ["-czf", join(dir, "tool.tar.gz"), "-C", join(dir, "pack"), "tool", "README"]);
    const tarball = readFileSync(join(dir, "tool.tar.gz"));

    const path = await ensureBinary(spec({ sha256: sha256(tarball), member: "tool" }), serving(tarball).download);

    expect(execFileSync(path, { encoding: "utf8" })).toBe("packed\n");
    expect(readdirSync(dirname(path))).toEqual(["tool"]);
  });

  it("reports a failed download without installing anything", async () => {
    const failing: Download = async () => {
      throw new Error("network is unreachable");
    };

    await expect(ensureBinary(spec({ sha256: "0".repeat(64) }), failing)).rejects.toThrow(/unreachable/);
    expect(existsSync(join(cacheDir(), "bin", "tool-1.0.0"))).toBe(false);
  });
});

describe("provisioning the community rules", () => {
  /** A tarball shaped like GitHub's codeload archive of the rules repo. */
  function rulesTarball(): Buffer {
    const top = `semgrep-rules-${SEMGREP_RULES.commit}`;
    for (const d of SEMGREP_RULES.dirs) write(`src/${top}/${d}/rule.yaml`, "rules: []\n");
    write(`src/${top}/javascript/express/open-redirect.yaml`, "rules:\n  - id: express-open-redirect\n");
    write(`src/${top}/javascript/express/open-redirect.js`, "// a test target, not a rule\n");
    write(`src/${top}/javascript/express/open-redirect.test.yaml`, "not: a rule\n");
    write(`src/${top}/python/flask.yaml`, "rules: []\n");
    execFileSync("tar", ["-czf", join(dir, "rules.tar.gz"), "-C", join(dir, "src"), top]);
    return readFileSync(join(dir, "rules.tar.gz"));
  }

  it("keeps only the pinned languages' rule files", async () => {
    const root = await ensureSemgrepRules(serving(rulesTarball()).download);

    expect(readdirSync(join(root, "javascript", "express"))).toEqual(["open-redirect.yaml"]);
    expect(existsSync(join(root, "python"))).toBe(false);
    expect(existsSync(join(root, "yaml", "github-actions", "rule.yaml"))).toBe(true);
  });

  it("asks for the pinned commit, and only once", async () => {
    const { download, calls } = serving(rulesTarball());

    await ensureSemgrepRules(download);
    await ensureSemgrepRules(download);

    expect(calls).toEqual([`https://codeload.github.com/semgrep/semgrep-rules/tar.gz/${SEMGREP_RULES.commit}`]);
  });
});

describe("the opengrep adapter", () => {
  it("loads only the rule sets for the kinds of file being checked", () => {
    expect(ruleDirsFor("api/app.ts")).toEqual(["javascript", "typescript"]);
    expect(ruleDirsFor("web/App.jsx")).toEqual(["javascript"]);
    expect(ruleDirsFor("infra/main.tf")).toEqual(["terraform"]);
    expect(ruleDirsFor("Dockerfile")).toEqual(["dockerfile"]);
    expect(ruleDirsFor("api/Dockerfile.prod")).toEqual(["dockerfile"]);
    expect(ruleDirsFor(".github/workflows/ci.yml")).toEqual(["yaml/github-actions"]);
    expect(ruleDirsFor("config/settings.yml")).toEqual([]);
    expect(ruleDirsFor("README.md")).toEqual([]);
  });

  /** Ids must match on every machine, or qa-ignore and corpus claims would not. */
  it("strips the machine-specific rules path from a rule id", () => {
    const root = "/Users/someone/.cache/agentic-qa/semgrep-rules/abc";

    expect(
      stableRuleId("Users.someone..cache.agentic-qa.semgrep-rules.abc.javascript.express.security.x", root),
    ).toBe("javascript.express.security.x");
  });

  it("counts a rule live only on the kinds of file its rule set covers", async () => {
    write("rules/javascript/express/security/redirect.yaml", "rules:\n  - id: express-open-redirect\n    message: x\n");
    const adapter = opengrep({ binary: "unused", rulesRoot: join(dir, "rules") });
    const rule = "javascript.express.security.express-open-redirect";

    await expect(adapter.isLive(dir, rule, "api/app.ts")).resolves.toBe(true);
    await expect(adapter.isLive(dir, rule, "infra/main.tf")).resolves.toBe(false);
    await expect(adapter.isLive(dir, "javascript.express.security.no-such-rule", "api/app.ts")).resolves.toBe(false);
  });

  it("is kept out of the per-edit hook's engines", () => {
    expect(defaultAdapters({ fast: true }).map((a) => a.tool)).not.toContain("opengrep");
    expect(defaultAdapters().map((a) => a.tool)).toContain("opengrep");
  });

  it("reports that it could not provision itself, rather than a clean run", async () => {
    const adapter = opengrep({ binary: "opengrep-that-does-not-exist", rulesRoot: join(dir, "rules") });
    mkdirSync(join(dir, "rules"), { recursive: true });

    await expect(adapter.run(dir, ["a.ts"])).resolves.toMatchObject({ status: "unavailable" });
  });
});

/**
 * The real engine on the real pinned rules, end to end. Uses what `setup` put in
 * the cache and never downloads; skipped where nothing is cached, never in CI.
 * Runs against the real cache, so it restores the default location first.
 */
const realCache = (() => {
  const saved = process.env.AGENTIC_QA_CACHE;
  delete process.env.AGENTIC_QA_CACHE;
  const ready = existsSync(binaryPath(OPENGREP)) && existsSync(semgrepRulesPath());
  if (saved !== undefined) process.env.AGENTIC_QA_CACHE = saved;
  return ready;
})();

function restoreRealCache(): void {
  if (previousCache === undefined) delete process.env.AGENTIC_QA_CACHE;
  else process.env.AGENTIC_QA_CACHE = previousCache;
}

describe.skipIf(!realCache && !process.env.CI)("opengrep on the pinned community rules", () => {
  beforeEach(restoreRealCache);

  it("finds a tainted redirect and a public bucket, with ids that do not depend on the machine", async () => {
    write(
      "api/app.ts",
      'import express from "express";\nconst app = express();\napp.get("/done", (req, res) => res.redirect(req.query.next as string));\n',
    );
    write("infra/main.tf", 'resource "aws_s3_bucket_acl" "b" {\n  bucket = "b"\n  acl    = "public-read"\n}\n');

    const run = await opengrep().run(dir, ["api/app.ts", "infra/main.tf"]);

    expect(run.status).toBe("ran");
    const rules = (run as Extract<ToolRun, { status: "ran" }>).findings.map((f) => `${f.file} ${f.rule}`);
    expect(rules).toContain("api/app.ts javascript.express.security.audit.express-open-redirect");
    expect(rules).toContain("infra/main.tf terraform.lang.security.s3-public-read-bucket");
  }, 120_000);
});
