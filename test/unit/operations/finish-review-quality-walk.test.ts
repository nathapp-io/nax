/**
 * US-002 / AC15 — `finishReviewOp.verify` threads `base` and `phase` and
 * invokes the changed-file git command with `<base>...HEAD`.
 *
 * The op's `verify` hook now consults `_gitDeps.spawn` to learn which files
 * the diff touched; this test stubs the spawn seam and asserts the spawned
 * command line contains the review range verbatim.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeTestRuntime, opSelector, withTempDir } from "@test/helpers";
import type { FinishReviewInput } from "@/operations";
import { finishReviewOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { _gitDeps } from "@/utils/git";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  // Restore real spawn before runtimes tear down (defensive — nothing here uses them).
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

function makeCtx() {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(opSelector(finishReviewOp.config)) };
}

const QUALITY_INPUT: FinishReviewInput = {
  phase: "quality",
  base: "origin/main",
  specPath: "docs/specs/example.md",
  workdir: "/tmp/finish-review-quality-walk-test",
};

describe("AC15 — finishReviewOp.verify invokes git with the review range", () => {
  test("spawn receives arguments containing `origin/main...HEAD` for a quality input", async () => {
    const calls: string[][] = [];
    const spy = mock((args: string[]) => {
      calls.push(args);
      return {
        exited: Promise.resolve(0),
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(""));
            c.close();
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        kill: () => {},
      } as unknown as ReturnType<typeof _gitDeps.spawn>; // test-ratchet-allow: as-unknown-as
    }) as unknown as typeof _gitDeps.spawn; // test-ratchet-allow: as-unknown-as
    const orig = _gitDeps.spawn;
    _gitDeps.spawn = spy;
    try {
      await withTempDir(async (dir) => {
        const ctx = makeCtx();
        const parsed = finishReviewOp.parse("[HIGH] Some finding\nProblem: p\nFix: f", QUALITY_INPUT, ctx);
        await finishReviewOp.verify(
          parsed,
          { ...QUALITY_INPUT, workdir: dir },
          {
            ...ctx,
            readFile: async () => null,
            fileExists: async () => false,
          },
        );
      });
    } finally {
      _gitDeps.spawn = orig;
    }
    // The changed-file listing must reference the review range.
    const sawRange = calls.some((args) => args.some((arg) => arg.includes("origin/main...HEAD")));
    expect(sawRange).toBe(true);
  });
});
