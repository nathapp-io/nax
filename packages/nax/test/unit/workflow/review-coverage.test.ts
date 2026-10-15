import { afterEach, describe, expect, test } from "bun:test";
import { makeNaxConfig, makeResolvedTestPatterns, withWarnSpy } from "@test/helpers";
import { reviewRequiredFiles } from "@/workflow/review-coverage";
import { _workflowDeps } from "@/workflow/step-context";

const original = { ..._workflowDeps };
afterEach(() => {
  Object.assign(_workflowDeps, original);
});

/** The `Pick<FeatureContext, …>` slice `reviewRequiredFiles` reads. */
function fc(over: { packageDirs?: readonly string[] } = {}) {
  return { config: makeNaxConfig(), projectDir: "/repo", packageDirs: over.packageDirs ?? [] };
}

/** Stub the resolver dep, recording the package dir each resolution asked for. */
function stubPatterns(seen: (string | undefined)[], regex: readonly RegExp[]): void {
  _workflowDeps.resolveTestPatterns = async (_config, _workdir, packageDir) => {
    seen.push(packageDir);
    return makeResolvedTestPatterns({ regex: [...regex] });
  };
}

describe("reviewRequiredFiles", () => {
  test("drops a test file classified by its owning package's patterns (AC-10)", async () => {
    const seen: (string | undefined)[] = [];
    stubPatterns(seen, [/\.spec\.ts$/]);
    const required = await reviewRequiredFiles(
      ["apps/api/src/x.ts", "apps/api/src/x.spec.ts"],
      fc({ packageDirs: ["apps/api"] }),
    );
    expect(required).toEqual(["apps/api/src/x.ts"]);
    expect(seen).toEqual(["apps/api"]);
  });

  test("a path under no package dir uses the root patterns (packageDir undefined) (AC-11)", async () => {
    const seen: (string | undefined)[] = [];
    stubPatterns(seen, [/\.spec\.ts$/]);
    const required = await reviewRequiredFiles(["scripts/root.spec.ts"], fc({ packageDirs: ["apps/api"] }));
    expect(required).toEqual([]);
    expect(seen).toEqual([undefined]);
  });

  test("the longest package dir that prefixes the path owns it (AC-12)", async () => {
    const seen: (string | undefined)[] = [];
    _workflowDeps.resolveTestPatterns = async (_config, _workdir, packageDir) => {
      seen.push(packageDir);
      return makeResolvedTestPatterns({ regex: packageDir === "apps/api" ? [/\.spec\.ts$/] : [] });
    };
    const required = await reviewRequiredFiles(["apps/api/src/x.spec.ts"], fc({ packageDirs: ["apps", "apps/api"] }));
    expect(required).toEqual([]);
    expect(seen).toEqual(["apps/api"]);
  });

  test("drops documentation, lockfiles, images and documents by basename (AC-13)", async () => {
    stubPatterns([], []);
    const required = await reviewRequiredFiles(
      [
        "README.md",
        "docs/guide.mdx",
        "bun.lock",
        "package-lock.json",
        "go.sum",
        "img/logo.png",
        "doc/spec.pdf",
        "src/a.ts",
      ],
      fc(),
    );
    expect(required).toEqual(["src/a.ts"]);
  });

  test("the non-source match is on the basename, case-insensitively, at any depth (AC-14)", async () => {
    stubPatterns([], []);
    const required = await reviewRequiredFiles(
      ["apps/api/bun.lock", "docs/README.MD", "img/Logo.PNG", "src/a.ts"],
      fc(),
    );
    expect(required).toEqual(["src/a.ts"]);
  });

  test("a resolver failure keeps the package's files and warns once (AC-16)", async () => {
    await withWarnSpy(async (warnSpy) => {
      _workflowDeps.resolveTestPatterns = async () => {
        throw new Error("no mono config");
      };
      const required = await reviewRequiredFiles(["apps/api/src/x.spec.ts"], fc({ packageDirs: ["apps/api"] }));
      expect(required).toEqual(["apps/api/src/x.spec.ts"]);
      const warns = warnSpy.mock.calls.filter((c) => c[0] === "workflow");
      expect(warns).toHaveLength(1);
      expect(warns[0]?.[2]).toMatchObject({ storyId: "_run" });
    });
  });
});
