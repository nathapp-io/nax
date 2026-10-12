import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { guardAcceptanceEdits } from "@/finish";
import { commitAll, git, withRepo } from "./set-aside-fixture";

const ACC = "test/acceptance/feat file.test.ts"; // a space on purpose (Review Focus 4)
const original = "// AC-40 envelope\nexpect(envelope);\n// AC-51 cost\nexpect(cost);\n";
const NONE = { reverted: [], notRestorable: [], changed: [], beyondRuling: [], failed: false };

async function seed(dir: string): Promise<void> {
  await mkdir(join(dir, "test/acceptance"), { recursive: true });
  await writeFile(join(dir, ACC), original);
  await commitAll(dir, "acceptance");
}

describe("guardAcceptanceEdits (real git)", () => {
  test("an unauthorised edit is restored from HEAD; other edits stay", async () => {
    await withRepo(async (dir) => {
      await seed(dir);
      await writeFile(join(dir, ACC), original.replace("expect(cost)", "// removed"));
      await writeFile(join(dir, "a.ts"), "export const a = 2;\n");
      const out = await guardAcceptanceEdits({ workdir: dir, paths: [ACC], allowed: [] });
      expect(out).toEqual({ ...NONE, reverted: [ACC] });
      expect(await Bun.file(join(dir, ACC)).text()).toBe(original);
      expect(await git(dir, "status", "--porcelain")).toContain("a.ts");
    });
  });

  test("an authorised edit is kept; changed ACs recorded; a changed AC outside the ruling is flagged", async () => {
    await withRepo(async (dir) => {
      await seed(dir);
      await writeFile(
        join(dir, ACC),
        original.replace("expect(envelope)", "expect(flat)").replace("expect(cost)", "// gone"),
      );
      const out = await guardAcceptanceEdits({
        workdir: dir,
        paths: [ACC],
        allowed: [{ testPath: ACC, acIds: ["AC-40"] }],
      });
      expect(out.reverted).toEqual([]);
      expect([...out.changed].sort()).toEqual(["AC-40", "AC-51"]);
      expect(out.beyondRuling).toEqual(["AC-51"]);
      expect(await Bun.file(join(dir, ACC)).text()).toContain("expect(flat)");
    });
  });

  test("untouched acceptance file: nothing reported", async () => {
    await withRepo(async (dir) => {
      await seed(dir);
      expect(await guardAcceptanceEdits({ workdir: dir, paths: [ACC], allowed: [] })).toEqual(NONE);
    });
  });

  test("an untracked acceptance file absent at HEAD is left alone and reported not restorable (Review Focus 4)", async () => {
    await withRepo(async (dir) => {
      await mkdir(join(dir, "test/acceptance"), { recursive: true });
      await writeFile(join(dir, ACC), "// AC-1 new\n");
      const out = await guardAcceptanceEdits({ workdir: dir, paths: [ACC], allowed: [] });
      expect(out).toEqual({ ...NONE, notRestorable: [ACC] });
      expect(await Bun.file(join(dir, ACC)).exists()).toBe(true);
    });
  });

  test("a staged-new acceptance file absent at HEAD is reported not restorable, not deleted", async () => {
    await withRepo(async (dir) => {
      await mkdir(join(dir, "test/acceptance"), { recursive: true });
      await writeFile(join(dir, ACC), "// AC-1 new\n");
      await git(dir, "add", "--", ACC);
      const out = await guardAcceptanceEdits({ workdir: dir, paths: [ACC], allowed: [] });
      expect(out).toEqual({ ...NONE, notRestorable: [ACC] });
      expect(await Bun.file(join(dir, ACC)).exists()).toBe(true);
    });
  });
});
