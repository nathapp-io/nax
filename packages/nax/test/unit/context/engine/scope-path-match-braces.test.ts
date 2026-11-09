/**
 * scope-path-match — brace glob support (US-002).
 *
 * `SCOPE_GLOB_META` counts `{` as glob syntax, so a pattern like
 * `src/` + `**` + `/*.{ts,tsx}` was compiled as a glob that matched only the
 * literal text `*.{ts,tsx}` — a rule written with a brace group was silently
 * never selected and never attributed (review finding M16).
 *
 * These are the brace, attribution and lint cases for the fix. They live in
 * their own file because `rules-lint.test.ts` is past the 650-line target.
 *
 * A brace group is expanded only when it is balanced AND carries at least one
 * top-level comma. Everything else stays literal, exactly as before:
 *   - unbalanced braces  → every `{`, `}` and `,` is literal (AC-7, AC-8, AC-22)
 *   - a group with no comma (`{a}`, `{}`) → literal (AC-11, AC-12)
 *   - a comma outside any group → literal (AC-9, AC-10)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _rulesLintDeps } from "@/cli";
import { globToRegex } from "@/context/engine";
import { pathMatchesScope } from "@/context/engine/effectiveness";
import { ruleMatchesScopeFiles } from "@/context/engine/scope-path-match";

describe("globToRegex — brace alternation", () => {
  test("[AC-1] matches src/a.ts for src/**/*.{ts,tsx}", () => {
    expect(globToRegex("src/**/*.{ts,tsx}").test("src/a.ts")).toBe(true);
  });

  test("[AC-2] matches src/deep/b.tsx for src/**/*.{ts,tsx}", () => {
    expect(globToRegex("src/**/*.{ts,tsx}").test("src/deep/b.tsx")).toBe(true);
  });

  test("[AC-3] does not match src/a.js for src/**/*.{ts,tsx}", () => {
    expect(globToRegex("src/**/*.{ts,tsx}").test("src/a.js")).toBe(false);
  });

  test("[AC-4] matches src/b/d.ts for src/{a,b/{c,d}}.ts", () => {
    expect(globToRegex("src/{a,b/{c,d}}.ts").test("src/b/d.ts")).toBe(true);
  });

  test("[AC-5] does not match src/b.ts for src/{a,b/{c,d}}.ts", () => {
    expect(globToRegex("src/{a,b/{c,d}}.ts").test("src/b.ts")).toBe(false);
  });

  test("[AC-6] matches src/app/x/y.ts for src/{lib,app}/**/*.ts", () => {
    expect(globToRegex("src/{lib,app}/**/*.ts").test("src/app/x/y.ts")).toBe(true);
  });
});

describe("globToRegex — unbalanced braces stay literal", () => {
  test("[AC-7] matches the literal path src/{a.ts for src/{a.ts", () => {
    expect(globToRegex("src/{a.ts").test("src/{a.ts")).toBe(true);
  });

  test("[AC-8] does not match src/a.ts for src/{a.ts", () => {
    expect(globToRegex("src/{a.ts").test("src/a.ts")).toBe(false);
  });

  test("[AC-22] matches the literal path src/{a,b}.ts} for src/{a,b}.ts}", () => {
    expect(globToRegex("src/{a,b}.ts}").test("src/{a,b}.ts}")).toBe(true);
  });
});

describe("globToRegex — commas and comma-less groups", () => {
  test("[AC-9] matches src/a,b1.ts for src/a,b*.ts (a comma outside any group)", () => {
    expect(globToRegex("src/a,b*.ts").test("src/a,b1.ts")).toBe(true);
  });

  test("[AC-10] does not match src/a.ts for src/a,b*.ts (a comma outside any group)", () => {
    expect(globToRegex("src/a,b*.ts").test("src/a.ts")).toBe(false);
  });

  test("[AC-11] matches the literal path src/{a}.ts for src/{a}.ts (a group with no comma)", () => {
    expect(globToRegex("src/{a}.ts").test("src/{a}.ts")).toBe(true);
  });

  test("[AC-12] does not match src/a.ts for src/{a}.ts (a group with no comma)", () => {
    expect(globToRegex("src/{a}.ts").test("src/a.ts")).toBe(false);
  });

  test("[AC-13] matches src/a.ts for src/a{,.test}.ts (an empty alternative)", () => {
    expect(globToRegex("src/a{,.test}.ts").test("src/a.ts")).toBe(true);
  });

  test("[AC-14] matches src/a.test.ts for src/a{,.test}.ts (an empty alternative)", () => {
    expect(globToRegex("src/a{,.test}.ts").test("src/a.test.ts")).toBe(true);
  });

  test("[AC-15] matches src/a.b.ts for src/{a.b,c}.ts", () => {
    expect(globToRegex("src/{a.b,c}.ts").test("src/a.b.ts")).toBe(true);
  });

  test("[AC-16] does not match src/aXb.ts for src/{a.b,c}.ts (a . inside a group stays literal)", () => {
    expect(globToRegex("src/{a.b,c}.ts").test("src/aXb.ts")).toBe(false);
  });
});

describe("rule selection and chunk attribution agree on brace globs", () => {
  test("[AC-17] ruleMatchesScopeFiles selects a rule for a brace glob matching packages/app/src/index.tsx", () => {
    expect(ruleMatchesScopeFiles(["src/**/*.{ts,tsx}"], ["packages/app/src/index.tsx"])).toBe(true);
  });

  test("[AC-18] ruleMatchesScopeFiles rejects a brace glob for src/readme.md", () => {
    expect(ruleMatchesScopeFiles(["src/**/*.{ts,tsx}"], ["src/readme.md"])).toBe(false);
  });

  test("[AC-19] pathMatchesScope attributes src/index.ts for a brace glob, the same answer ruleMatchesScopeFiles gives", () => {
    const scope = ["src/**/*.{ts,tsx}"];
    const file = "src/index.ts";

    expect(pathMatchesScope(scope, file)).toBe(true);
    expect(ruleMatchesScopeFiles(scope, [file])).toBe(pathMatchesScope(scope, file));
  });
});

describe("rules lint — brace globs agree with runtime", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("rules-lint-brace-glob-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("[AC-20] reports 'match' for src/{a,b}.ts when the tree holds src/b.ts", async () => {
    await Bun.write(join(tempDir, "src", "b.ts"), "");

    expect(_rulesLintDeps.globHasMatch("src/{a,b}.ts", tempDir)).toBe("match");
  });

  test("[AC-21] reports 'no-match' for src/{a,b}.ts when the tree holds only src/c.ts", async () => {
    await Bun.write(join(tempDir, "src", "c.ts"), "");

    expect(_rulesLintDeps.globHasMatch("src/{a,b}.ts", tempDir)).toBe("no-match");
  });
});
