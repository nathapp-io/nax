import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, type MockLogger, makeLogger, makeTempDir } from "@test/helpers";
import { readRepoNotes } from "@/memory";

const MTIME = new Date("2026-11-01T10:00:00.000Z");
const MINIMAL = `---\nslug: staging-db\ntype: project\ndescription: the staging database is shared; never reset it\n---\n\nAsk in #infra before running migrations against staging.\n`;

describe("readRepoNotes defaults", () => {
  let repoRoot: string;
  let logger: MockLogger;

  function writeNote(content: string, name = "staging-db.md"): string {
    const path = join(repoRoot, ".nax", "memory", name);
    writeFileSync(path, content);
    return path;
  }

  function warnings() {
    return logger.calls.filter((call) => call.level === "warn" && call.message === "repo note skipped");
  }

  beforeEach(() => {
    repoRoot = makeTempDir("nax-repo-note-defaults-");
    mkdirSync(join(repoRoot, ".nax", "memory"), { recursive: true });
    logger = makeLogger();
  });

  afterEach(() => cleanupTempDir(repoRoot));

  test("accepts the minimal note and defaults fixed fields from name and mtime", async () => {
    const path = writeNote(MINIMAL);
    utimesSync(path, MTIME, MTIME);
    const { notes } = await readRepoNotes({ repoRoot, logger });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      slug: "staging-db",
      id: "staging-db",
      scope: "project",
      status: "active",
      source: "repo",
      updatedAt: "2026-11-01T10:00:00.000Z",
    });
  });

  test("accepts a minimal CRLF note and applies defaults", async () => {
    writeNote(MINIMAL.replaceAll("\n", "\r\n"));

    const { notes } = await readRepoNotes({ repoRoot, logger });

    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ id: "staging-db", scope: "project", status: "active", source: "repo" });
  });

  test("preserves explicitly supplied id and updatedAt", async () => {
    const text = MINIMAL.replace("slug: staging-db", "id: team-1\nslug: staging-db").replace(
      "description: the staging",
      "updatedAt: 2026-01-01T00:00:00Z\ndescription: the staging",
    );
    writeNote(text);
    const { notes } = await readRepoNotes({ repoRoot, logger });
    expect(notes[0]).toMatchObject({ id: "team-1", updatedAt: "2026-01-01T00:00:00Z" });
  });

  test.each([
    ["scope", "user", "scope is not project"],
    ["status", "pending", "status is not active"],
  ])("skips invalid %s value", async (field, value, reason) => {
    writeNote(MINIMAL.replace("---\n\nAsk", `${field}: ${value}\n---\n\nAsk`));
    const { notes } = await readRepoNotes({ repoRoot, logger });
    expect(notes).toEqual([]);
    expect(warnings().map((call) => call.data?.reason)).toEqual([reason]);
  });

  test.each([
    ["slug: staging-db\ndescription: missing type", "type"],
    ["slug: staging-db\ntype: project", "description"],
  ])("rejects missing required field %s", async (fields, key) => {
    writeNote(`---\n${fields}\n---\n\nBody\n`);
    const { notes } = await readRepoNotes({ repoRoot, logger });
    expect(notes).toEqual([]);
    expect(warnings()[0]?.data?.reason).toMatch(new RegExp(`^invalid note:.*${key}`));
  });

  test("rejects missing slug", async () => {
    writeNote("---\ntype: project\ndescription: no slug\n---\n\nBody\n");
    const { notes } = await readRepoNotes({ repoRoot, logger });
    expect(notes).toEqual([]);
    expect(warnings()).toHaveLength(1);
  });

  test.each([
    "---\nslug: staging-db\ntype: project\ndescription: incomplete\n",
    "---\nslug: staging-db\ntype: project\ndescription: incomplete\n---\nBody\n",
  ])("retains malformed frontmatter refusal", async (text) => {
    writeNote(text);
    const { notes } = await readRepoNotes({ repoRoot, logger });
    expect(notes).toEqual([]);
    expect(warnings()[0]?.data?.reason).toMatch(/^invalid note:/);
  });
});
