/**
 * The `FinishOps` factory's contract (Task 6): per-phase role selection for
 * the review op, pass-through of the re-review window and gap notice, the
 * must-not-throw clauses for `escalate` and `narrate`, and the forge/delivery
 * interaction ordering. The three LLM ops are stubbed out through
 * `_finishOpsDeps.callOp`; the forge and git seams are stubbed to record the
 * commands they were handed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { _finishGitDeps, _finishOpsDeps, createFinishOps, createFinishState } from "@/finish";
import type { ForgeDeps } from "@/forge";
import type { CallContext } from "@/operations";

const originalOps = { ..._finishOpsDeps };
const originalGit = _finishGitDeps.git;
afterEach(() => {
  Object.assign(_finishOpsDeps, originalOps);
  _finishGitDeps.git = originalGit;
});

function baseDeps(overrides: Partial<Parameters<typeof createFinishOps>[0]> = {}) {
  const calls: string[][] = [];
  _finishGitDeps.git = async (args: string[]) => {
    calls.push(args);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const forge: ForgeDeps = {
    run: async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "https://x/1", stderr: "" };
    },
    readText: async () => null,
  };
  return {
    calls,
    deps: {
      callCtx: {} as CallContext,
      forge,
      forgeKind: "github" as const,
      audit: { auditDir: "/tmp/audit", runId: "run-1" },
      ...overrides,
    },
  };
}

const state = createFinishState({
  feature: "demo",
  workdir: "/repo",
  branch: "feat/demo",
  runId: "run-1",
  base: "origin/main",
  specPath: "spec.md",
});

describe("ops-impl", () => {
  test("review runs the spec phase under the finish-review-spec role", async () => {
    let seenRole: string | undefined;
    _finishOpsDeps.callOp = (async (ctx: CallContext) => {
      seenRole = ctx.sessionOverride?.role;
      return { findings: [], gaps: [], touchpoints: [], walk: [] };
    }) as typeof _finishOpsDeps.callOp;
    const { deps } = baseDeps();
    await createFinishOps(deps).review("spec", { state });
    expect(seenRole).toBe("finish-review-spec");
  });

  test("review runs the quality phase under the finish-review-quality role", async () => {
    let seenRole: string | undefined;
    _finishOpsDeps.callOp = (async (ctx: CallContext) => {
      seenRole = ctx.sessionOverride?.role;
      return { findings: [], gaps: [], touchpoints: [], walk: [] };
    }) as typeof _finishOpsDeps.callOp;
    const { deps } = baseDeps();
    await createFinishOps(deps).review("quality", { state });
    expect(seenRole).toBe("finish-review-quality");
  });

  test("review passes the phase's re-review window and gap notice through", async () => {
    let seenInput: { since?: string; gaps?: string[] } | undefined;
    _finishOpsDeps.callOp = (async (
      _ctx: CallContext,
      _op: unknown,
      input: { since?: string; gaps?: string[] },
    ) => {
      seenInput = input;
      return { findings: [], gaps: [], touchpoints: [], walk: [] };
    }) as typeof _finishOpsDeps.callOp;
    const windowed = createFinishState({ ...state });
    windowed.phases.spec.reviewSince = "abc123";
    windowed.phases.spec.reviewGaps = ["did not read src/a.ts"];
    const { deps } = baseDeps();
    await createFinishOps(deps).review("spec", { state: windowed });
    expect(seenInput?.since).toBe("abc123");
    expect(seenInput?.gaps).toEqual(["did not read src/a.ts"]);
  });

  test("review propagates a throw instead of swallowing it", async () => {
    _finishOpsDeps.callOp = (async () => {
      throw new Error("agent died");
    }) as typeof _finishOpsDeps.callOp;
    const { deps } = baseDeps();
    await expect(createFinishOps(deps).review("spec", { state })).rejects.toThrow("agent died");
  });

  test("narrate swallows a throw so a promoted run is not re-escalated", async () => {
    _finishOpsDeps.callOp = (async () => {
      throw new Error("narrator died");
    }) as typeof _finishOpsDeps.callOp;
    const { deps } = baseDeps();
    const ops = createFinishOps(deps);
    await expect(ops.narrate?.(state)).resolves.toBeUndefined();
  });

  test("narrate is absent when narrative is disabled", () => {
    const { deps } = baseDeps({ narrative: false });
    expect(createFinishOps(deps).narrate).toBeUndefined();
  });

  test("escalate reports a delivery failure rather than throwing", async () => {
    const forge: ForgeDeps = {
      run: async () => {
        throw new Error("gh missing");
      },
      readText: async () => null,
    };
    const { deps } = baseDeps({ forge });
    await expect(createFinishOps(deps).escalate(state, "needs a human", [])).resolves.toMatchObject({
      deliveryError: expect.stringContaining("gh missing"),
    });
  });

  test("escalate reports no forge as a delivery error", async () => {
    const { deps } = baseDeps({ forgeKind: null });
    const outcome = await createFinishOps(deps).escalate(state, "needs a human", []);
    expect(outcome.deliveryError).toBeTruthy();
  });

  test("promotePr pushes before it talks to the forge", async () => {
    const { deps, calls } = baseDeps();
    await createFinishOps(deps).promotePr(state);
    const pushIndex = calls.findIndex((c) => c.includes("push"));
    const forgeIndex = calls.findIndex((c) => c[0] === "gh");
    expect(pushIndex).toBeGreaterThanOrEqual(0);
    expect(pushIndex).toBeLessThan(forgeIndex);
  });

  test("escalate pushes partial fixes under the flow's wip commit message", async () => {
    const gitCalls: string[][] = [];
    const { deps } = baseDeps({ forgeKind: null });
    _finishGitDeps.git = async (args: string[]) => {
      gitCalls.push(args);
      if (args[0] === "status") return { exitCode: 0, stdout: " M file.ts\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await createFinishOps(deps).escalate(state, "needs a human", []);
    const commitArgv = gitCalls.find((c) => c[0] === "commit");
    expect(commitArgv).toBeDefined();
    expect(commitArgv?.join(" ")).toContain("wip(demo): nax-finish partial fixes before escalation");
  });
});
