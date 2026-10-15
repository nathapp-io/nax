import { describe, expect, test } from "bun:test";
import { type NextRoundInput, nextBranchFixRound } from "@/workflow/branch-fix-rounds";
import type { WorkflowFinding } from "@/workflow/types";

const f = (id: string, file?: string): WorkflowFinding => ({
  id,
  kind: "spec",
  severity: "important",
  issue: id,
  ...(file ? { file } : {}),
});
const input = (over: Partial<NextRoundInput>): NextRoundInput => ({
  round: 1,
  max: 2,
  followUp: false,
  items: [f("B1")],
  addressed: new Set(),
  open: [],
  added: [],
  fixBase: "base",
  changedFiles: async () => ["src/a.ts"],
  ...over,
});

describe("nextBranchFixRound (nax#2547)", () => {
  test("nothing open and nothing new: no round and no note", async () => {
    expect(await nextBranchFixRound(input({ addressed: new Set(["B1"]) }))).toEqual({ targets: [], notes: [] });
  });

  test("the cap reached with an item still open says so", async () => {
    const out = await nextBranchFixRound(input({ round: 2, open: [f("B1")] }));
    expect(out).toEqual({ targets: [], notes: ["branch fix rounds used: 2/2"] });
  });

  test("no fix base: still-open items are targets, new findings are not", async () => {
    const out = await nextBranchFixRound(input({ open: [f("B1")], added: [f("B2", "src/a.ts")], fixBase: undefined }));
    expect(out.targets).toEqual(["B1"]);
  });

  test("an open item the round was not asked about is not its target", async () => {
    const out = await nextBranchFixRound(input({ open: [f("B1"), f("B9")], items: [f("B1")] }));
    expect(out.targets).toEqual(["B1"]);
  });

  test("a follow-up that addressed only some items continues with the rest", async () => {
    const out = await nextBranchFixRound(
      input({
        round: 2,
        max: 3,
        followUp: true,
        items: [f("B1"), f("B2")],
        addressed: new Set(["B2"]),
        open: [f("B1")],
      }),
    );
    expect(out.targets).toEqual(["B1"]);
  });
});
