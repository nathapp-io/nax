/**
 * Finish A, real git: a fix step must not commit past a restore-failed handoff. The half-edit a failed
 * restore left in the tree is set aside (with that session's own base) before the next fixer starts, so
 * the next fix commit cannot contain it.
 */
import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertDefined, makeFinishOps, makeFinishState } from "@test/helpers";
import { commitFixes } from "@/finish";
import { runFixStep } from "@/finish/fix-step";
import { failGit, git, now, withRepo } from "./set-aside-fixture";

const finding = { severity: "LOW" as const, title: "t", problem: "p", fix: "f" };
const HALF = "export const a = 'half edit';\n";
const FIXED = "export const keep = 'real fix';\n";

type Audit = { auditDir: string; runId: string };

/** Session 1 edits a.ts then throws while `git restore` is failing: its restore fails and leaves the half-edit. */
async function failedSession(dir: string, audit: Audit, state: ReturnType<typeof makeFinishState>) {
  const ops = makeFinishOps(
    [],
    {},
    {
      fix: async () => {
        await writeFile(join(dir, "a.ts"), HALF);
        throw new Error("agent crashed");
      },
    },
  );
  const undo = failGit((args) => args.includes("restore"));
  try {
    await runFixStep(state, { ops, audit, now }, "review", { findings: [finding] });
  } finally {
    undo();
  }
}

const realFix = (dir: string) =>
  makeFinishOps(
    [],
    {},
    {
      fix: async () => {
        await writeFile(join(dir, "keep.ts"), FIXED);
        return { dispositions: [{ index: 1, disposition: "fixed" as const }] };
      },
    },
  );

describe("runFixStep after a restore-failed handoff (real git)", () => {
  test("the leftover half-edit is set aside first, so the new fixer's commit does not contain it", async () => {
    await withRepo(async (dir, audit) => {
      const state = makeFinishState({ workdir: dir });
      await failedSession(dir, audit, state);
      expect(state.handoffs[0]?.restored).toBe(false);
      expect(await readFile(join(dir, "a.ts"), "utf8")).toBe(HALF);

      const step = await runFixStep(state, { ops: realFix(dir), audit, now }, "review", { findings: [finding] });
      expect(step.kind).toBe("done");

      const commit = await commitFixes(dir, "fix: step 2", { skipHooks: true, excludeDir: audit.auditDir });
      expect(commit.committed).toBe(true);
      expect(await git(dir, "show", "--name-only", "--format=", "HEAD")).toBe("keep.ts\n");
      expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("export const a = 1;\n");
      const extra = state.handoffs[1];
      assertDefined(extra, "the leftover handoff");
      expect(extra.restored).toBe(true);
      expect(await readFile(join(extra.dir, "changes.patch"), "utf8")).toContain("half edit");
      expect(state.handoffs[0]?.settledBy).toBe(2);
    });
  });

  test("once settled the guard does not fire again, and finalize has nothing left to set aside", async () => {
    await withRepo(async (dir, audit) => {
      const state = makeFinishState({ workdir: dir });
      await failedSession(dir, audit, state);
      await runFixStep(state, { ops: realFix(dir), audit, now }, "review", { findings: [finding] });
      await commitFixes(dir, "fix: step 2", { skipHooks: true, excludeDir: audit.auditDir });
      // An unrelated later dirt (a gate's auto-fix) must not be mistaken for the old half-edit.
      await writeFile(join(dir, "a.ts"), "export const a = 'gate autofix';\n");
      const count = state.handoffs.length;
      const step = await runFixStep(state, { ops: realFix(dir), audit, now }, "review", { findings: [finding] });
      expect(step.kind).toBe("done");
      expect(state.handoffs).toHaveLength(count);
      expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("export const a = 'gate autofix';\n");
    });
  });

  test("one set-aside that cleans the tree settles every older restore-failed handoff", async () => {
    await withRepo(async (dir, audit) => {
      const state = makeFinishState({ workdir: dir });
      await failedSession(dir, audit, state);
      const first = state.handoffs[0];
      assertDefined(first, "handoff 1");
      state.handoffs = [...state.handoffs, { ...first, n: 2 }]; // a second failed record over the same half-edit
      await runFixStep(state, { ops: realFix(dir), audit, now }, "review", { findings: [finding] });
      expect(state.handoffs).toHaveLength(3);
      expect(state.handoffs.map((h) => h.settledBy)).toEqual([3, 3, undefined]);
    });
  });

  test("a clean tree after a failed restore does not trigger the guard", async () => {
    await withRepo(async (dir, audit) => {
      const state = makeFinishState({ workdir: dir });
      await failedSession(dir, audit, state);
      await git(dir, "checkout", "--", "a.ts"); // the user cleaned it
      const step = await runFixStep(state, { ops: realFix(dir), audit, now }, "review", { findings: [finding] });
      expect(step.kind).toBe("done");
      expect(state.handoffs).toHaveLength(1);
    });
  });

  test("when the leftover cannot be set aside, the step fails, the fixer never runs and nothing is committed", async () => {
    await withRepo(async (dir, audit) => {
      const state = makeFinishState({ workdir: dir });
      await failedSession(dir, audit, state);
      const head = (await git(dir, "rev-parse", "HEAD")).trim();
      let fixerRan = false;
      const ops = makeFinishOps(
        [],
        {},
        {
          fix: async () => {
            fixerRan = true;
            return { dispositions: [] };
          },
        },
      );
      const undo = failGit((args) => args.includes("restore"));
      let step: Awaited<ReturnType<typeof runFixStep>>;
      try {
        step = await runFixStep(state, { ops, audit, now }, "review", { findings: [finding] });
      } finally {
        undo();
      }
      expect(step.kind).toBe("failed");
      expect(fixerRan).toBe(false);
      expect((await git(dir, "rev-parse", "HEAD")).trim()).toBe(head);
      expect(await readFile(join(dir, "a.ts"), "utf8")).toBe(HALF);
      expect(state.handoffs.filter((h) => !h.restored && h.settledBy === undefined).length).toBeGreaterThan(0);
    });
  });
});
