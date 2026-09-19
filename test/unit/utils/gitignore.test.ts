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
import { withTempDir } from "@test/helpers";
import { fragmentPath } from "@/context";
import { NAX_GITIGNORE_ENTRIES, NAX_NAXIGNORE_ENTRIES, patchIgnoreFile } from "@/utils/gitignore";
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

  test("the ignored fragments pattern is the directory fragmentPath writes into", () => {
    // Same pinning as the mutation journal above: fragments are rewritten by
    // every run, so moving the directory without updating the ignore list
    // would leave them committable in every user repo.
    const ignored = NAX_GITIGNORE_ENTRIES.find((e) => e.includes("fragments"));
    expect(ignored).toBeDefined();

    const produced = dirname(fragmentPath("/repo", "my-feature", "US-001"));
    // The `**/` prefix makes the rule reach a monorepo package's own .nax/;
    // strip it to compare against the repo-root path fragmentPath produces.
    const expanded = (ignored ?? "")
      .replace(/^\*\*\//, "")
      .replace("*", "my-feature")
      .replace(/\/$/, "");

    expect(produced).toBe(join("/repo", expanded));
  });

  test("covers the scratchpad directory with a nested-worktree pattern (US-004)", () => {
    // The scratchpad tools write throwaway files there (src/tools/scratchpad.ts).
    // US-004 AC4 pins the entry exactly as written: the `**/` prefix is what
    // keeps a monorepo package's own scratchpad out of the story worktree
    // commit, and dropping it lands the story branch in the merge-back abort
    // described on `**/.nax/cache/` (nax#2136/#2137).
    expect(NAX_GITIGNORE_ENTRIES).toContain("**/.nax/scratchpad/");
    expect(NAX_GITIGNORE_ENTRIES).not.toContain(".nax/scratchpad/");
  });

  test("entries are relative patterns — an absolute path would never match", () => {
    for (const entry of NAX_GITIGNORE_ENTRIES) {
      expect(entry.startsWith("/")).toBe(false);
    }
  });

  test("no duplicate entries", () => {
    expect(new Set(NAX_GITIGNORE_ENTRIES).size).toBe(NAX_GITIGNORE_ENTRIES.length);
  });

  test("git ignores nax's run artifacts and caches, but not a feature's committed spec and prd", async () => {
    // Asked of git itself rather than of the list, because the failures this
    // pins were invisible in the list: a blanket `<features>/*/` entry reads as
    // one more artifact rule, and only git reveals that it also swallows
    // spec.md and prd.json — silently, since git never reports ignored files.
    // The same blindness hid a missing entry entirely (nax#2137): the
    // detection cache documented itself as gitignored while nothing covered it.
    await withTempDir(async (dir) => {
      Bun.spawnSync(["git", "init", "-q", dir], { cwd: dir });
      await Bun.write(join(dir, ".gitignore"), `${NAX_GITIGNORE_ENTRIES.join("\n")}\n`);

      const isIgnored = (path: string) =>
        Bun.spawnSync(["git", "check-ignore", "-q", path], { cwd: dir }).exitCode === 0;
      const expectIgnored = (path: string, want: boolean) =>
        expect(`${path}: ${isIgnored(path)}`).toBe(`${path}: ${want}`);

      const feature = ".nax/features/my-feature";
      for (const committed of ["spec.md", "prd.json", "prd-fidelity-report.md", "acceptance-meta.json"]) {
        expectIgnored(`${feature}/${committed}`, false);
      }
      for (const artifact of ["status.json", "progress.txt", "plan/x.jsonl", "fragments/US-001.md", "prd.json.bak"]) {
        expectIgnored(`${feature}/${artifact}`, true);
      }

      // Derived caches. nax#2137: `.nax/cache/test-patterns.json` is written per
      // workdir by src/test-runners/detect/cache.ts. Under storyIsolation
      // "worktree" an unignored copy lands untracked in the main checkout and
      // committed inside the story worktree, so the merge back aborts on an
      // untracked overwrite and strands nax/<storyId> (nax#2136).
      expectIgnored(".nax/cache/test-patterns.json", true);

      // The scratchpad (US-004): throwaway files the agent writes during a
      // session. Same worktree hazard as the cache above, and the same reason
      // the rule carries a `**/` prefix.
      expectIgnored(".nax/scratchpad/notes.md", true);

      // Same rules must hold for a monorepo package's own .nax/, which is where
      // nax writes when a story carries a workdir — and is the case that breaks.
      expectIgnored(`packages/api/${feature}/spec.md`, false);
      expectIgnored(`packages/api/${feature}/status.json`, true);
      expectIgnored("packages/lib/.nax/cache/test-patterns.json", true);
      expectIgnored("packages/lib/.nax/scratchpad/notes.md", true);
    });
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
