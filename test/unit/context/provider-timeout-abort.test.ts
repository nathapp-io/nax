import { describe, expect, test } from "bun:test";
import { ContextOrchestrator, fetchWithTimeout } from "@/context/engine/orchestrator";

describe("fetchWithTimeout", () => {
  test("aborts the losing provider fetch when the timeout wins and does not throw unhandled", async () => {
    let aborted = false;
    const slowProvider = {
      id: "slow",
      fetch: (_req: any, signal?: AbortSignal) =>
        new Promise((_res, rej) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            rej(new Error("aborted"));
          });
          // never resolves on its own
        }),
    };
    await expect(fetchWithTimeout(slowProvider as any, {} as any, 20)).rejects.toThrow(/timed out/);
    // Give the abort event a tick to fire
    await new Promise((r) => setTimeout(r, 5));
    expect(aborted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gap finding 16: the per-provider timeout is spec'd as configuration
// (SPEC-context-engine-v2.md:841, `providerTimeoutMs`, min 1000 default 5000)
// and consumed per-stage (:330), but the orchestrator hardcoded a 5s constant.
// fetchWithTimeout always accepted a timeoutMs argument — nothing ever passed a
// configured one.
// ─────────────────────────────────────────────────────────────────────────────

describe("ContextOrchestrator — configurable provider timeout", () => {
  function slowProvider(delayMs: number) {
    return {
      id: "slow",
      kind: "retrieved" as const,
      fetch: async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        return {
          chunks: [
            {
              id: "slow:1",
              kind: "retrieved",
              scope: "retrieved",
              role: ["all"],
              content: "x",
              tokens: 1,
              rawScore: 1,
            },
          ],
          pullTools: [],
        };
      },
    };
  }

  const REQ = {
    storyId: "US-001",
    repoRoot: "/p",
    packageDir: "/p",
    stage: "execution",
    role: "implementer",
    budgetTokens: 8000,
    providerIds: ["slow"],
  };

  test("drops a provider that exceeds request.providerTimeoutMs", async () => {
    const orch = new ContextOrchestrator([slowProvider(80) as never]);
    const bundle = await orch.assemble({ ...REQ, providerTimeoutMs: 10 } as never);
    expect(bundle.manifest.includedChunks).toHaveLength(0);
  });

  test("keeps a provider that finishes within request.providerTimeoutMs", async () => {
    const orch = new ContextOrchestrator([slowProvider(10) as never]);
    const bundle = await orch.assemble({ ...REQ, providerTimeoutMs: 400 } as never);
    expect(bundle.manifest.includedChunks).toHaveLength(1);
  });
});
