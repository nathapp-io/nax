import { describe, expect, test } from "bun:test";
import type { ResolveResult } from "@/cli";
import { specLintCommand } from "@/cli";

/**
 * `nax spec lint` exists so a spec can be checked BEFORE the plan spends
 * (#1989). Its exit code must mirror what `nax plan` would actually do —
 * `scripts/spec-lint.ts` exited 1 on every error, including codes the plan
 * gate ignores, so it told 12 of this repo's 195 specs to "fix before running
 * `nax plan`" when `nax plan` would have run them fine.
 */
const DROPPED_MODIFIES = `# SPEC: Fixture

## Stories

### US-001 — Do the thing

Modifies:
- **US-001** \`src/a.ts\` — reason

## Acceptance Criteria

### US-001 — Do the thing

1. \`[unit]\` calling \`doThing()\` returns \`true\`.
`;

const UNTAGGED_AC_ONLY = `# SPEC: Fixture

## Stories

### US-001 — Do the thing

## Acceptance Criteria

### US-001 — Do the thing

1. calling \`doThing()\` returns \`true\`.
`;

const CLEAN = `# SPEC: Fixture

## Stories

### US-001 — Do the thing

## Acceptance Criteria

### US-001 — Do the thing

1. \`[unit]\` calling \`doThing()\` returns \`true\`.
`;

function depsFor(specs: Record<string, string>, lines: string[], resolution?: ResolveResult) {
  return {
    readFile: async (path: string): Promise<string> => {
      const content = specs[path];
      if (content === undefined) throw new Error(`no such fixture: ${path}`); // nax-lint-allow: plain-error
      return content;
    },
    fileExists: (path: string): boolean => path in specs,
    write: (line: string): void => {
      lines.push(line);
    },
    resolveFeatureSpec: async (): Promise<ResolveResult> =>
      resolution ?? { status: "feature-not-found", message: "no such feature" },
  };
}

describe("specLintCommand", () => {
  test("exits non-zero on a spec whose Modifies entries all extract to nothing", async () => {
    const out: string[] = [];
    const result = await specLintCommand(
      { dir: "/repo", paths: ["/repo/s.md"] },
      depsFor({ "/repo/s.md": DROPPED_MODIFIES }, out),
    );
    expect(result.exitCode).toBe(1);
    expect(result.reports[0].blocking.map((f) => f.code)).toEqual(["modifies-declared-but-empty"]);
  });

  test("exits zero on an error the plan gate does not block, so the two agree", async () => {
    const out: string[] = [];
    const result = await specLintCommand(
      { dir: "/repo", paths: ["/repo/s.md"] },
      depsFor({ "/repo/s.md": UNTAGGED_AC_ONLY }, out),
    );
    expect(result.exitCode).toBe(0);
    expect(result.reports[0].findings.map((f) => f.code)).toContain("ac-untagged");
    expect(result.reports[0].blocking).toEqual([]);
  });

  test("exits non-zero on that same spec under --strict", async () => {
    const out: string[] = [];
    const result = await specLintCommand(
      { dir: "/repo", paths: ["/repo/s.md"], strict: true },
      depsFor({ "/repo/s.md": UNTAGGED_AC_ONLY }, out),
    );
    expect(result.exitCode).toBe(1);
  });

  test("exits zero and reports no findings for a spec that round-trips", async () => {
    const out: string[] = [];
    const result = await specLintCommand(
      { dir: "/repo", paths: ["/repo/s.md"] },
      depsFor({ "/repo/s.md": CLEAN }, out),
    );
    expect(result.exitCode).toBe(0);
    expect(result.reports[0].findings).toEqual([]);
  });

  test("resolves -f <feature> through the shared feature-spec resolver, not a hardcoded path", async () => {
    const out: string[] = [];
    // The repo's specs live in docs/specs/, which only the shared resolver knows
    // about — a hardcoded `.nax/features/<name>/spec.md` misses every one.
    const result = await specLintCommand(
      { dir: "/repo", feature: "my-feature" },
      depsFor({ "/repo/docs/specs/SPEC-my-feature.md": DROPPED_MODIFIES }, out, {
        status: "ok",
        featureName: "my-feature",
        specSource: { kind: "markdown", path: "docs/specs/SPEC-my-feature.md" },
        message: "resolved",
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.reports[0].specPath).toBe("/repo/docs/specs/SPEC-my-feature.md");
  });

  test("refuses a feature whose only spec source is a prd.json, which has no sections to lint", async () => {
    const out: string[] = [];
    const result = await specLintCommand(
      { dir: "/repo", feature: "planned-already" },
      depsFor({}, out, {
        status: "ok",
        featureName: "planned-already",
        specSource: { kind: "prd", path: ".nax/features/planned-already/prd.json" },
        message: "resolved",
      }),
    );
    expect(result.exitCode).toBe(2);
    expect(out.join("\n")).toContain("prd.json");
  });

  test("reports the resolver's own message when the feature cannot be resolved", async () => {
    const out: string[] = [];
    const result = await specLintCommand({ dir: "/repo", feature: "ghost" }, depsFor({}, out));
    expect(result.exitCode).toBe(2);
    expect(out.join("\n")).toContain("no such feature");
  });

  test("exits 2 when a named spec does not exist, rather than reporting it clean", async () => {
    const out: string[] = [];
    const result = await specLintCommand({ dir: "/repo", paths: ["/repo/ghost.md"] }, depsFor({}, out));
    expect(result.exitCode).toBe(2);
    expect(result.reports[0].missing).toBe(true);
  });

  test("exits 2 when neither a path nor a feature was given", async () => {
    const out: string[] = [];
    const result = await specLintCommand({ dir: "/repo" }, depsFor({}, out));
    expect(result.exitCode).toBe(2);
    expect(result.reports).toEqual([]);
  });

  test("labels a finding by whether it blocks the plan, not by its level", async () => {
    const out: string[] = [];
    await specLintCommand({ dir: "/repo", paths: ["/repo/s.md"] }, depsFor({ "/repo/s.md": DROPPED_MODIFIES }, out));
    expect(out.join("\n")).toContain("[BLOCK]");
  });

  test("honours the configured AC cap when counting an oversized story", async () => {
    const out: string[] = [];
    const result = await specLintCommand(
      { dir: "/repo", paths: ["/repo/s.md"], maxAcCount: 0 },
      depsFor({ "/repo/s.md": CLEAN }, out),
    );
    expect(result.reports[0].findings.map((f) => f.code)).toContain("ac-count-over-cap");
  });
});
