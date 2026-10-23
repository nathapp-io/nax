import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { _editTargetsDeps, editTargets, firstOutsidePolicy } from "#src/client/edit-targets";

async function onPlatform<T>(platform: string, run: () => Promise<T>): Promise<T> {
  const original = _editTargetsDeps.platform;
  _editTargetsDeps.platform = () => platform;
  try {
    return await run();
  } finally {
    _editTargetsDeps.platform = original;
  }
}

let root: string;
let outside: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nax-edit-root-"));
  outside = await mkdtemp(join(tmpdir(), "nax-edit-out-"));
  await mkdir(join(root, ".git", "hooks"), { recursive: true });
  await symlink(outside, join(root, "escape"));
  await symlink(join(outside, "new-file.txt"), join(root, "dangling"));
  await symlink(join(root, "loopB"), join(root, "loopA"));
  await symlink(join(root, "loopA"), join(root, "loopB"));
  await symlink(join("..", basename(outside), "f.txt"), join(root, "up"));
  await symlink(join("sub", "target.txt"), join(root, "inroot"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});
const policy = () => ({
  writeRoots: [root],
  denyWrite: [join(root, ".git", "hooks")],
  denyRead: [],
  network: {},
});

describe("editTargets", () => {
  test.each(["edit", "delete", "move"])("%s extracts write-specific raw paths", (kind) => {
    expect(editTargets({ kind, rawInput: { path: "/a", filePath: "/b", old_path: "/c", new_path: "/d" } })).toEqual([
      "/a",
      "/b",
      "/c",
      "/d",
    ]);
  });
  test("other ignores rawInput.path", () => {
    expect(editTargets({ kind: "other", rawInput: { path: "/a" } })).toEqual([]);
  });
  test("locations, file_path and notebook_path, de-duplicated", () => {
    expect(
      editTargets({ locations: [{ path: "/a" }, { path: "/b" }], rawInput: { file_path: "/a", notebook_path: "/c" } }),
    ).toEqual(["/a", "/b", "/c"]);
  });
  test("nothing usable: empty", () => {
    expect(editTargets({ title: "Edit" })).toEqual([]);
  });
});

describe("firstOutsidePolicy", () => {
  test.each([
    ["AC-1 report", "report.md", true, true],
    ["AC-2 brief", "brief.md", true, false],
    ["AC-3 other story", "../US-004/report.md", true, false],
    ["AC-4 prd", "../../../prd.json", true, false],
    ["AC-5 no exemption", "report.md", false, false],
    ["AC-8 case-sensitive", "REPORT.md", true, false],
  ] as const)("%s", async (_name, file, exempt, allowed) => {
    const dir = join(root, ".nax/features/f/workflow/r/US-005");
    const report = join(dir, "report.md");
    const target = join(dir, file);
    const denied = { ...policy(), denyWrite: [join(root, ".nax/features")] };
    expect(await firstOutsidePolicy([target], denied, root, exempt ? report : undefined)).toBe(
      allowed ? undefined : target,
    );
  });
  test("AC-6 relative report resolves to the exemption", async () => {
    const relative = ".nax/features/f/workflow/r/US-005/report.md";
    expect(
      await firstOutsidePolicy(
        [relative],
        { ...policy(), denyWrite: [join(root, ".nax/features")] },
        root,
        join(root, relative),
      ),
    ).toBeUndefined();
  });
  test("AC-7 exemption cannot grant an outside root", async () => {
    const target = join(outside, "report.md");
    expect(await firstOutsidePolicy([target], policy(), root, target)).toBe(target);
  });
  test("AC-9 exemption cannot grant a literal traversal", async () => {
    const report = `${root}/.nax/features/f/workflow/r/US-005/report.md`;
    const dotted = `${root}/.nax/features/f/workflow/r/US-004/../US-005/report.md`;
    expect(
      await firstOutsidePolicy([dotted], { ...policy(), denyWrite: [join(root, ".nax/features")] }, root, report),
    ).toBe(dotted);
  });
  test("canonical exemption is NFC-normalised and follows an in-root symlink", async () => {
    const denied = { ...policy(), denyWrite: [root] };
    expect(
      await firstOutsidePolicy([join(root, "inroot")], denied, root, join(root, "sub/target.txt")),
    ).toBeUndefined();
    expect(
      await firstOutsidePolicy([join(root, "caf\u00e9.md")], denied, root, join(root, "cafe\u0301.md")),
    ).toBeUndefined();
  });
  test("an exempt target does not exempt a second denied target", async () => {
    const report = join(root, "report.md");
    const brief = join(root, "brief.md");
    expect(await firstOutsidePolicy([report, brief], { ...policy(), denyWrite: [root] }, root, report)).toBe(brief);
  });
  test("inside the root: undefined", async () => {
    expect(await firstOutsidePolicy([join(root, "src", "new.ts")], policy(), root)).toBeUndefined();
  });
  test("relative path resolves against cwd", async () => {
    expect(await firstOutsidePolicy(["src/a.ts"], policy(), root)).toBeUndefined();
    expect(await firstOutsidePolicy(["../elsewhere.ts"], policy(), root)).toBe("../elsewhere.ts");
  });
  test("~ expands to home (outside the root)", async () => {
    expect(await firstOutsidePolicy(["~/x.txt"], policy(), root)).toBe("~/x.txt");
    expect(homedir().startsWith(root)).toBe(false);
  });
  test("under denyWrite: the path", async () => {
    expect(await firstOutsidePolicy([join(root, ".git", "hooks", "pre-commit")], policy(), root)).toBe(
      join(root, ".git", "hooks", "pre-commit"),
    );
  });
  test("symlink escape out of the root is caught", async () => {
    expect(await firstOutsidePolicy([join(root, "escape", "f.txt")], policy(), root)).toBe(
      join(root, "escape", "f.txt"),
    );
  });
  test("one bad target among several: the bad one", async () => {
    expect(await firstOutsidePolicy([join(root, "ok.ts"), "/etc/passwd"], policy(), root)).toBe("/etc/passwd");
  });
  test("no cwd: a relative target is outside (fail closed)", async () => {
    expect(await firstOutsidePolicy(["src/a.ts"], policy(), undefined)).toBe("src/a.ts");
  });
  test("no cwd: an absolute target inside the root is still allowed", async () => {
    expect(await firstOutsidePolicy([join(root, "ok.ts")], policy(), undefined)).toBeUndefined();
  });
  test("no cwd: ~ still expands to home, so it is outside", async () => {
    expect(await firstOutsidePolicy(["~/x.txt"], policy(), undefined)).toBe("~/x.txt");
  });
  test("dangling symlink inside the root pointing outside is caught (R6)", async () => {
    expect(await firstOutsidePolicy([join(root, "dangling")], policy(), root)).toBe(join(root, "dangling"));
  });
  test("symlink loop is treated as outside (R6 hop bound)", async () => {
    expect(await firstOutsidePolicy([join(root, "loopA")], policy(), root)).toBe(join(root, "loopA"));
  });
  test("a literal .. segment is outside, before any resolution (R7)", async () => {
    expect(await firstOutsidePolicy([`${root}/a/../b.ts`], policy(), root)).toBe(`${root}/a/../b.ts`);
  });
  // The denied directory is absent on disk, so realpath cannot fold the case on any filesystem.
  const caseDeny = () => ({ writeRoots: [root], denyWrite: [join(root, "secret-dir")], denyRead: [], network: {} });
  test("darwin: denyWrite matches case-insensitively (R7)", async () => {
    expect(await onPlatform("darwin", () => firstOutsidePolicy([`${root}/SECRET-DIR/x.ts`], caseDeny(), root))).toBe(
      `${root}/SECRET-DIR/x.ts`,
    );
  });
  test("linux: denyWrite matches case-sensitively, so the other spelling is inside (R7)", async () => {
    expect(
      await onPlatform("linux", () => firstOutsidePolicy([`${root}/SECRET-DIR/x.ts`], caseDeny(), root)),
    ).toBeUndefined();
  });
  test("R8: a relative symlink target with a .. segment is outside", async () => {
    expect(await firstOutsidePolicy([join(root, "up")], policy(), root)).toBe(join(root, "up"));
  });
  test("R8b: a relative symlink target resolves against the real parent (inside stays inside)", async () => {
    expect(await firstOutsidePolicy([join(root, "inroot")], policy(), root)).toBeUndefined();
  });
  test("R8b: writeRoots containment is case-sensitive, even on darwin (over-deny accepted)", async () => {
    // A synthetic root that is absent on disk: realpath cannot fold its case on any filesystem.
    const synthetic = () => ({ writeRoots: ["/nax-caseprobe-root"], denyWrite: [], denyRead: [], network: {} });
    expect(
      await onPlatform("darwin", () => firstOutsidePolicy(["/NAX-CASEPROBE-ROOT/src/a.ts"], synthetic(), undefined)),
    ).toBe("/NAX-CASEPROBE-ROOT/src/a.ts");
    expect(
      await onPlatform("darwin", () => firstOutsidePolicy(["/nax-caseprobe-root/src/a.ts"], synthetic(), undefined)),
    ).toBeUndefined();
  });
});
