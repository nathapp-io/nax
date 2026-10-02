import { describe, expect, test } from "bun:test";

// The interceptor unit tests live in nax-agent (test/unit/command-interceptor/); this fence reads nax's own src/.

/** Only these may IMPORT the rtk provider. Naming rtk in a comment or a config default is fine. */
const MAY_IMPORT_RTK = new Set(["execution/lifecycle/run-setup.ts"]);

/**
 * Matches the alias form AND any relative spelling — `run-setup.ts` already
 * uses relative imports for its siblings (`../helpers`, `../crash-recovery`),
 * so an alias-only regex would match nothing and pass vacuously.
 */
const IMPORTS_RTK = /from\s+["'](?:@\/execution|\.{1,2}(?:\/\.\.)*)\/?.*interceptors\/rtk(?:\/index)?["']/;

describe("R10 / R1: interception stays where it belongs", () => {
  test("no interceptor reaches the quality, verification or git-utils sites", async () => {
    for (const path of ["src/quality/runner.ts", "src/verification/executor.ts", "src/utils/git.ts"]) {
      const source = await Bun.file(path).text();
      expect(source).not.toContain("interceptArgv");
      expect(source).not.toContain("CommandInterceptor");
    }
  });

  test("nothing but the composition site imports the rtk provider (R1)", async () => {
    const offenders: string[] = [];
    for (const rel of new Bun.Glob("**/*.ts").scanSync({ cwd: "src" })) {
      if (rel.startsWith("execution/interceptors/rtk/")) continue;
      if (MAY_IMPORT_RTK.has(rel)) continue;
      const source = await Bun.file(`src/${rel}`).text();
      if (IMPORTS_RTK.test(source)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test("the fence is not vacuous — the composition site really does import it", async () => {
    // Without this, a relative import spelling makes the test above pass by
    // matching nothing at all, and the allowlist becomes decorative.
    for (const rel of MAY_IMPORT_RTK) {
      expect(IMPORTS_RTK.test(await Bun.file(`src/${rel}`).text())).toBe(true);
    }
  });
});
