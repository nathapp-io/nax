import { afterEach, describe, expect, test } from "bun:test";
import { _reviewerGuardDeps } from "@/review/reviewer-guard";
import { createRunTurnHooks } from "@/runtime/run-turn-hooks";
import type { SessionDescriptor } from "@/session";

const saved = { ..._reviewerGuardDeps };

afterEach(() => {
  Object.assign(_reviewerGuardDeps, saved);
});

describe("createRunTurnHooks (nax#2500, #2497)", () => {
  test("after: reviewer restore runs before the run-state repair; before: reviewer snapshot", async () => {
    const order: string[] = [];
    _reviewerGuardDeps.toplevel = async () => "/repo";
    _reviewerGuardDeps.take = async () => {
      order.push("take");
      return {
        toplevel: "/repo",
        tree: "t",
        indexTree: "i",
        head: "h",
        symbolicHead: undefined,
        refs: [],
        replaceRefs: [],
        stashes: [],
        ignoreFiles: [],
      };
    };
    _reviewerGuardDeps.restore = async () => {
      order.push("restore");
      return { paths: [], indexRestored: false, headRestored: false, refsLeft: [], stashLeft: [], failures: [] };
    };
    const hooks = createRunTurnHooks({ repairRunState: async () => void order.push("repair") });
    const d: SessionDescriptor = {
      id: "s",
      role: "wf-branch-review",
      state: "RUNNING",
      agent: "claude",
      workdir: "/repo",
      storyId: "US-1",
      protocolIds: { recordId: null, sessionId: null },
      completedStages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    };
    await hooks.before?.(d);
    await hooks.after?.(d, 1);
    expect(order).toEqual(["take", "restore", "repair"]);
  });
});
