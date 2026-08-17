/**
 * Shared nax gitignore entries.
 *
 * This list is the SSOT for what nax excludes in a USER's repo — `nax init`
 * appends it to .gitignore and WorktreeManager writes it to .git/info/exclude.
 * Editing the nax repo's own .gitignore protects nax and nobody else, so any
 * new runtime artifact has to land here too.
 */

import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fragmentPath } from "@/context";
import { NAX_GITIGNORE_ENTRIES, NAX_NAXIGNORE_ENTRIES, patchIgnoreFile } from "@/utils/gitignore";
import { journalDir } from "@/verification";
import { withTempDir } from "@test/helpers";

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

  test("the ignored fragments pattern is the directory fragmentPath writes into", () => {
    // Same pinning as the mutation journal above: fragments are rewritten by
    // every run, so moving the directory without updating the ignore list
    // would leave them committable in every user repo.
    const ignored = NAX_GITIGNORE_ENTRIES.find((e) => e.includes("fragments"));
    expect(ignored).toBeDefined();

    const produced = dirname(fragmentPath("/repo", "my-feature", "US-001"));
    const expanded = ignored?.replace("*", "my-feature").replace(/\/$/, "") ?? "";

    expect(produced).toBe(join("/repo", expanded));
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

describe("NAX_NAXIGNORE_ENTRIES", () => {
  test("hides nax's own state directory from the context engine", () => {
    // .nax/ holds prd.json, run logs and fragments. Feeding them back into the
    // context engine as if they were project source is pure noise.
    expect(NAX_NAXIGNORE_ENTRIES).toContain(".nax/");
  });

  test("entries are relative patterns — an absolute path would never match", () => {
    for (const entry of NAX_NAXIGNORE_ENTRIES) {
      expect(entry.startsWith("/")).toBe(false);
    }
  });

  test("no duplicate entries", () => {
    expect(new Set(NAX_NAXIGNORE_ENTRIES).size).toBe(NAX_NAXIGNORE_ENTRIES.length);
  });

  test("carries no commented lines — the suggestion block is written separately", () => {
    // Only active entries take part in re-run reconciliation. A commented entry
    // in this list would be re-appended on every init, since the reconciler
    // treats comments as absent.
    for (const entry of NAX_NAXIGNORE_ENTRIES) {
      expect(entry.startsWith("#")).toBe(false);
    }
  });
});

describe("patchIgnoreFile — creating a new file", () => {
  test("writes header, entries and footer when the file does not exist", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, ".naxignore");

      const result = await patchIgnoreFile(path, ["dist/", "build/"], {
        header: "# nax - scanning exclusions\n\n",
        footer: "\n# Uncomment what applies:\n# vendor/\n",
      });

      expect(result.created).toBe(true);
      expect(result.added).toEqual(["dist/", "build/"]);

      const content = await Bun.file(path).text();
      expect(content).toBe("# nax - scanning exclusions\n\ndist/\nbuild/\n\n# Uncomment what applies:\n# vendor/\n");
    });
  });

  test("labels the entries with the section comment when no header is supplied", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, ".gitignore");

      await patchIgnoreFile(path, ["dist/"]);

      // A bare list of paths in a fresh .gitignore gives the reader no clue
      // where it came from or that it is safe to re-run init.
      const content = await Bun.file(path).text();
      expect(content.startsWith("#")).toBe(true);
      expect(content).toContain("dist/");
    });
  });

  test("treats a whitespace-only existing file as new rather than appending to blank lines", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, ".naxignore");
      await Bun.write(path, "\n\n  \n");

      const result = await patchIgnoreFile(path, ["dist/"], { header: "# nax\n\n" });

      expect(result.created).toBe(true);
      expect(await Bun.file(path).text()).toBe("# nax\n\ndist/\n");
    });
  });
});

describe("patchIgnoreFile — patching an existing file", () => {
  test("appends only the missing entries and preserves user content verbatim", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, ".gitignore");
      await Bun.write(path, "node_modules/\ndist/\n");

      const result = await patchIgnoreFile(path, ["dist/", "coverage/"], { sectionComment: "# nax" });

      expect(result.created).toBe(false);
      expect(result.added).toEqual(["coverage/"]);

      const content = await Bun.file(path).text();
      expect(content.startsWith("node_modules/\ndist/\n")).toBe(true);
      expect(content).toContain("coverage/");
      // "dist/" was already active — it must not be duplicated.
      expect(content.split("\n").filter((l) => l === "dist/")).toHaveLength(1);
    });
  });

  test("does not write the header or footer again when patching", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, ".naxignore");
      await Bun.write(path, "# nax - scanning exclusions\n\ndist/\n");

      await patchIgnoreFile(path, ["dist/", "coverage/"], {
        header: "# nax - scanning exclusions\n\n",
        footer: "\n# Uncomment what applies:\n# vendor/\n",
      });

      const content = await Bun.file(path).text();
      expect(content.split("# nax - scanning exclusions")).toHaveLength(2);
      expect(content).not.toContain("# Uncomment what applies:");
    });
  });

  test("is a no-op when every entry is already active", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, ".gitignore");
      const original = "node_modules/\ndist/\n";
      await Bun.write(path, original);

      const result = await patchIgnoreFile(path, ["dist/"]);

      expect(result.created).toBe(false);
      expect(result.added).toEqual([]);
      expect(await Bun.file(path).text()).toBe(original);
    });
  });

  test("separates the appended section from a file that lacks a trailing newline", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, ".gitignore");
      await Bun.write(path, "node_modules/");

      await patchIgnoreFile(path, ["dist/"], { sectionComment: "# nax" });

      const lines = (await Bun.file(path).text()).split("\n");
      // Without the guard, "node_modules/" and the section comment would merge
      // into a single line and neither pattern would work.
      expect(lines).toContain("node_modules/");
      expect(lines).toContain("dist/");
    });
  });
});

describe("patchIgnoreFile — entry matching", () => {
  test("appends an entry that is present only as a comment", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, ".gitignore");
      // A user who deliberately commented the entry out still gets it back on
      // init; a naive substring scan would read this as "already present" and
      // silently never apply the rule.
      await Bun.write(path, "# dist/\n");

      const result = await patchIgnoreFile(path, ["dist/"]);

      expect(result.added).toEqual(["dist/"]);
      const active = (await Bun.file(path).text())
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));
      expect(active).toContain("dist/");
    });
  });

  test("appends an entry that only appears as a substring of a longer path", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, ".gitignore");
      // "dist/" is a substring of "packages/dist/cache" but the standalone
      // rule is absent, so it must still be added.
      await Bun.write(path, "packages/dist/cache\n");

      const result = await patchIgnoreFile(path, ["dist/"]);

      expect(result.added).toEqual(["dist/"]);
    });
  });

  test("does not re-add an entry the user explicitly negated", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, ".naxignore");
      // "!dist/" means the user deliberately wants dist/ scanned. Appending
      // "dist/" below it would silently win — later rules take precedence in
      // gitignore syntax — reversing an explicit choice on every init.
      await Bun.write(path, "!dist/\n");

      const result = await patchIgnoreFile(path, ["dist/"]);

      expect(result.added).toEqual([]);
      expect(await Bun.file(path).text()).toBe("!dist/\n");
    });
  });

  test("still adds an entry when an unrelated path is negated", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, ".naxignore");
      await Bun.write(path, "!build/\n");

      const result = await patchIgnoreFile(path, ["dist/"]);

      expect(result.added).toEqual(["dist/"]);
    });
  });

  test("matches an existing entry despite surrounding whitespace", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, ".gitignore");
      await Bun.write(path, "  dist/  \n");

      const result = await patchIgnoreFile(path, ["dist/"]);

      expect(result.added).toEqual([]);
    });
  });
});
