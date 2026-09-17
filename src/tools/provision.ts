import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * External tools this package needs but npm cannot install: scanner binaries
 * and the community rules they run. Each is pinned — a binary by version and
 * SHA-256, the rules by git commit — and downloaded on first use into a
 * per-machine cache, so a new machine or a CI runner sets itself up and every
 * machine runs exactly the same thing.
 *
 * The rules are downloaded rather than committed on purpose. Semgrep's rules
 * license permits use for your own purposes but not distribution, and this
 * repository is public: vendoring them here would be distributing them.
 */

export function cacheDir(): string {
  if (process.env.AGENTIC_QA_CACHE) return process.env.AGENTIC_QA_CACHE;
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "agentic-qa");
}

type Platform = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64";

function platform(): Platform | undefined {
  const key = `${process.platform}-${process.arch}`;
  return (["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const).find((p) => p === key);
}

interface Asset {
  url: string;
  sha256: string;
  /** Present when the asset is a tarball; the member to extract. */
  member?: string;
}

export interface BinarySpec {
  name: string;
  version: string;
  assets: Record<Platform, Asset>;
}

export const OPENGREP: BinarySpec = {
  name: "opengrep",
  version: "1.30.0",
  assets: {
    "darwin-arm64": {
      url: "https://github.com/opengrep/opengrep/releases/download/v1.30.0/opengrep_osx_arm64",
      sha256: "0f5bc3dec09d995c61331a4017b856ede508f90d95b018d95f1dc6166be89fdd",
    },
    "darwin-x64": {
      url: "https://github.com/opengrep/opengrep/releases/download/v1.30.0/opengrep_osx_x86",
      sha256: "650772a849a2986880982b7dea0371f96a75d354de95f94e8c1a2e6f8f6262d1",
    },
    "linux-x64": {
      url: "https://github.com/opengrep/opengrep/releases/download/v1.30.0/opengrep_manylinux_x86",
      sha256: "35779bdd72e92129c8df2a77f0c55e8c08356801ea92591ef32108d6b28d564c",
    },
    "linux-arm64": {
      url: "https://github.com/opengrep/opengrep/releases/download/v1.30.0/opengrep_manylinux_aarch64",
      sha256: "a5d5a4a58ba5d46ff51e921663da1c2bba38f4b03987f4aeec87f16c6ad3ecae",
    },
  },
};

/** Must match the version config/gitleaks.toml was vendored from. */
export const GITLEAKS: BinarySpec = {
  name: "gitleaks",
  version: "8.30.1",
  assets: {
    "darwin-arm64": {
      url: "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_darwin_arm64.tar.gz",
      sha256: "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
      member: "gitleaks",
    },
    "darwin-x64": {
      url: "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_darwin_x64.tar.gz",
      sha256: "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
      member: "gitleaks",
    },
    "linux-x64": {
      url: "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz",
      sha256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
      member: "gitleaks",
    },
    "linux-arm64": {
      url: "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_arm64.tar.gz",
      sha256: "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
      member: "gitleaks",
    },
  },
};

/** The semgrep community rules, pinned by commit. */
export const SEMGREP_RULES = {
  commit: "40b8c63f75dc7c22c8a77482d73bfb864b146f7e",
  /** Only the languages the target stack uses; the rest would only cost load time. */
  dirs: ["javascript", "typescript", "terraform", "dockerfile", "yaml/github-actions"],
};

export type Download = (url: string) => Promise<Buffer>;

export const httpDownload: Download = async (url) => {
  if (process.env.AGENTIC_QA_NO_DOWNLOAD) {
    throw new Error(`downloads are disabled (AGENTIC_QA_NO_DOWNLOAD), not fetching ${url}`);
  }
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url}`);
  return Buffer.from(await res.arrayBuffer());
};

/**
 * Builds into a private temporary directory and renames it into place. A rename
 * is atomic, so a crash mid-download never leaves a half-installed tool that
 * later runs would trust, and two processes provisioning at once cannot see
 * each other's partial work.
 */
async function installAtomically(target: string, build: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(tmp, { recursive: true });
  try {
    await build(tmp);
    try {
      renameSync(tmp, target);
    } catch (err) {
      // Someone else finished first. Theirs is as good as ours.
      if (!existsSync(target)) throw err;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Where a pinned binary lives once provisioned, whether or not it is there yet. */
export function binaryPath(spec: BinarySpec): string {
  return join(cacheDir(), "bin", `${spec.name}-${spec.version}`, spec.name);
}

/** Where the pinned rules live once provisioned, whether or not they are there yet. */
export function semgrepRulesPath(): string {
  return join(cacheDir(), "semgrep-rules", SEMGREP_RULES.commit);
}

/** The path to a pinned binary, downloading and verifying it on first use. */
export async function ensureBinary(spec: BinarySpec, download: Download = httpDownload): Promise<string> {
  const current = platform();
  if (!current) {
    throw new Error(`no pinned ${spec.name} build for ${process.platform}-${process.arch}`);
  }
  const asset = spec.assets[current];
  const binary = binaryPath(spec);
  const dir = dirname(binary);
  if (existsSync(binary)) return binary;

  await installAtomically(dir, async (tmp) => {
    const bytes = await download(asset.url);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== asset.sha256) {
      throw new Error(
        `${spec.name} ${spec.version} failed its checksum (expected ${asset.sha256}, got ${actual}); refusing to run it`,
      );
    }
    if (asset.member) {
      const archive = join(tmp, "download.tar.gz");
      writeFileSync(archive, bytes);
      await run("tar", ["-xzf", archive, "-C", tmp, asset.member]);
      rmSync(archive);
    } else {
      writeFileSync(join(tmp, spec.name), bytes);
    }
    chmodSync(join(tmp, spec.name), 0o755);
  });
  return binary;
}

/** Keeps rule files only: the rules repo mixes in test targets and fixtures. */
function pruneToRules(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      pruneToRules(path);
    } else if (!/\.ya?ml$/.test(entry) || /\.test\.ya?ml$/.test(entry)) {
      rmSync(path);
    }
  }
}

/** The root of the pinned community rules, downloading them on first use. */
export async function ensureSemgrepRules(download: Download = httpDownload): Promise<string> {
  const { commit, dirs } = SEMGREP_RULES;
  const root = semgrepRulesPath();
  if (existsSync(root)) return root;

  await installAtomically(root, async (tmp) => {
    const bytes = await download(`https://codeload.github.com/semgrep/semgrep-rules/tar.gz/${commit}`);
    const archive = join(tmp, "rules.tar.gz");
    writeFileSync(archive, bytes);
    const top = `semgrep-rules-${commit}`;
    await run("tar", ["-xzf", archive, "-C", tmp, ...dirs.map((d) => `${top}/${d}`)]);
    rmSync(archive);
    for (const d of readdirSync(join(tmp, top))) {
      renameSync(join(tmp, top, d), join(tmp, d));
    }
    rmSync(join(tmp, top), { recursive: true });
    pruneToRules(tmp);
  });
  return root;
}
