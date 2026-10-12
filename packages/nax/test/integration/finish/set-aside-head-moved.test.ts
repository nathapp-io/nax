/** Real git: a session that committed before it was stopped must not have its commit reverted by the set-aside. */
import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertDefined, makeFinishOps, makeFinishState } from "@test/helpers";
import { commitFixes } from "@/finish/commit";
import { runFixStep } from "@/finish/fix-step";
import { git, now, withRepo } from "./set-aside-fixture";

const finding = { severity: "LOW" as const, title: "t", problem: "p", fix: "f" };

describe("set-aside when the stopped session moved HEAD (real git)", () => {
  test("the session's commit stays, the tree is not its reverse, and only uncommitted edits are saved", async () => {
    await withRepo(async (dir, audit) => {
      const state = makeFinishState({ workdir: dir });
      const ops = makeFinishOps(
        [],
        {},
        {
          fix: async () => {
            await writeFile(join(dir, "a.ts"), "export const a = 'committed';\n");
            await git(dir, "commit", "-q", "-am", "session commit");
            await writeFile(join(dir, "keep.ts"), "export const keep = 'uncommitted';\n");
            return { interrupted: true };
          },
        },
      );
      const result = await runFixStep(state, { ops, audit, now }, "review", { findings: [finding] });
      expect(result.kind).toBe("stopped");
      const record = state.handoffs[0];
      assertDefined(record, "handoff");
      expect(record.headMoved).toBe(true);
      expect(record.restored).toBe(true);
      expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("export const a = 'committed';\n");
      expect(await readFile(join(dir, "keep.ts"), "utf8")).toBe("export const keep = 1;\n");
      expect((await git(dir, "status", "--porcelain")).trim()).toBe("");
      const patch = await readFile(join(record.dir, "changes.patch"), "utf8");
      expect(patch).toContain("uncommitted");
      expect(patch).not.toContain("a.ts");
      const next = await commitFixes(dir, "chore: next", { skipHooks: true });
      expect(next.committed).toBe(false);
    });
  });
});
