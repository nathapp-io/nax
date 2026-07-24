import { afterEach, describe, expect, test } from "bun:test";
import { _resultDeps, resultPath, writeResult } from "@flows/nax-finish/steps/result";

const originalWriteText = _resultDeps.writeText;
afterEach(() => {
  _resultDeps.writeText = originalWriteText;
});

describe("writeResult", () => {
  test("writes the result JSON to .nax/nax-finish-result.json", async () => {
    let wrote: { p: string; s: string } | null = null;
    _resultDeps.writeText = async (p, s) => {
      wrote = { p, s };
    };
    await writeResult("/repo", { feature: "x", status: "escalated", escalationReason: "design call" });
    expect(wrote!.p).toBe(resultPath("/repo"));
    expect(JSON.parse(wrote!.s)).toMatchObject({ feature: "x", status: "escalated", escalationReason: "design call" });
  });
});
