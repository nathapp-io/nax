import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir } from "#test/helpers/index";
import { makeReleaseCliFixture } from "#test/helpers/release-cli-fixture";

describe("maintainer release CLI", () => {
  test.each([{ args: ["--dry-run", "patch"] }, { args: ["--dry-run", "tag"] }, { args: ["patch"] }, { args: ["tag"] }])(
    "%j leaves local and remote state unchanged without confirmation",
    ({ args }) => {
      const f = makeReleaseCliFixture();
      try {
        const before = f.git("rev-parse", "HEAD");
        const result = f.run(args, "n\n");
        expect(result.status).toBe(0);
        expect(f.git("rev-parse", "HEAD")).toBe(before);
        expect(f.git("status", "--porcelain")).toBe("");
        expect(f.git("tag", "--list")).toBe("");
        expect(
          result.calls.every(
            (call) => !/^(gh |bun |git (pull|push|add|commit|checkout)\b|git tag (?!--list))/.test(call),
          ),
        ).toBe(true);
      } finally {
        cleanupTempDir(f.dir);
      }
    },
  );

  test.each(["dirty", "non-main", "existing-tag"])("rejects %s before creating or pushing a tag", (condition) => {
    const f = makeReleaseCliFixture();
    try {
      if (condition === "dirty") writeFileSync(join(f.dir, "untracked"), "changes");
      if (condition === "non-main") f.git("checkout", "-b", "feature");
      if (condition === "existing-tag") f.git("tag", "nax-agent-v0.1.0");
      const result = f.run(["tag"], "y\n");
      expect(result.status).not.toBe(0);
      expect(result.calls.some((call) => /^git (push|tag nax-agent)\b/.test(call))).toBe(false);
    } finally {
      cleanupTempDir(f.dir);
    }
  });

  test("confirmed bump commits notes, package and lockfile, then opens a PR without tagging", () => {
    const f = makeReleaseCliFixture();
    try {
      const result = f.run(["patch"], "y\n");
      expect(result.status).toBe(0);
      const changed = f.git("diff", "--name-only", "main", "release/nax-agent-v0.1.1").split("\n");
      expect(changed).toEqual(["bun.lock", "packages/nax-agent/CHANGELOG.md", "packages/nax-agent/package.json"]);
      expect(JSON.parse(f.git("show", "release/nax-agent-v0.1.1:packages/nax-agent/package.json")).version).toBe(
        "0.1.1",
      );
      expect(f.git("show", "release/nax-agent-v0.1.1:packages/nax-agent/CHANGELOG.md")).toMatch(
        /## \[0\.1\.1\] - \d{4}-\d{2}-\d{2}/,
      );
      expect(f.git("tag", "--list")).toBe("");
      const pr = result.calls.find((call) => call.startsWith("gh pr create"));
      expect(pr).toContain("--body-file");
      expect(pr).toContain("--head release/nax-agent-v0.1.1");
      expect(readFileSync(join(f.dir, "pr-body"), "utf8")).toContain("0.1.0 -> 0.1.1\n");
      expect(f.git("status", "--porcelain")).toBe("");
    } finally {
      cleanupTempDir(f.dir);
    }
  });

  test("failed push stops before PR creation", () => {
    const f = makeReleaseCliFixture();
    try {
      const result = f.run(["patch"], "y\n", { FAIL_PUSH: "9" });
      expect(result.status).not.toBe(0);
      expect(result.calls.some((call) => call.startsWith("gh "))).toBe(false);
    } finally {
      cleanupTempDir(f.dir);
    }
  });

  test("preview needs no future release notes, but a real bump refuses to mutate without them", () => {
    const f = makeReleaseCliFixture();
    try {
      writeFileSync(join(f.dir, "packages/nax-agent/CHANGELOG.md"), "## [0.1.0] - Unreleased\n\n- Native agent.\n");
      f.git("add", "packages/nax-agent/CHANGELOG.md");
      f.git("commit", "-m", "first release notes only");
      expect(f.run(["minor", "--dry-run"]).status).toBe(0);
      const actual = f.run(["minor"], "y\n");
      expect(actual.status).not.toBe(0);
      expect(actual.calls.some((call) => /^git (pull|checkout|push)\b/.test(call))).toBe(false);
    } finally {
      cleanupTempDir(f.dir);
    }
  });

  test("dry-run reports bootstrap and future release behavior", () => {
    const f = makeReleaseCliFixture();
    try {
      expect(f.run(["tag", "--dry-run"]).output).toContain("manual");
      const minor = f.run(["minor", "--dry-run"]);
      expect(minor.status).toBe(0);
      expect(minor.output).toContain("nax-agent-v0.2.0");
      expect(minor.output).toContain("latest");
    } finally {
      cleanupTempDir(f.dir);
    }
  });
});
