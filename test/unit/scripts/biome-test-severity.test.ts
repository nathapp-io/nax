/**
 * Pins that `noExplicitAny` and `noNonNullAssertion` are ERRORS for `test/**`,
 * behaviourally — not just present in biome.json.
 *
 * Why this exists: both rules were `off` for test/** during their drains and
 * were promoted back to `"error"` by SETTING the severity in the test/**
 * override, not by deleting it. Under Biome v2, deleting the override lands
 * them at default WARNING severity, `biome check` exits 0 on warnings, and two
 * completed drains retire into no enforcement at all — silently. See
 * docs/findings/biome-migration-risk.md.
 *
 * Until 2026-08-27 the `asAny` / `anyType` / `nonNullAssert` counters in
 * scripts/check-test-escape-hatches.ts were the accidental backstop for that
 * failure. They retired (STATUS §8.14) because a text regex behind a working
 * parser guards only prose — which makes this test the backstop instead. It
 * asserts the exit code, because that is the thing the CI gate reads.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

const REPO = join(import.meta.dir, "..", "..", "..");
const BIOME = join(REPO, "node_modules", ".bin", "biome");

interface Diagnostic {
  category?: string;
  severity?: string;
  location?: { path?: string };
}

/**
 * Lint `relPath` under a faithful copy of the repo's own biome.json.
 *
 * A copy in a temp dir, not the repo itself, so the probe can plant a file at
 * an arbitrary path without touching the working tree. The only edit is
 * absolutising the plugin paths, which biome resolves against the config's
 * directory.
 */
async function lintUnderRepoConfig(
  relPath: string,
  source: string,
): Promise<{ exitCode: number; diags: Diagnostic[] }> {
  const dir = makeTempDir("nax-biome-severity-");
  try {
    const config = (await Bun.file(join(REPO, "biome.json")).json()) as {
      assist?: unknown;
      plugins?: string[];
      overrides?: Array<{ plugins?: string[] }>;
    };
    // Assist actions are not lint diagnostics and would add import-sort noise.
    config.assist = { actions: { source: { organizeImports: "off" } } };
    // Plugin paths resolve against the config's directory. Miss one and biome
    // exits with a config error and an EMPTY stdout, which parses as a JSON
    // failure rather than as "no findings" — never as a green run.
    if (config.plugins !== undefined) {
      config.plugins = config.plugins.map((p) => join(REPO, p));
    }
    for (const override of config.overrides ?? []) {
      if (override.plugins !== undefined) {
        override.plugins = override.plugins.map((p) => join(REPO, p));
      }
    }
    writeFileSync(join(dir, "biome.json"), JSON.stringify(config));
    mkdirSync(join(dir, relPath.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(dir, relPath), source);
    const proc = Bun.spawn([BIOME, "lint", "--config-path=.", relPath, "--reporter=json", "--max-diagnostics=5000"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    const parsed = JSON.parse(out) as { diagnostics: Diagnostic[] };
    return { exitCode, diags: parsed.diagnostics };
  } finally {
    cleanupTempDir(dir);
  }
}

const PROBE = "test/unit/probe.test.ts";

describe("biome test/** severities", () => {
  test("`as any` in test/ is an error, and biome exits non-zero", async () => {
    const { exitCode, diags } = await lintUnderRepoConfig(PROBE, "export const x = JSON.parse('{}') as any;\n");
    const found = diags.filter((d) => d.category === "lint/suspicious/noExplicitAny");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("error");
    expect(exitCode).not.toBe(0);
  });

  test("a non-null assertion in test/ is an error, and biome exits non-zero", async () => {
    const { exitCode, diags } = await lintUnderRepoConfig(
      PROBE,
      ["export function f(a?: { b: number }) {", "  return a!.b;", "}"].join("\n"),
    );
    const found = diags.filter((d) => d.category === "lint/style/noNonNullAssertion");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("error");
    expect(exitCode).not.toBe(0);
  });

  test("the as-never plugin fires on a test/ path through the repo config, not just standalone", async () => {
    // The override carries the plugins as well as the severities; a moved or
    // renamed `includes` glob breaks both at once.
    const { diags } = await lintUnderRepoConfig(PROBE, "export const x = { a: 1 } as never;\n");
    expect(diags.filter((d) => d.category === "plugin")).toHaveLength(1);
  });

  test("the absent-value plugin fires on a test/ path through the repo config", async () => {
    const { diags } = await lintUnderRepoConfig(PROBE, "export const x = absentValue<string>();\n");
    expect(diags.filter((d) => d.category === "plugin")).toHaveLength(1);
  });

  test("the as-never plugin reaches src/ too, and an override does not shadow it in test/", async () => {
    // The scope widened from `test/**` to the repo root on 2026-08-27. Both
    // halves matter: `src/` is newly covered, and `test/` must not have LOST
    // coverage to the override that still declares its own `plugins` list —
    // biome merges the two rather than replacing, which is the whole reason
    // the widening could be done without duplicating the entry.
    const inSrc = await lintUnderRepoConfig("src/probe.ts", "export const x = { a: 1 } as never;\n");
    expect(inSrc.diags.filter((d) => d.category === "plugin")).toHaveLength(1);
    expect(inSrc.exitCode).not.toBe(0);
  });

  test("the absent-value plugin stays scoped to test/ and does not reach src/", async () => {
    // `absentValue<T>()` is a test-only helper (test/helpers/absent.ts). Its
    // plugin belongs in the override, not at the root.
    const inSrc = await lintUnderRepoConfig("src/probe.ts", "export const x = absentValue<string>();\n");
    expect(inSrc.diags.filter((d) => d.category === "plugin")).toEqual([]);
  });

  test("`@ts-ignore` is an error in test/ and in src/, and biome exits non-zero", async () => {
    // Promoted warn -> error on 2026-08-27. It ships `recommended` at WARN,
    // where `biome check` exits 0 — so before this it reported the directive
    // and let the build through. There were zero directives anywhere in src/,
    // bin/ and test/, so the promotion cost nothing.
    //
    // Set at the ROOT while the test/** override declares its own `suspicious`
    // group. Whether that group shadows the root's is exactly what this pins:
    // both paths are asserted, because a rules-group merge is not something to
    // assume from a config file that reads either way.
    for (const path of [PROBE, "src/probe.ts"]) {
      const { exitCode, diags } = await lintUnderRepoConfig(path, "// @ts-ignore\nexport const x: number = 1;\n");
      const found = diags.filter((d) => d.category === "lint/suspicious/noTsIgnore");
      expect(found).toHaveLength(1);
      expect(found[0]?.severity).toBe("error");
      expect(exitCode).not.toBe(0);
    }
  });

  // --- Tier 1 promotions (docs/plans/biome-v2-rule-gaps.md), wired 2026-08-28 ---
  //
  // Seven off-by-default rules promoted straight to "error". They ship either
  // absent from `recommended` or at WARN, and `biome check` exits 0 on warnings
  // — so "present in biome.json" proves nothing. Each case below plants a
  // fixture the rule must reject and asserts the exit code, per the file header.

  const TIER1: Array<{ rule: string; category: string; source: string; src: boolean }> = [
    {
      rule: "noFloatingPromises",
      category: "lint/nursery/noFloatingPromises",
      source: ["async function work(): Promise<void> {}", "export function go(): void {", "  work();", "}"].join("\n"),
      src: true,
    },
    {
      rule: "noMisusedPromises",
      category: "lint/nursery/noMisusedPromises",
      source: ["declare function take(cb: () => void): void;", "take(async () => {});"].join("\n"),
      src: true,
    },
    {
      rule: "noEvolvingTypes",
      category: "lint/suspicious/noEvolvingTypes",
      source: ["export function f() {", "  const xs = [];", "  xs.push(1);", "  return xs;", "}"].join("\n"),
      src: true,
    },
    {
      rule: "useThrowOnlyError",
      category: "lint/style/useThrowOnlyError",
      source: ["export function f(): void {", '  throw "x";', "}"].join("\n"),
      src: true,
    },
    {
      rule: "useErrorMessage",
      category: "lint/suspicious/useErrorMessage",
      source: "export const e = new Error();",
      src: true,
    },
    // Test-domain rules: biome selects them by filename, so they have no src/ half.
    {
      rule: "noSkippedTests",
      category: "lint/suspicious/noSkippedTests",
      source: ['import { test } from "bun:test";', 'test.skip("x", () => {});'].join("\n"),
      src: false,
    },
    {
      rule: "noDuplicateTestHooks",
      category: "lint/suspicious/noDuplicateTestHooks",
      source: [
        'import { beforeEach, describe, test } from "bun:test";',
        'describe("d", () => {',
        "  beforeEach(() => {});",
        "  beforeEach(() => {});",
        '  test("t", () => {});',
        "});",
      ].join("\n"),
      src: false,
    },
  ];

  for (const { rule, category, source } of TIER1) {
    test(`${rule} is an error in test/, and biome exits non-zero`, async () => {
      const { exitCode, diags } = await lintUnderRepoConfig(PROBE, `${source}\n`);
      const found = diags.filter((d) => d.category === category);
      expect(found).toHaveLength(1);
      expect(found[0]?.severity).toBe("error");
      expect(exitCode).not.toBe(0);
    });
  }

  for (const { rule, category, source } of TIER1.filter((r) => r.src)) {
    test(`${rule} is an error in src/ too, and biome exits non-zero`, async () => {
      // The test/** override declares its own `suspicious` and `style` groups.
      // These are set at the ROOT, so both halves are asserted for the same
      // reason noTsIgnore is above: a rules-group merge is not something to
      // assume from a config that reads either way.
      const { exitCode, diags } = await lintUnderRepoConfig("src/probe.ts", `${source}\n`);
      const found = diags.filter((d) => d.category === category);
      expect(found).toHaveLength(1);
      expect(found[0]?.severity).toBe("error");
      expect(exitCode).not.toBe(0);
    });
  }

  // --- Tier 2 promotions (docs/plans/biome-v2-rule-gaps.md), wired 2026-08-28 ---
  //
  // Same contract as Tier 1: plant a fixture the rule must reject, assert the
  // diagnostic AND the exit code. Two of the three are type-aware and need
  // `linter.domains.types` as well as their rule entry — pinned separately below.

  const TIER2: Array<{ rule: string; category: string; source: string }> = [
    {
      rule: "useExhaustiveSwitchCases",
      category: "lint/nursery/useExhaustiveSwitchCases",
      source: [
        'type Action = "a" | "b";',
        "export function f(x: Action): number {",
        "  switch (x) {",
        '    case "a":',
        "      return 1;",
        "  }",
        "  return 0;",
        "}",
      ].join("\n"),
    },
    {
      rule: "useAwaitThenable",
      category: "lint/nursery/useAwaitThenable",
      source: [
        "function sync(): number {",
        "  return 1;",
        "}",
        "export async function f(): Promise<number> {",
        "  return await sync();",
        "}",
      ].join("\n"),
    },
    {
      rule: "useArraySortCompare",
      category: "lint/suspicious/useArraySortCompare",
      // An annotated parameter, not an inline `[3, 1, 2].sort()`: Biome resolves
      // the element type from the annotation and stays silent on the literal.
      source: ["export function f(xs: string[]): string[] {", "  return xs.sort();", "}"].join("\n"),
    },
  ];

  for (const { rule, category, source } of TIER2) {
    for (const path of [PROBE, "src/probe.ts"]) {
      test(`${rule} is an error in ${path.split("/")[0]}/, and biome exits non-zero`, async () => {
        const { exitCode, diags } = await lintUnderRepoConfig(path, `${source}\n`);
        const found = diags.filter((d) => d.category === category);
        expect(found).toHaveLength(1);
        expect(found[0]?.severity).toBe("error");
        expect(exitCode).not.toBe(0);
      });
    }
  }

  test("biome.json keeps the `types` domain, which the behavioural probes cannot see", async () => {
    // This assertion is NOT redundant with the two nursery cases above, and the
    // reason is a trap worth recording.
    //
    // `noFloatingPromises` and `noMisusedPromises` are type-aware: they need
    // `linter.domains.types` as well as their explicit rule entry. Measured on
    // 2026-08-28, deleting the domain from the repo config while leaving the
    // `nursery` entries in place drops BOTH rules to zero findings across
    // src/, bin/, scripts/ and test/ — silently, with the config still reading
    // as though they were enabled.
    //
    // The behavioural probes above cannot catch that. They lint a single
    // planted file in a temp dir with no tsconfig and no project around it,
    // and in that setup the rule fires whether or not the domain is present —
    // measured too. So the harness would report a cheerful pass over a repo
    // config that gates nothing. Only reading the config catches it.
    //
    // `"recommended"`, not `"all"`: `all` enables every rule in the domain,
    // which on this repo adds ~489 findings from noUnnecessaryConditions — a
    // rule deliberately not adopted. See the doc.
    const config = (await Bun.file(join(REPO, "biome.json")).json()) as {
      linter?: { domains?: Record<string, string>; rules?: { nursery?: Record<string, string> } };
    };
    expect(config.linter?.domains?.types).toBe("recommended");
    expect(config.linter?.rules?.nursery?.noFloatingPromises).toBe("error");
    expect(config.linter?.rules?.nursery?.noMisusedPromises).toBe("error");
    expect(config.linter?.rules?.nursery?.useAwaitThenable).toBe("error");
    expect(config.linter?.rules?.nursery?.useExhaustiveSwitchCases).toBe("error");
  });

  test("biome.json sets the severities explicitly in the test/** override", async () => {
    // The behavioural assertions above would still pass if the override were
    // deleted and the root rules applied — but then a FUTURE `off` in the root
    // block would silently disarm test/ too. Pin the explicit setting as well.
    const config = (await Bun.file(join(REPO, "biome.json")).json()) as {
      overrides?: Array<{
        includes?: string[];
        linter?: { rules?: { suspicious?: Record<string, string>; style?: Record<string, string> } };
      }>;
    };
    const testOverride = config.overrides?.find((o) => o.includes?.some((i) => i.includes("test")));
    expect(testOverride?.linter?.rules?.suspicious?.noExplicitAny).toBe("error");
    expect(testOverride?.linter?.rules?.style?.noNonNullAssertion).toBe("error");
  });
});
