/**
 * applyPostRunInspection — scratch-entry write failures.
 *
 * Each scratch write (self-verification, test-writer, verifier) is wrapped in
 * its own try/catch so a scratch-write failure never fails the story. These
 * tests force `appendScratchEntry`'s underlying `appendFile` to reject and
 * assert the inspection still completes normally.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeNaxConfig, makeTestContext } from "@test/helpers";
import { applyPostRunInspection } from "@/execution/post-run";
import { implementerOp, testWriterOp, verifierOp } from "@/operations";
import { _scratchWriterDeps } from "@/session/scratch-writer";
import { makeInspectionOpts, makePlanResult } from "./_post-run-fixtures";

describe("applyPostRunInspection — scratch-entry write failures are swallowed", () => {
  let origAppendFile: typeof _scratchWriterDeps.appendFile;
  let appendFileMock: ReturnType<typeof mock<typeof _scratchWriterDeps.appendFile>>;

  beforeEach(() => {
    origAppendFile = _scratchWriterDeps.appendFile;
    appendFileMock = mock(async () => {
      throw new Error("disk full");
    });
    _scratchWriterDeps.appendFile = appendFileMock;
  });

  afterEach(() => {
    _scratchWriterDeps.appendFile = origAppendFile;
  });

  test("self-verification scratch write failure does not throw and still returns a result", async () => {
    const ctx = makeTestContext({
      sessionScratchDir: "/tmp/nax-test-scratch",
      config: makeNaxConfig({ context: { v2: { enabled: true } } }),
    });
    const planResult = makePlanResult({
      success: true,
      phaseOutputs: { [implementerOp.name]: { success: true } },
    });

    const result = await applyPostRunInspection(ctx, planResult, makeInspectionOpts());

    expect(result.agentResult.success).toBe(true);
  });

  test("test-writer and verifier scratch write failures in TDD mode do not throw", async () => {
    const ctx = makeTestContext({
      sessionScratchDir: "/tmp/nax-test-scratch",
      config: makeNaxConfig({ context: { v2: { enabled: true } } }),
    });
    const planResult = makePlanResult({
      success: true,
      phaseOutputs: {
        [implementerOp.name]: { success: true },
        [testWriterOp.name]: { success: true, filesChanged: ["test/a.test.ts"], output: "wrote tests" },
        [verifierOp.name]: { success: true, filesChanged: [], output: "verified" },
      },
    });
    const opts = makeInspectionOpts({ tddMode: { isLite: false, rollbackEnabled: false } });

    const result = await applyPostRunInspection(ctx, planResult, opts);

    expect(result.agentResult.success).toBe(true);
    // appendFile was invoked (and rejected) for self-verification + test-writer + verifier.
    expect(appendFileMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
