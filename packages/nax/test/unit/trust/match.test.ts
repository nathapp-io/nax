/**
 * US-001: pure path matching for the per-folder trust store.
 *
 * `findCoveringEntry` decides whether a folder is inside a trusted root, and
 * `normalizeTrustPath` makes a path from a different source (a symlinked
 * temp dir, a directory that does not exist yet) comparable to a stored entry.
 * A `startsWith` without the separator boundary would make `/a/foo` cover
 * `/a/foobar`, which is the whole point of AC3.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, loadTrustModule, makeTempDir, trustFn } from "@test/helpers";
import type { TrustEntry } from "@/trust";

const trust = await loadTrustModule();

const ADDED_AT = "2026-09-30T00:00:00.000Z";

/** A stored trust entry for `path`; only `path` matters to the matchers. */
function entry(path: string): TrustEntry {
  return { path, addedAt: ADDED_AT, via: "prompt" };
}

describe("findCoveringEntry", () => {
  test("AC1: returns the entry whose path equals the queried path", () => {
    const findCoveringEntry = trustFn(trust, "findCoveringEntry");
    const foo = entry("/a/foo");

    expect(findCoveringEntry([foo], "/a/foo")).toEqual(foo);
  });

  test("AC2: returns the entry when the queried path is a descendant of it", () => {
    const findCoveringEntry = trustFn(trust, "findCoveringEntry");
    const foo = entry("/a/foo");

    expect(findCoveringEntry([foo], "/a/foo/bar/baz")).toEqual(foo);
  });

  test("AC3: returns null when the entry is a string prefix but not a path prefix", () => {
    const findCoveringEntry = trustFn(trust, "findCoveringEntry");

    expect(findCoveringEntry([entry("/a/foo")], "/a/foobar")).toBeNull();
  });

  test('AC4: returns the "/" entry for any absolute path', () => {
    const findCoveringEntry = trustFn(trust, "findCoveringEntry");
    const root = entry("/");

    expect(findCoveringEntry([root], "/x/y")).toEqual(root);
  });

  test("AC5: returns the longest covering entry when several cover the path", () => {
    const findCoveringEntry = trustFn(trust, "findCoveringEntry");
    const a = entry("/a");
    const aB = entry("/a/b");

    expect(findCoveringEntry([a, aB], "/a/b/c")).toEqual(aB);
  });

  test("returns null when the folder list is empty", () => {
    const findCoveringEntry = trustFn(trust, "findCoveringEntry");

    expect(findCoveringEntry([], "/a/foo")).toBeNull();
  });
});

describe("normalizeTrustPath", () => {
  test("AC6: resolves a symlinked ancestor for a path that does not exist yet", async () => {
    const normalizeTrustPath = trustFn(trust, "normalizeTrustPath");
    const container = makeTempDir("nax-trust-link-");
    const real = makeTempDir("nax-trust-real-");
    try {
      symlinkSync(real, join(container, "link"));

      const normalized = await normalizeTrustPath(join(container, "link", "not-yet", "created"));

      expect(normalized).toBe(join(realpathSync(real), "not-yet", "created"));
    } finally {
      cleanupTempDir(container);
      cleanupTempDir(real);
    }
  });

  test("AC6 boundary: strips a trailing slash from a directory path", async () => {
    const normalizeTrustPath = trustFn(trust, "normalizeTrustPath");
    const dir = makeTempDir("nax-trust-trailing-");
    try {
      mkdirSync(join(dir, "inside"));

      expect(await normalizeTrustPath(`${join(dir, "inside")}/`)).toBe(join(realpathSync(dir), "inside"));
    } finally {
      cleanupTempDir(dir);
    }
  });

  test('AC6 boundary: leaves the filesystem root as "/" without stripping it', async () => {
    const normalizeTrustPath = trustFn(trust, "normalizeTrustPath");

    expect(await normalizeTrustPath("/")).toBe("/");
  });
});
