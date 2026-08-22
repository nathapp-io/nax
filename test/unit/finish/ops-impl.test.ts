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
    _finishOpsDeps.callOp = (async (_ctx: CallContext, _op: unknown, input: { since?: string; gaps?: string[] }) => {
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

  test("escalate pushes partial fixes by default", async () => {
    const { deps, calls } = baseDeps();
    await createFinishOps(deps).escalate(state, "needs a human", []);
    expect(calls.some((c) => c[0] === "push")).toBe(true);
  });

  // Post-review CRITICAL: `commitAndPush` pushes unconditionally — a
  // `committed: false` does NOT skip the `git push --set-upstream`. On the
  // closed-PR route (#1674 part 2) that push can recreate a head branch the
  // forge deleted when the human closed the PR, and nothing has run at that
  // point for it to be carrying anyway.
  test("escalate with push:false makes no commit and no push, but still delivers", async () => {
    const { deps, calls } = baseDeps();
    const outcome = await createFinishOps(deps).escalate(state, "the PR is closed", [], { push: false });

    expect(calls.some((c) => c[0] === "push")).toBe(false);
    expect(calls.some((c) => c[0] === "commit")).toBe(false);
    // The whole point of the route: the human is still told.
    expect(outcome.deliveryError).toBeUndefined();
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

  test("promotePr rejects when the push fails, per D4.6", async () => {
    const { deps } = baseDeps();
    _finishGitDeps.git = async (args: string[]) => {
      if (args[0] === "push") return { exitCode: 1, stdout: "", stderr: "remote rejected" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await expect(createFinishOps(deps).promotePr(state)).rejects.toThrow(/remote rejected/);
  });

  test("escalate appends a sync note to the comment when the partial-fix push fails, per D4.7", async () => {
    let comment: string | undefined;
    const forge: ForgeDeps = {
      run: async (cmd) => {
        if (cmd.includes("view")) return { exitCode: 1, stdout: "", stderr: "" };
        if (cmd.includes("create")) {
          comment = cmd[cmd.indexOf("--body") + 1];
          return { exitCode: 0, stdout: "https://x/1", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      readText: async () => null,
    };
    const { deps } = baseDeps({ forge });
    _finishGitDeps.git = async (args: string[]) => {
      if (args[0] === "push") return { exitCode: 1, stdout: "", stderr: "no upstream" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await createFinishOps(deps).escalate(state, "needs a human", []);
    expect(comment).toContain("nax-finish could not push its partial fixes");
    expect(comment).toContain("no upstream");
  });

  test("escalate returns the delivered url on a successful comment", async () => {
    const { deps } = baseDeps();
    const outcome = await createFinishOps(deps).escalate(state, "needs a human", []);
    expect(outcome).toEqual({ url: "https://x/1" });
  });

  // #1674 part 3 (H2): promotePr/narrate must not clobber a human-edited PR
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

  test("narrate does not rewrite the body on a zero-commit already-ready run", async () => {
    let callOpCalled = false;
    _finishOpsDeps.callOp = (async () => {
      callOpCalled = true;
      return { narrative: "new narrative", title: "new title" };
    }) as typeof _finishOpsDeps.callOp;
    const untouched = freshState({ committedThisRun: false, status: "already-ready" });
    const { deps, calls } = baseDeps();
    await createFinishOps(deps).narrate?.(untouched);
    expect(callOpCalled).toBe(false);
    expect(calls.find((c) => c.includes("edit"))).toBeUndefined();
  });

  test("narrate rewrites the body when this run committed a fix, even if already-ready", async () => {
    _finishOpsDeps.callOp = (async () => ({
      narrative: "new narrative",
      title: "new title",
    })) as typeof _finishOpsDeps.callOp;
    const committed = freshState({ committedThisRun: true, status: "already-ready" });
    const { deps, calls } = baseDeps();
    await createFinishOps(deps).narrate?.(committed);
    expect(calls.find((c) => c.includes("edit"))).toBeDefined();
  });

  test("narrate rewrites the body when this run opened or promoted the PR, regardless of commits", async () => {
    _finishOpsDeps.callOp = (async () => ({
      narrative: "new narrative",
      title: "new title",
    })) as typeof _finishOpsDeps.callOp;
    const opened = freshState({ committedThisRun: false, status: "opened" });
    const { deps, calls } = baseDeps();
    await createFinishOps(deps).narrate?.(opened);
    expect(calls.find((c) => c.includes("edit"))).toBeDefined();
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
