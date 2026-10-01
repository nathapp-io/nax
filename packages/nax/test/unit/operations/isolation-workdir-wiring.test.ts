// RE-ARCH: keep
import { afterEach, describe, expect, test } from "bun:test";
import { makeMockCallContext, makeSpawn, makeStory } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { implementerOp } from "@/operations";
import { _isolationDeps } from "@/tdd";

const realSpawn = _isolationDeps.spawn;
afterEach(() => {
  _isolationDeps.spawn = realSpawn;
});

/**
 * Regression guard for the wrong-repo diff.
 *
 * packageView.packageDir is "" for the root package of a single-package repo.
 * Passing it straight to the isolation git calls made Bun.spawn fall back to
 * process.cwd(), so running nax against another directory with `-d` diffed the
 * LAUNCHING repo and failed every story with "fatal: bad object <sha>". The op
 * must resolve through packageWorkdir() and spawn against the repo root.
 */
describe("isolation git calls run in the package's real directory", () => {
  test("implementerOp.verify spawns git in repoRoot when packageDir is empty", async () => {
    const stub = makeSpawn(() => "src/foo.ts\n");
    _isolationDeps.spawn = stub.spawn;

    const base = makeMockCallContext().packageView;
    const ctx = {
      packageView: { ...base, packageDir: "", repoRoot: "/repo/root" },
      config: DEFAULT_CONFIG,
      readFile: async () => null,
      fileExists: async () => false,
    };
    const parsed = {
      success: true,
      filesChanged: ["src/foo.ts"],
      estimatedCostUsd: 0,
      durationMs: 0,
      output: "ok",
    };

    await implementerOp.verify?.(parsed, { story: makeStory({ id: "US-001" }), beforeRef: "HEAD~1" }, ctx);

    expect(stub.calls.length).toBeGreaterThan(0);
    for (const call of stub.calls) {
      expect(call.opts.cwd).toBe("/repo/root");
    }
  });
});
