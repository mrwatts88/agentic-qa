import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The guide: how software should be built, in prose, one chapter per area. It
 * is the corpus. Mechanical rules delegate parts of it to engines; the rest is
 * read by the agent before it works and by the review after.
 */

export interface Chapter {
  /** File name within the guide directory, e.g. `05-auth-and-security.md`. */
  file: string;
  title: string;
  summary: string;
  /** The kind of work this chapter applies to. */
  readWhen: string;
}

export function bundledGuideDir(): string {
  return fileURLToPath(new URL("../guide", import.meta.url));
}

const CHAPTER = /^\d{2}-[a-z0-9-]+\.md$/;

/**
 * Strict, like the rules loader: a chapter without its header would silently
 * vanish from the index the agent reads, which is a part of the guide nobody
 * is steered to while everyone believes they are.
 */
export function loadGuide(dir = bundledGuideDir()): Chapter[] {
  return readdirSync(dir)
    .filter((file) => CHAPTER.test(file))
    .sort()
    .map((file) => {
      const lines = readFileSync(join(dir, file), "utf8").split("\n");
      const title = lines[0]?.match(/^# (.+)$/)?.[1];
      const summary = lines.find((l) => /^\*[^*].*\*$/.test(l))?.slice(1, -1);
      const readWhen = lines.find((l) => l.startsWith("**Read when:** "))?.slice("**Read when:** ".length);
      if (!title || !summary || !readWhen) {
        throw new Error(
          `guide/${file}: a chapter must start with "# Title", an italic summary line and a "**Read when:**" line`,
        );
      }
      return { file, title, summary, readWhen };
    });
}
