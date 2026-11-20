import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeBotFixEnv } from "@test/helpers";
import { _fixStepsDeps, type BotFixState } from "@/bot/fix-steps";
import { repairStep } from "@/bot/repair-step";

const original = { ..._fixStepsDeps };
const state = (patch: Partial<BotFixState> = {}): BotFixState => ({ step: "repair", timings: {}, ...patch });

beforeEach(() => {
  _fixStepsDeps.runGit = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  _fixStepsDeps.readHead = async () => "fix-sha";
  _fixStepsDeps.runBranchFix = mock(async () => ({ dirty: false, autoCommitted: false }));
});
afterEach(() => Object.assign(_fixStepsDeps, original));

describe("repairStep patch", () => {
  test("US-005 AC-7: a failure-free repair session states fixFailure explicitly", async () => {
    const result = await repairStep(makeBotFixEnv(), state({ outcome: "gates-failed", fixFailure: "boom" }));
    expect(result.exit).toBe("ran");
    // The key must be present, not merely absent from the patch: `runStepGraph` reads a stated
    // `undefined` as a clear, which is what retires the earlier session's failure.
    expect(Object.hasOwn(result.patch ?? {}, "fixFailure")).toBe(true);
    expect(result.patch?.fixFailure).toBeUndefined();
  });

  test("a repair session that failed still records its own failure", async () => {
    _fixStepsDeps.runBranchFix = async () => ({ dirty: false, autoCommitted: false, failure: "second boom" });
    const result = await repairStep(makeBotFixEnv(), state({ outcome: "gates-failed" }));
    expect(result.patch).toMatchObject({ fixFailure: "second boom" });
  });
});
