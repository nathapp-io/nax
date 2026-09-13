import { describe, expect, test } from "bun:test";
import type { CommandInterceptor, InterceptRequest, InterceptResult } from "@/execution/command-interceptor";
import { interceptArgv, validateRewrite } from "@/execution/command-interceptor";

const req: InterceptRequest = { kind: "argv", argv: ["git", "log", "--oneline"], cwd: "/repo", site: "git" };

function fake(result: InterceptResult | (() => never)): CommandInterceptor {
  return { provider: "rtk", intercept: async () => (typeof result === "function" ? result() : result) };
}

describe("validateRewrite", () => {
  test("passes a rewrite that only prefixes the provider binary", () => {
    const result: InterceptResult = { kind: "rewritten", argv: ["rtk", "git", "log", "--oneline"], provider: "rtk" };
    expect(validateRewrite(req, result)).toEqual(result);
  });

  test("declines a rewrite that changes any original token", () => {
    expect(validateRewrite(req, { kind: "rewritten", argv: ["rtk", "git", "log", "-p"], provider: "rtk" }).kind).toBe(
      "declined",
    );
  });

  test("declines a rewrite of the wrong length", () => {
    expect(validateRewrite(req, { kind: "rewritten", argv: ["rtk", "git", "log"], provider: "rtk" }).kind).toBe(
      "declined",
    );
  });

  test("declines a rewrite whose first token is not the named provider", () => {
    expect(
      validateRewrite(req, { kind: "rewritten", argv: ["other", "git", "log", "--oneline"], provider: "rtk" }).kind,
    ).toBe("declined");
  });

  test("declines an escape flag carried in from the ORIGINAL argv", () => {
    // The length and token checks pass here, so this is the only test that
    // actually reaches the escape-flag branch. A rewrite cannot INTRODUCE a
    // flag without failing an earlier check — this guards the case where the
    // original argv already carried one (R6).
    const escaped: InterceptRequest = { ...req, argv: ["git", "-C", "/elsewhere", "status"] };
    const out = validateRewrite(escaped, {
      kind: "rewritten",
      argv: ["rtk", "git", "-C", "/elsewhere", "status"],
      provider: "rtk",
    });
    expect(out.kind).toBe("declined");
  });

  test("passes unchanged and declined results straight through", () => {
    expect(validateRewrite(req, { kind: "unchanged" })).toEqual({ kind: "unchanged" });
    const declined: InterceptResult = { kind: "declined", reason: "no binary" };
    expect(validateRewrite(req, declined)).toEqual(declined);
  });
});

describe("interceptArgv", () => {
  test("returns the original argv when there is no interceptor", async () => {
    const out = await interceptArgv(["git", "log"], "/repo", undefined);
    expect(out).toEqual({ argv: ["git", "log"], rewritten: false });
  });

  test("returns the rewritten argv and what executed", async () => {
    const out = await interceptArgv(
      ["git", "log"],
      "/repo",
      fake({ kind: "rewritten", argv: ["rtk", "git", "log"], provider: "rtk" }),
    );
    expect(out.argv).toEqual(["rtk", "git", "log"]);
    expect(out.executed).toEqual(["rtk", "git", "log"]);
    expect(out.provider).toBe("rtk");
    expect(out.rewritten).toBe(true);
  });

  test("falls back to the original argv when the interceptor throws", async () => {
    // Fail open at REWRITE time (R3). A sick interceptor must not fail a command.
    const out = await interceptArgv(
      ["git", "log"],
      "/repo",
      fake(() => {
        throw new Error("boom");
      }),
    );
    expect(out.argv).toEqual(["git", "log"]);
    expect(out.rewritten).toBe(false);
  });

  test("falls back to the original argv when the rewrite fails validation", async () => {
    const out = await interceptArgv(
      ["git", "log"],
      "/repo",
      fake({ kind: "rewritten", argv: ["rtk", "-C", "/x", "git", "log"], provider: "rtk" }),
    );
    expect(out.argv).toEqual(["git", "log"]);
    expect(out.rewritten).toBe(false);
  });
});

/** Only these may IMPORT the rtk provider. Naming rtk in a comment or a config default is fine. */
const MAY_IMPORT_RTK = new Set(["execution/lifecycle/run-setup.ts"]);

/**
 * Matches the alias form AND any relative spelling — `run-setup.ts` already
 * uses relative imports for its siblings (`../helpers`, `../crash-recovery`),
 * so an alias-only regex would match nothing and pass vacuously.
 */
const IMPORTS_RTK = /from\s+["'](?:@\/execution|\.{1,2}(?:\/\.\.)*)\/?.*interceptors\/rtk(?:\/index)?["']/;

describe("R10 / R1: interception stays where it belongs", () => {
  test("the Git tool is the only interception site", async () => {
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
