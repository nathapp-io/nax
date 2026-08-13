/**
 * US-001: Fragment store — write/read/list/delete CRUD
 *
 * AC 6–12 cover the runtime behaviour of the fragment store.
 *
 * Layout: <projectDir>/features/<featureId>/fragments/<storyId>.md
 *
 * Truncation: when the configured `maxTokens` budget is exceeded, the
 * subsequently-read body must be no longer than that budget. Token counting
 * uses the project's `estimateTokens` heuristic (one token ≈ 4 chars of body).
 *
 * The deps mirror `_manifestStoreDeps` from `manifest-store.ts` so tests can
 * inject an in-memory file system without touching `Bun.file` or `Bun.write`.
 */

import { describe, expect, test } from "bun:test";
import {
  _fragmentStoreDeps,
  deleteFragment,
  fragmentPath,
  listFragmentStoryIds,
  readFragment,
  writeFragment,
} from "@/context";
import { withDepsRestore } from "@test/helpers";

withDepsRestore(_fragmentStoreDeps);

describe("fragment store — writeFragment / readFragment (US-001)", () => {
  test("[US-001 AC 6] readFragment returns the body that writeFragment stored", async () => {
    const writes = new Map<string, string>();

    _fragmentStoreDeps.mkdirp = async () => undefined;
    _fragmentStoreDeps.writeFile = async (path, content) => {
      writes.set(path, content);
      return content.length;
    };
    _fragmentStoreDeps.fileExists = async (path) => writes.has(path);
    _fragmentStoreDeps.readFile = async (path) => writes.get(path) ?? "";
    _fragmentStoreDeps.listFragments = async () => [];
    _fragmentStoreDeps.removeFile = async () => undefined;

    const body = "Hello, fragment world.\nSecond line.";
    await writeFragment("/repo", "feat-auth", "US-001", body, { maxTokens: 400 });

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
      return content.length;
    };
    _fragmentStoreDeps.fileExists = async (path) => writes.has(path);
    _fragmentStoreDeps.readFile = async (path) => writes.get(path) ?? "";
    _fragmentStoreDeps.listFragments = async () => [];
    _fragmentStoreDeps.removeFile = async () => undefined;

    const first = "First body";
    const second = "Second body — completely different content.";

    await writeFragment("/repo", "feat-auth", "US-001", first, { maxTokens: 400 });
    await writeFragment("/repo", "feat-auth", "US-001", second, { maxTokens: 400 });

    const read = await readFragment("/repo", "feat-auth", "US-001");
    expect(read).toBe(second);
    expect(read).not.toBe(first);
  });

  test("[US-001 AC 8] writeFragment truncates the body when it exceeds maxTokens", async () => {
    const writes = new Map<string, string>();

    _fragmentStoreDeps.mkdirp = async () => undefined;
    _fragmentStoreDeps.writeFile = async (path, content) => {
      writes.set(path, content);
      return content.length;
    };
    _fragmentStoreDeps.fileExists = async (path) => writes.has(path);
    _fragmentStoreDeps.readFile = async (path) => writes.get(path) ?? "";
    _fragmentStoreDeps.listFragments = async () => [];
    _fragmentStoreDeps.removeFile = async () => undefined;

    // maxTokens = 4 → budget = 4 tokens ≈ 16 chars. Write 200 chars.
    const longBody = "a".repeat(200);
    await writeFragment("/repo", "feat-auth", "US-001", longBody, { maxTokens: 4 });

    const read = await readFragment("/repo", "feat-auth", "US-001");
    expect(read).not.toBeNull();
    // Conservative: the read body is bounded by the same budget readFragment would apply.
    expect(read?.length ?? 0).toBeLessThanOrEqual(16);
  });

  test("writeFragment builds the path under <projectDir>/features/<featureId>/fragments/<storyId>.md", () => {
    expect(fragmentPath("/repo", "feat-auth", "US-001")).toBe(
      "/repo/features/feat-auth/fragments/US-001.md",
    );
  });

  test("writeFragment creates the fragments dir before writing", async () => {
    const mkdirArgs: string[] = [];
    _fragmentStoreDeps.mkdirp = async (path) => {
      mkdirArgs.push(path);
      return undefined;
    };
    _fragmentStoreDeps.writeFile = async () => 0;
    _fragmentStoreDeps.listFragments = async () => [];
    _fragmentStoreDeps.removeFile = async () => undefined;

    await writeFragment("/repo", "feat-auth", "US-001", "body", { maxTokens: 400 });
    expect(mkdirArgs).toContain("/repo/features/feat-auth/fragments");
  });
});

describe("fragment store — listFragmentStoryIds (US-001)", () => {
  test("[US-001 AC 9] listFragmentStoryIds returns both story ids when two fragments exist", async () => {
    _fragmentStoreDeps.listFragments = async () => ["US-001.md", "US-002.md"];

    const ids = await listFragmentStoryIds("/repo", "feat-auth");
    expect(ids).toEqual(["US-001", "US-002"]);
  });

  test("listFragmentStoryIds returns [] when no fragments exist", async () => {
    _fragmentStoreDeps.listFragments = async () => [];
    const ids = await listFragmentStoryIds("/repo", "feat-auth");
    expect(ids).toEqual([]);
  });

  test("listFragmentStoryIds strips the .md suffix", async () => {
    _fragmentStoreDeps.listFragments = async () => ["US-abc-1.md", "story-with-dashes.md"];
    const ids = await listFragmentStoryIds("/repo", "feat-auth");
    expect(ids).toEqual(["US-abc-1", "story-with-dashes"]);
  });
});

describe("fragment store — deleteFragment (US-001)", () => {
  test("[US-001 AC 10] deleteFragment removes the file so a subsequent readFragment returns null", async () => {
    const writes = new Map<string, string>();
    const path = "/repo/features/feat-auth/fragments/US-001.md";
    writes.set(path, "old body");

    _fragmentStoreDeps.mkdirp = async () => undefined;
    _fragmentStoreDeps.writeFile = async (p, content) => {
      writes.set(p, content);
      return content.length;
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
    const target = "/repo/features/feat-auth/fragments/US-001.md";
    const other = "/repo/features/feat-auth/fragments/US-002.md";
    writes.set(target, "remove me");
    writes.set(other, "keep me");

    _fragmentStoreDeps.mkdirp = async () => undefined;
    _fragmentStoreDeps.writeFile = async (p, content) => {
      writes.set(p, content);
      return content.length;
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
