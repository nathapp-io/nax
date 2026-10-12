/**
 * The `FinishOps` factory's forge-facing contract: `promotePr` pushes before it
 * talks to the forge and gates its PR-body write on whether this run committed;
 * `openDraftPr` never throws; `fix` hands the phase straight to the op. The LLM
 * ops are stubbed through `_finishOpsDeps.callOp`; the forge and git seams are
 * stubbed to record the commands they were handed. The A4 review ops and
 * `finalizeDraftPr` are covered in `ops-impl-a4.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { _finishGitDeps, _finishOpsDeps, createFinishOps, createFinishState } from "@/finish";
import type { ForgeDeps } from "@/forge";
import type { CallContext } from "@/operations";
import { HANDOFF_TURN_MS } from "@/operations";
import { STEP_TIMEOUT_MARGIN_MS } from "@/utils/step-signal";

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
  test("promotePr pushes before it talks to the forge", async () => {
    const { deps, calls } = baseDeps();
    await createFinishOps(deps).promotePr(state);
    const pushIndex = calls.findIndex((c) => c.includes("push"));
    const forgeIndex = calls.findIndex((c) => c[0] === "gh");
    expect(pushIndex).toBeGreaterThanOrEqual(0);
    expect(pushIndex).toBeLessThan(forgeIndex);
  });

  test("promotePr rejects when the push fails, per D4.6", async () => {
    const { deps } = baseDeps();
    _finishGitDeps.git = async (args: string[]) => {
      if (args[0] === "push") return { exitCode: 1, stdout: "", stderr: "remote rejected" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await expect(createFinishOps(deps).promotePr(state)).rejects.toThrow(/remote rejected/);
  });

  // #1674 part 3 (H2): promotePr must not clobber a human-edited PR
  // description on a run that found the PR already ready and committed
  // nothing of its own.
  function freshState(overrides: { committedThisRun?: boolean; status?: string } = {}) {
    const s = createFinishState({
      feature: "demo",
      workdir: "/repo",
      branch: "feat/demo",
      runId: "run-1",
      base: "origin/main",
      specPath: "spec.md",
    });
    if (overrides.committedThisRun !== undefined) s.committedThisRun = overrides.committedThisRun;
    if (overrides.status !== undefined) s.status = overrides.status as typeof s.status;
    return s;
  }

  test("promotePr does not write the body on already-ready with zero commits this run", async () => {
    const untouched = freshState({ committedThisRun: false });
    const { deps, calls } = baseDeps();
    await createFinishOps(deps).promotePr(untouched);
    const editCall = calls.find((c) => c.includes("edit"));
    expect(editCall).toBeUndefined();
  });

  test("promotePr writes the body on already-ready when this run committed a fix", async () => {
    const committed = freshState({ committedThisRun: true });
    const { deps, calls } = baseDeps();
    await createFinishOps(deps).promotePr(committed);
    const editCall = calls.find((c) => c.includes("edit"));
    expect(editCall).toBeDefined();
  });

  // #1674 part 3 review fix: `commitAndPush` inside `promotePr` is a FOURTH
  // commit site machine.ts's three fix-loop sites do not cover — the terminal
  // gate pass can leave the tree dirty on its own even when every fix loop
  // finished clean. `committedThisRun` must be folded in from `commitAndPush`'s
  // own return value before `openOrPromotePr` reads it, or a run that pushed a
  // real commit here still gets its body write skipped.
  test("promotePr commits a dirty tree at the terminal step and still writes the body, even though committedThisRun was false going in", async () => {
    const untouched = freshState({ committedThisRun: false });
    const { deps, calls } = baseDeps();
    _finishGitDeps.git = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "status") return { exitCode: 0, stdout: " M some-file.ts\n", stderr: "" };
      if (args[0] === "diff") return { exitCode: 1, stdout: "", stderr: "" }; // staged
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await createFinishOps(deps).promotePr(untouched);
    const commitCall = calls.find((c) => c[0] === "commit");
    expect(commitCall).toBeDefined();
    expect(untouched.committedThisRun).toBe(true);
    const editCall = calls.find((c) => c.includes("edit"));
    expect(editCall).toBeDefined();
  });

  test("promotePr on a clean tree at the terminal step still does not write the body when committedThisRun was false going in", async () => {
    const untouched = freshState({ committedThisRun: false });
    const { deps, calls } = baseDeps();
    // baseDeps' default `_finishGitDeps.git` already reports a clean tree
    // (empty `status --porcelain` stdout) — asserted explicitly here so this
    // test pins "no over-correction" even if that default ever changes.
    await createFinishOps(deps).promotePr(untouched);
    const commitCall = calls.find((c) => c[0] === "commit");
    expect(commitCall).toBeUndefined();
    expect(untouched.committedThisRun).toBe(false);
    const editCall = calls.find((c) => c.includes("edit"));
    expect(editCall).toBeUndefined();
  });

  test("fix passes the phase straight to the op, with no remapping", async () => {
    let seenPhase: string | undefined;
    _finishOpsDeps.callOp = (async (_ctx: CallContext, _op: unknown, input: { phase: string }) => {
      seenPhase = input.phase;
      return {};
    }) as typeof _finishOpsDeps.callOp;
    const { deps } = baseDeps();
    await createFinishOps(deps).fix("review", { state, findings: [] });
    expect(seenPhase).toBe("review");
  });

  test("fix: hard signal is the run's, the interrupt and continuation pass through, timeoutMs adds the handoff turn and margin", async () => {
    let seenCtx: CallContext | undefined;
    let seenInput: Record<string, unknown> | undefined;
    _finishOpsDeps.callOp = (async (ctx: CallContext, _op: unknown, input: Record<string, unknown>) => {
      seenCtx = ctx;
      seenInput = input;
      return {};
    }) as typeof _finishOpsDeps.callOp;
    const { deps } = baseDeps();
    const runSignal = new AbortController().signal;
    const phaseSignal = new AbortController().signal;
    const interrupt = new AbortController().signal;
    const continuation = { note: { findings: [] }, files: ["a.ts"] };
    await createFinishOps({
      ...deps,
      callCtx: { ...deps.callCtx, signal: phaseSignal },
      runSignal,
      timeouts: { fixMs: 7_000 },
    }).fix("review", { state, findings: [], interrupt, continuation });
    expect(seenCtx?.signal).toBe(runSignal);
    expect(seenInput?.timeoutMs).toBe(7_000 + HANDOFF_TURN_MS + STEP_TIMEOUT_MARGIN_MS);
    expect(seenInput?.interrupt).toBe(interrupt);
    expect(seenInput?.continuation).toBe(continuation);
  });

  test("openDraftPr returns null rather than throwing when the forge cannot be spawned, per D4.5", async () => {
    const forge: ForgeDeps = {
      run: async () => {
        throw new Error("gh missing");
      },
      readText: async () => null,
    };
    const { deps } = baseDeps({ forge });
    await expect(createFinishOps(deps).openDraftPr(state)).resolves.toBeNull();
  });
});
