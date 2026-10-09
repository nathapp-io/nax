import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { NO_CHANGES } from "#scripts/lib/release-version";
// biome-ignore lint/style/noRestrictedImports: the release fixture is a test helper inside this package, not an entry
import { makeReleaseCliFixture, type ReleaseCliFixture } from "../../helpers/release-cli-fixture";

const MUTATING = /^(gh |bun |npm |git (pull|push|add|commit|checkout)\b|git tag (?!--list))/;

function withFixture(fn: (f: ReleaseCliFixture) => void): void {
  const f = makeReleaseCliFixture();
  try {
    fn(f);
  } finally {
    cleanupTempDir(f.dir);
  }
}

describe("release command", () => {
  test.each([{ args: ["--dry-run", "patch"] }, { args: ["--dry-run", "tag"] }, { args: ["patch"] }, { args: ["tag"] }])(
    "%j leaves local and remote state unchanged without confirmation",
    ({ args }) =>
      withFixture((f) => {
        const before = f.git("rev-parse", "HEAD");
        const result = f.run(args, "n\n");
        expect(result.status).toBe(0);
        expect(f.git("rev-parse", "HEAD")).toBe(before);
        expect(f.git("status", "--porcelain")).toBe("");
        expect(f.git("tag", "--list")).toBe("");
        expect(result.calls.filter((call) => MUTATING.test(call))).toEqual([]);
      }),
  );

  test("a confirmed bump moves all four packages, both pins and both changelogs in one PR, without tagging", () =>
    withFixture((f) => {
      const result = f.run(["patch"], "y\n");
      expect(result.status).toBe(0);
      const branch = "release/v0.84.1";
      expect(f.git("diff", "--name-only", "main", branch).split("\n")).toEqual([
        "bun.lock",
        "packages/nax-agent-acp/CHANGELOG.md",
        "packages/nax-agent-acp/package.json",
        "packages/nax-agent/CHANGELOG.md",
        "packages/nax-agent/package.json",
        "packages/nax-ai/package.json",
        "packages/nax/package.json",
      ]);
      for (const pkg of ["nax-ai", "nax-agent", "nax-agent-acp", "nax"]) {
        expect(JSON.parse(f.git("show", `${branch}:packages/${pkg}/package.json`)).version).toBe("0.84.1");
      }
      for (const pkg of ["nax-agent", "nax"]) {
        const deps = JSON.parse(f.git("show", `${branch}:packages/${pkg}/package.json`)).dependencies;
        expect(deps["@nathapp/nax-ai"]).toBe("0.84.1");
      }
      expect(f.git("show", `${branch}:packages/nax-agent/CHANGELOG.md`)).toMatch(
        /## \[0\.84\.1\] - \d{4}-\d{2}-\d{2}\n\n- New tools\./,
      );
      expect(f.git("show", `${branch}:packages/nax-agent-acp/CHANGELOG.md`)).toContain(NO_CHANGES);
      expect(f.git("tag", "--list")).toBe("");
      expect(f.git("branch", "--show-current")).toBe("main");
      const pr = result.calls.find((call) => call.startsWith("gh pr create"));
      expect(pr).toContain("--head release/v0.84.1");
      expect(readFileSync(join(f.dir, "pr-body"), "utf8")).toContain("0.84.0 -> 0.84.1");
    }));

  test("a failed push stops before the PR is opened", () =>
    withFixture((f) => {
      const result = f.run(["patch"], "y\n", { FAIL_PUSH: "9" });
      expect(result.status).not.toBe(0);
      expect(result.calls.some((call) => call.startsWith("gh "))).toBe(false);
    }));

  test("refuses to bump a workspace that is out of lockstep, before touching git", () =>
    withFixture((f) => {
      f.write(
        "packages/nax-ai/package.json",
        `${JSON.stringify({ name: "@nathapp/nax-ai", version: "0.1.16" }, null, 2)}\n`,
      );
      f.git("commit", "-am", "drift");
      const result = f.run(["patch"], "y\n");
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("versions differ");
      expect(result.calls.filter((call) => MUTATING.test(call))).toEqual([]);
    }));

  test.each(["0.84.0", "0.83.9", "0.85.0-rc.1"])("refuses explicit version %s", (version) =>
    withFixture((f) => {
      const result = f.run([version], "y\n");
      expect(result.status).not.toBe(0);
      expect(result.calls.filter((call) => MUTATING.test(call))).toEqual([]);
    }),
  );

  test("dry runs name the tag, the dist-tag and every package", () =>
    withFixture((f) => {
      const minor = f.run(["--dry-run", "minor"]).output;
      expect(minor).toContain("v0.85.0");
      expect(minor).toContain("latest");
      expect(f.run(["--dry-run", "canary"]).output).toContain("canary");
      const tag = f.run(["--dry-run", "tag"]).output;
      for (const name of ["@nathapp/nax-ai", "@nathapp/nax-agent", "@nathapp/nax-agent-acp", "@nathapp/nax"]) {
        expect(tag).toContain(name);
      }
      expect(tag).toContain("v0.84.0");
    }));

  test.each(["dirty", "non-main", "existing-tag"])(
    "tag rejects a %s checkout before creating or pushing a tag",
    (condition) =>
      withFixture((f) => {
        if (condition === "dirty") writeFileSync(join(f.dir, "untracked"), "changes");
        if (condition === "non-main") f.git("checkout", "-b", "feature");
        if (condition === "existing-tag") f.git("tag", "v0.84.0");
        const result = f.run(["tag"], "y\n");
        expect(result.status).not.toBe(0);
        expect(result.calls.some((call) => /^git (push|tag v)/.test(call))).toBe(false);
      }),
  );

  test("a confirmed tag pushes vX.Y.Z only", () =>
    withFixture((f) => {
      const result = f.run(["tag"], "y\n");
      expect(result.status).toBe(0);
      expect(f.git("tag", "--list")).toBe("v0.84.0");
      expect(result.calls).toContain("git push origin v0.84.0");
    }));
});
