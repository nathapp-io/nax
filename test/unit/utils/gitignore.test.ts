/**
 * Shared nax gitignore entries.
 *
 * This list is the SSOT for what nax excludes in a USER's repo — `nax init`
 * appends it to .gitignore and WorktreeManager writes it to .git/info/exclude.
 * Editing the nax repo's own .gitignore protects nax and nobody else, so any
 * new runtime artifact has to land here too.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { NAX_GITIGNORE_ENTRIES } from "@/utils/gitignore";
import { journalDir } from "@/verification";

describe("NAX_GITIGNORE_ENTRIES", () => {
  test("covers the mutation journal directory", () => {
    expect(NAX_GITIGNORE_ENTRIES).toContain(".nax/mutation-journal/");
  });

  test("the ignored path is the one journalDir actually writes to", () => {
    // Pins the two together: renaming the directory without updating the
    // ignore list would leave a journal committable in every user repo.
    const produced = journalDir("/repo");
    const ignored = NAX_GITIGNORE_ENTRIES.find((e) => e.includes("mutation-journal"));

    expect(ignored).toBeDefined();
    expect(produced).toBe(join("/repo", ignored?.replace(/\/$/, "") ?? ""));
  });

  test("entries are relative patterns — an absolute path would never match", () => {
    for (const entry of NAX_GITIGNORE_ENTRIES) {
      expect(entry.startsWith("/")).toBe(false);
    }
  });

  test("no duplicate entries", () => {
    expect(new Set(NAX_GITIGNORE_ENTRIES).size).toBe(NAX_GITIGNORE_ENTRIES.length);
  });
});
