import { describe, expect, test } from "bun:test";
import { runReviewRound } from "@/finish/review-round";
import type { FinishReviewOutput } from "@/finish/types";

const ok = (title: string): FinishReviewOutput => ({
  findings: [{ severity: "LOW", title, problem: "p", fix: "f" }],
  covered: [],
});

describe("runReviewRound", () => {
  test("runs both lenses concurrently", async () => {
    const order: string[] = [];
    let releaseSpec: () => void = () => {};
    const specGate = new Promise<void>((r) => {
      releaseSpec = r;
    });
    const result = runReviewRound({
      spec: async () => {
        order.push("spec:start");
        await specGate;
        order.push("spec:end");
        return ok("s");
      },
      quality: async () => {
        order.push("quality:start");
        releaseSpec();
        return ok("q");
      },
    });
    await result;
    expect(order.slice(0, 2).sort()).toEqual(["quality:start", "spec:start"]);
  });

  test("a throwing lens is missing and does not cancel the other", async () => {
    const out = await runReviewRound({
      spec: async () => {
        throw new Error("timeout");
      },
      quality: async () => ok("q"),
    });
    expect(out.missing).toEqual(["spec"]);
    expect(out.spec).toEqual({ findings: [], covered: [], missing: true });
    expect(out.quality.findings[0]?.title).toBe("q");
  });

  test("a lens that returned missing is listed as missing", async () => {
    const out = await runReviewRound({
      spec: async () => ({ findings: [], covered: [], missing: true }),
      quality: async () => ok("q"),
    });
    expect(out.missing).toEqual(["spec"]);
  });
});
