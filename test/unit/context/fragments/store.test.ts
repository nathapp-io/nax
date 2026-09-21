/**
 * US-001: Fragment store — write/read/list/delete CRUD
 *
 * AC 6–12 cover the runtime behaviour of the fragment store.
 *
 * Layout: <projectDir>/.nax/features/<featureId>/fragments/<storyId>.md
 *
 * Truncation: when the configured `maxTokens` budget is exceeded, the
 * subsequently-read body must be no longer than that budget. Token counting
 * uses the project's `estimateTokens` heuristic (one token ≈ 4 chars of body).
 *
 * The deps mirror `_manifestStoreDeps` from `manifest-store.ts` so tests can
 * inject an in-memory file system without touching `Bun.file` or `Bun.write`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, withDepsRestore } from "@test/helpers";
import {
  _fragmentStoreDeps,
  deleteFragment,
  fragmentPath,
  listFragmentStoryIds,
  readFragment,
  renderFragmentBody,
  truncateToFragmentBudget,
  writeFragment,
} from "@/context/fragments";

withDepsRestore(_fragmentStoreDeps);

describe("fragment store — writeFragment / readFragment (US-001)", () => {
  test("[US-001 AC 6] readFragment returns the body that writeFragment stored", async () => {
    const writes = new Map<string, string>();

    _fragmentStoreDeps.mkdirp = async () => undefined;
    _fragmentStoreDeps.writeFile = async (path, content) => {
      writes.set(path, content);
    };
    _fragmentStoreDeps.fileExists = async (path) => writes.has(path);
    _fragmentStoreDeps.readFile = async (path) => writes.get(path) ?? "";
    _fragmentStoreDeps.listFragments = async () => [];
    _fragmentStoreDeps.removeFile = async () => undefined;

    const body = "Hello, fragment world.\nSecond line.";
    await writeFragment("/repo", "feat-auth", "US-001", body, 400);

    const read = await readFragment("/repo", "feat-auth", "US-001");
    expect(read).toBe(body);
  });

  test("[US-001 AC 7] readFragment returns null for a story with no fragment", async () => {
    _fragmentStoreDeps.fileExists = async () => false;
    _fragmentStoreDeps.readFile = async () => "";

    const read = await readFragment("/repo", "feat-auth", "US-NONE");
    expect(read).toBeNull();
  });

  test("[US-001 AC 12] writeFragment overwrites the prior body for the same story", async () => {
    const writes = new Map<string, string>();

    _fragmentStoreDeps.mkdirp = async () => undefined;
    _fragmentStoreDeps.writeFile = async (path, content) => {
      writes.set(path, content);
    };
    _fragmentStoreDeps.fileExists = async (path) => writes.has(path);
    _fragmentStoreDeps.readFile = async (path) => writes.get(path) ?? "";
    _fragmentStoreDeps.listFragments = async () => [];
    _fragmentStoreDeps.removeFile = async () => undefined;

    const first = "First body";
    const second = "Second body — completely different content.";

    await writeFragment("/repo", "feat-auth", "US-001", first, 400);
    await writeFragment("/repo", "feat-auth", "US-001", second, 400);

    const read = await readFragment("/repo", "feat-auth", "US-001");
    expect(read).toBe(second);
    expect(read).not.toBe(first);
  });

  test("[US-001 AC 8] writeFragment truncates the body when it exceeds maxTokens", async () => {
    const writes = new Map<string, string>();

    _fragmentStoreDeps.mkdirp = async () => undefined;
    _fragmentStoreDeps.writeFile = async (path, content) => {
      writes.set(path, content);
    };
    _fragmentStoreDeps.fileExists = async (path) => writes.has(path);
    _fragmentStoreDeps.readFile = async (path) => writes.get(path) ?? "";
    _fragmentStoreDeps.listFragments = async () => [];
    _fragmentStoreDeps.removeFile = async () => undefined;

    // maxTokens = 4 → budget = 4 tokens ≈ 16 chars. Write 200 chars.
    const longBody = "a".repeat(200);
    await writeFragment("/repo", "feat-auth", "US-001", longBody, 4);

    const read = await readFragment("/repo", "feat-auth", "US-001");
    expect(read).not.toBeNull();
    // Conservative: the read body is bounded by the same budget readFragment would apply.
    expect(read?.length ?? 0).toBeLessThanOrEqual(16);
  });

  test("writeFragment builds the path under <projectDir>/.nax/features/<featureId>/fragments/<storyId>.md", () => {
    expect(fragmentPath("/repo", "feat-auth", "US-001")).toBe("/repo/.nax/features/feat-auth/fragments/US-001.md");
  });

  test("writeFragment creates the fragments dir before writing", async () => {
    const mkdirArgs: string[] = [];
    _fragmentStoreDeps.mkdirp = async (path) => {
      mkdirArgs.push(path);
      return undefined;
    };
    _fragmentStoreDeps.writeFile = async () => undefined;
    _fragmentStoreDeps.listFragments = async () => [];
    _fragmentStoreDeps.removeFile = async () => undefined;

    await writeFragment("/repo", "feat-auth", "US-001", "body", 400);
    expect(mkdirArgs).toContain("/repo/.nax/features/feat-auth/fragments");
  });
});

describe("fragment store — listFragmentStoryIds (US-001)", () => {
  test("[US-001 AC 9] listFragmentStoryIds returns both story ids when two fragments exist", async () => {
    _fragmentStoreDeps.directoryExists = async () => true;
    _fragmentStoreDeps.listFragments = async () => ["US-001.md", "US-002.md"];

    const ids = await listFragmentStoryIds("/repo", "feat-auth");
    expect(ids).toEqual(["US-001", "US-002"]);
  });

  test("listFragmentStoryIds returns [] when no fragments exist", async () => {
    _fragmentStoreDeps.directoryExists = async () => true;
    _fragmentStoreDeps.listFragments = async () => [];
    const ids = await listFragmentStoryIds("/repo", "feat-auth");
    expect(ids).toEqual([]);
  });

  test("listFragmentStoryIds returns [] when the fragments dir has not been created yet (cold start)", async () => {
    let listCalled = false;
    _fragmentStoreDeps.directoryExists = async () => false;
    _fragmentStoreDeps.listFragments = async () => {
      listCalled = true;
      return [];
    };

    const ids = await listFragmentStoryIds("/repo", "feat-auth");
    expect(ids).toEqual([]);
    expect(listCalled).toBe(false);
  });

  test("listFragmentStoryIds propagates I/O errors from the scan", async () => {
    _fragmentStoreDeps.directoryExists = async () => true;
    _fragmentStoreDeps.listFragments = async () => {
      throw new Error("EACCES: permission denied");
    };

    await expect(listFragmentStoryIds("/repo", "feat-auth")).rejects.toThrow("EACCES");
  });

  test("listFragmentStoryIds strips the .md suffix", async () => {
    _fragmentStoreDeps.directoryExists = async () => true;
    _fragmentStoreDeps.listFragments = async () => ["US-abc-1.md", "story-with-dashes.md"];
    const ids = await listFragmentStoryIds("/repo", "feat-auth");
    expect(ids).toEqual(["US-abc-1", "story-with-dashes"]);
  });
});

describe("fragment store — path-segment validation (US-001)", () => {
  test("fragmentPath rejects featureId containing '..'", () => {
    expect(() => fragmentPath("/repo", "../etc", "US-001")).toThrow(/featureId/);
  });

  test("fragmentPath rejects featureId containing a slash", () => {
    expect(() => fragmentPath("/repo", "feat/other", "US-001")).toThrow(/featureId/);
  });

  test("fragmentPath rejects featureId containing a backslash", () => {
    expect(() => fragmentPath("/repo", "feat\\other", "US-001")).toThrow(/featureId/);
  });

  test("fragmentPath rejects featureId equal to '.'", () => {
    expect(() => fragmentPath("/repo", ".", "US-001")).toThrow(/featureId/);
  });

  test("fragmentPath rejects empty featureId", () => {
    expect(() => fragmentPath("/repo", "", "US-001")).toThrow(/featureId/);
  });

  test("fragmentPath rejects storyId containing '..' before the .md suffix", () => {
    expect(() => fragmentPath("/repo", "feat-auth", "../etc/passwd")).toThrow(/storyId/);
  });

  test("fragmentPath rejects storyId containing a forward slash", () => {
    expect(() => fragmentPath("/repo", "feat-auth", "US/001")).toThrow(/storyId/);
  });

  test("fragmentPath rejects storyId containing a NUL byte", () => {
    expect(() => fragmentPath("/repo", "feat-auth", "US\u0000bad")).toThrow(/storyId/);
  });

  test("writeFragment rejects a traversal featureId before touching disk", async () => {
    let writeCalled = false;
    _fragmentStoreDeps.mkdirp = async () => undefined;
    _fragmentStoreDeps.writeFile = async () => {
      writeCalled = true;
    };
    _fragmentStoreDeps.fileExists = async () => false;
    _fragmentStoreDeps.listFragments = async () => [];
    _fragmentStoreDeps.removeFile = async () => undefined;

    await expect(writeFragment("/repo", "../etc", "US-001", "body", 400)).rejects.toThrow(/featureId/);
    expect(writeCalled).toBe(false);
  });

  test("readFragment rejects a traversal featureId before touching disk", async () => {
    let readCalled = false;
    _fragmentStoreDeps.fileExists = async () => {
      readCalled = true;
      return false;
    };
    _fragmentStoreDeps.readFile = async () => "";
    _fragmentStoreDeps.listFragments = async () => [];
    _fragmentStoreDeps.removeFile = async () => undefined;

    await expect(readFragment("/repo", "../etc", "US-001")).rejects.toThrow(/featureId/);
    expect(readCalled).toBe(false);
  });

  test("deleteFragment rejects a traversal storyId before touching disk", async () => {
    let removeCalled = false;
    _fragmentStoreDeps.fileExists = async () => false;
    _fragmentStoreDeps.removeFile = async () => {
      removeCalled = true;
    };
    _fragmentStoreDeps.listFragments = async () => [];

    await expect(deleteFragment("/repo", "feat-auth", "../escape")).rejects.toThrow(/storyId/);
    expect(removeCalled).toBe(false);
  });
});

describe("fragment store — deleteFragment (US-001)", () => {
  test("[US-001 AC 10] deleteFragment removes the file so a subsequent readFragment returns null", async () => {
    const writes = new Map<string, string>();
    const path = "/repo/.nax/features/feat-auth/fragments/US-001.md";
    writes.set(path, "old body");

    _fragmentStoreDeps.mkdirp = async () => undefined;
    _fragmentStoreDeps.writeFile = async (p, content) => {
      writes.set(p, content);
    };
    _fragmentStoreDeps.fileExists = async (p) => writes.has(p);
    _fragmentStoreDeps.readFile = async (p) => writes.get(p) ?? "";
    _fragmentStoreDeps.listFragments = async () => [];
    _fragmentStoreDeps.removeFile = async (p) => {
      writes.delete(p);
    };

    await deleteFragment("/repo", "feat-auth", "US-001");
    const read = await readFragment("/repo", "feat-auth", "US-001");
    expect(read).toBeNull();
  });

  test("[US-001 AC 11] deleteFragment completes without raising when the fragment does not exist", async () => {
    let removeCalled = false;
    _fragmentStoreDeps.fileExists = async () => false;
    _fragmentStoreDeps.removeFile = async () => {
      removeCalled = true;
    };

    await expect(deleteFragment("/repo", "feat-auth", "US-MISSING")).resolves.toBeUndefined();
    expect(removeCalled).toBe(false);
  });

  test("deleteFragment removes only the targeted story fragment", async () => {
    const writes = new Map<string, string>();
    const target = "/repo/.nax/features/feat-auth/fragments/US-001.md";
    const other = "/repo/.nax/features/feat-auth/fragments/US-002.md";
    writes.set(target, "remove me");
    writes.set(other, "keep me");

    _fragmentStoreDeps.mkdirp = async () => undefined;
    _fragmentStoreDeps.writeFile = async (p, content) => {
      writes.set(p, content);
    };
    _fragmentStoreDeps.fileExists = async (p) => writes.has(p);
    _fragmentStoreDeps.readFile = async (p) => writes.get(p) ?? "";
    _fragmentStoreDeps.listFragments = async () => [];
    _fragmentStoreDeps.removeFile = async (p) => {
      writes.delete(p);
    };

    await deleteFragment("/repo", "feat-auth", "US-001");

    const read1 = await readFragment("/repo", "feat-auth", "US-001");
    const read2 = await readFragment("/repo", "feat-auth", "US-002");
    expect(read1).toBeNull();
    expect(read2).toBe("keep me");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fragment store — real-filesystem behaviour
//
// The in-memory `_fragmentStoreDeps` tests above are why the production read
// path could ship broken: `fileExists` was `Bun.file(path).exists()`, and
// `Bun.file(dir).exists()` is `false` for a directory, so `listFragmentStoryIds`
// always returned `[]` against a real disk. The feature's own acceptance test
// documented the defect in a comment and stubbed around it rather than failing.
//
// These tests therefore use the REAL deps against a REAL temp directory. Do
// not add dep injection here — that would reintroduce the blind spot.
// ─────────────────────────────────────────────────────────────────────────────

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

describe("fragment store — real filesystem", () => {
  const FEATURE_ID = "feat-fragments";
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempDir();
  });

  afterEach(() => {
    cleanupTempDir(projectDir);
  });

  test("listFragmentStoryIds returns the ids of fragments written to disk", async () => {
    await writeFragment(projectDir, FEATURE_ID, "US-001", "first", 400);
    await writeFragment(projectDir, FEATURE_ID, "US-002", "second", 400);

    expect(await listFragmentStoryIds(projectDir, FEATURE_ID)).toEqual(["US-001", "US-002"]);
  });

  test("listFragmentStoryIds returns an empty list when the feature has no fragments dir", async () => {
    expect(await listFragmentStoryIds(projectDir, "never-captured")).toEqual([]);
  });

  test("readFragment round-trips a body written to disk", async () => {
    await writeFragment(projectDir, FEATURE_ID, "US-001", "body text", 400);

    expect(await readFragment(projectDir, FEATURE_ID, "US-001")).toBe("body text");
  });

  /**
   * The read and write paths share `fragmentPath`, so a wrong base directory is
   * invisible to a round-trip assertion — it stays self-consistent while landing
   * the file outside `.nax/`. That is exactly how fragments shipped writing to a
   * stray top-level `features/` dir, where no `.nax`-scoped gitignore entry
   * covered them and a run's auto-commit swept them into the user's repo. These
   * two tests pin the absolute location, not the round trip.
   */
  test("writeFragment stores the fragment under .nax/features, alongside manifests", async () => {
    await writeFragment(projectDir, FEATURE_ID, "US-001", "body text", 400);

    const expected = join(projectDir, ".nax", "features", FEATURE_ID, "fragments", "US-001.md");
    expect(await Bun.file(expected).exists()).toBe(true);
  });

  test("writeFragment does not create a top-level features/ directory in the repo", async () => {
    await writeFragment(projectDir, FEATURE_ID, "US-001", "body text", 400);

    expect(await dirExists(join(projectDir, "features"))).toBe(false);
  });
});

describe("renderFragmentBody — section order", () => {
  test("lists the touched files before the acceptance criteria", () => {
    const body = renderFragmentBody("US-001", "Add the store", ["criterion one"], ["src/a.ts"]);

    expect(body.indexOf("## Files touched")).toBeLessThan(body.indexOf("## Acceptance criteria"));
  });

  test("keeps the files section intact when truncation drops the tail", () => {
    const criteria = Array.from({ length: 40 }, (_, i) => `criterion number ${i} padded out to be long`);
    const body = renderFragmentBody("US-001", "Add the store", criteria, ["src/a.ts", "src/b.ts"]);

    const truncated = truncateToFragmentBudget(body, 100);

    expect(truncated).toContain("src/a.ts");
    expect(truncated).toContain("src/b.ts");
  });
});

describe("truncateToFragmentBudget — line boundary", () => {
  test("does not cut a body mid-line", () => {
    const body = ["line one is fairly long", "line two is also long", "line three trails"].join("\n");

    const truncated = truncateToFragmentBudget(body, 8);

    const truncatedLines = truncated.split("\n");
    const lastLine = truncatedLines[truncatedLines.length - 1] ?? "";

    expect(truncated.length).toBeGreaterThan(0);
    expect(body.split("\n")).toContain(lastLine);
  });

  test("returns a body shorter than the budget unchanged", () => {
    const body = "short body\nsecond line";

    expect(truncateToFragmentBudget(body, 400)).toBe(body);
  });
});
