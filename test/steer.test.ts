import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledGuideDir, loadGuide } from "../src/guide";
import { guideIndex } from "../src/steer";

describe("the shipped guide", () => {
  const chapters = loadGuide();

  it("loads every chapter with the header the index is built from", () => {
    expect(chapters.length).toBeGreaterThanOrEqual(12);
  });

  const index = guideIndex(chapters, bundledGuideDir());

  it("indexes every chapter, by file, with when to read it", () => {
    const missing = chapters.filter((c) => !index.includes(`${c.file} (${c.title}). Read when ${c.readWhen}`));

    expect(missing.map((c) => c.file)).toEqual([]);
  });

  it("tells the agent where the chapters are", () => {
    expect(index).toContain(bundledGuideDir());
  });

  /**
   * Read at the start of every session, and read carefully only while short.
   * It grows by chapter, never by rule: about 200 characters a chapter. Past
   * this, the answer is grouping chapters, not raising the number.
   */
  it("stays short enough to be read", () => {
    expect(index.length).toBeLessThan(4_000);
  });
});

describe("loadGuide", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentic-qa-guide-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A chapter missing from the index is guidance nobody is steered to. */
  it("refuses a chapter without its header, rather than leaving it out", () => {
    writeFileSync(join(dir, "01-orphan.md"), "# Orphan\n\nNo summary or read-when line.\n");

    expect(() => loadGuide(dir)).toThrow("guide/01-orphan.md");
  });

  it("reads only numbered chapters, not a README beside them", () => {
    writeFileSync(join(dir, "README.md"), "# About\n");
    writeFileSync(join(dir, "01-a.md"), "# A\n\n*Summary.*\n\n**Read when:** always.\n");

    expect(loadGuide(dir).map((c) => c.file)).toEqual(["01-a.md"]);
  });
});
