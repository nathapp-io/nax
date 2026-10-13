import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { editTargets, firstOutsidePolicy } from "#src/client/edit-targets";

let root: string;
let outside: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nax-edit-root-"));
  outside = await mkdtemp(join(tmpdir(), "nax-edit-out-"));
  await mkdir(join(root, ".git", "hooks"), { recursive: true });
  await symlink(outside, join(root, "escape"));
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
});
