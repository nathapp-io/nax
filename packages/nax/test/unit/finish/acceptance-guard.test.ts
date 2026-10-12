import { afterEach, describe, expect, test } from "bun:test";
import { installFinishGit, makeFinishContext } from "@test/helpers";
import {
  acceptancePathsOf,
  allowedFrom,
  gateGuardPaths,
  guardAcceptanceEdits,
  guardWorthRecording,
  mergeGuard,
} from "@/finish";

let restoreGit: () => void = () => {};
afterEach(() => restoreGit());
const NONE = { reverted: [], notRestorable: [], changed: [], beyondRuling: [], failed: false };

describe("guardAcceptanceEdits with the test git stub", () => {
  test("a dirty tree whose only change is not an acceptance path triggers no restore (machine tests stay intact)", async () => {
    const trail: string[] = [];
    const model = { dirty: true, head: 1 };
    restoreGit = installFinishGit(model, trail);
    const out = await guardAcceptanceEdits({ workdir: "/repo", paths: ["test/acceptance/feat.test.ts"], allowed: [] });
    expect(out).toEqual(NONE);
    expect(trail).not.toContain("restore");
    expect(model.dirty).toBe(true);
  });

  test("no paths: nothing reported, no git call", async () => {
    const trail: string[] = [];
    restoreGit = installFinishGit({ dirty: true, head: 1 }, trail);
    expect(await guardAcceptanceEdits({ workdir: "/repo", paths: [], allowed: [] })).toEqual(NONE);
    expect(trail).toEqual([]);
  });
});

describe("path helpers", () => {
  test("acceptancePathsOf: existing groups only; none when acceptance is disabled", () => {
    const ctx = makeFinishContext();
    expect(acceptancePathsOf(ctx)).toEqual(["test/acceptance/feat.test.ts"]);
    expect(acceptancePathsOf({ ...ctx, acceptanceStatus: "disabled" })).toEqual([]);
    expect(acceptancePathsOf({ ...ctx, groups: ctx.groups.map((g) => ({ ...g, exists: false })) })).toEqual([]);
  });

  test("gateGuardPaths: a red acceptance gate is never guarded (A2-R1)", () => {
    const ctx = makeFinishContext();
    expect(gateGuardPaths(["acceptance"], ctx)).toEqual([]);
    expect(gateGuardPaths(["lint"], ctx)).toEqual(["test/acceptance/feat.test.ts"]);
  });

  test("allowedFrom unions the findings' allowed edits", () => {
    const f = { severity: "LOW" as const, title: "t", problem: "p", fix: "f" };
    expect(allowedFrom([f, { ...f, allowedAcceptanceEdits: [{ testPath: "a.ts", acIds: ["AC-1"] }] }])).toEqual([
      { testPath: "a.ts", acIds: ["AC-1"] },
    ]);
  });

  test("mergeGuard accumulates without duplicates; guardWorthRecording ignores a clean outcome", () => {
    const merged = mergeGuard({ ...NONE, reverted: ["a"] }, { ...NONE, reverted: ["a", "b"], failed: true });
    expect(merged).toEqual({ ...NONE, reverted: ["a", "b"], failed: true });
    expect(guardWorthRecording(NONE)).toBe(false);
    expect(guardWorthRecording({ ...NONE, changed: ["AC-1"] })).toBe(true);
  });
});
