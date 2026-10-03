/** Shared glob behaviour, exercised on Bun and real Node without runner dependencies. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CaseGlobRuntime } from "./runtime-types";

async function hits(rt: CaseGlobRuntime, pattern: string, cwd: string, absolute = false): Promise<string[]> {
  const asyncHits: string[] = [];
  for await (const hit of rt.glob(pattern, { cwd, absolute })) asyncHits.push(hit);
  asyncHits.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(
    [...rt.globSync(pattern, { cwd, absolute })].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    asyncHits,
  );
  return asyncHits;
}

async function fixture(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "nax-glob-case-"));
  try {
    for (const dir of ["dir", "dir/nested", ".hidden", ".scratch-root"]) mkdirSync(join(root, dir));
    for (const file of ["a.ts", "b.js", "dir/c.ts", ".secret", ".hidden/h.ts", ".scratch-root/visible.txt"])
      writeFileSync(join(root, file), "x");
    symlinkSync("a.ts", join(root, "link.ts"));
    symlinkSync("dir", join(root, "linked-dir"));
    symlinkSync("../../dir", join(root, "dir/nested/link"));
    symlinkSync("absent", join(root, "broken"));
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export const GLOB_CASES: readonly { name: string; run(rt: CaseGlobRuntime): Promise<void> }[] = [
  ...[
    ["files only; no hidden paths, symlink files, or wildcard symlink traversal", "**/*", ["a.ts", "b.js", "dir/c.ts"]],
    ["braces", "{a,b}.{ts,js}", ["a.ts", "b.js"]],
    ["character classes", "[ab].*", ["a.ts", "b.js"]],
    ["duplicate brace alternatives", "{a,a}.ts", ["a.ts"]],
    ["explicit directory symlink prefix", "linked-dir/**/*", ["linked-dir/c.ts"]],
    ["explicit dotfile", ".secret", []],
    ["explicit hidden wildcard", "**/.*", []],
    ["explicit dot directory", ".hidden/**/*", []],
    ["malformed character class", "[", []],
    ["malformed brace", "{", []],
    ["literal miss", "not-present", []],
    ["literal file", "a.ts", ["a.ts"]],
    ["leading current-directory literal", "./a.ts", ["./a.ts"]],
    ["leading current-directory wildcard", "./dir/*.ts", ["./dir/c.ts"]],
    ["literal symlink file", "link.ts", ["link.ts"]],
    ["literal dangling symlink", "broken", []],
  ].map(([name, pattern, expected]) => ({
    name: String(name),
    run: (rt: CaseGlobRuntime) =>
      fixture(async (root) => {
        assert.deepEqual(await hits(rt, String(pattern), root), expected);
      }),
  })),
  {
    name: "absolute paths preserve the relative matched set",
    run: (rt) =>
      fixture(async (root) => {
        assert.deepEqual(
          await hits(rt, "**/*.ts", root, true),
          [resolve(root, "a.ts"), resolve(root, "dir/c.ts")].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        );
      }),
  },
  {
    name: "visible files under a hidden cwd are visible",
    run: (rt) =>
      fixture(async (root) => {
        assert.deepEqual(await hits(rt, "**/*", join(root, ".scratch-root")), ["visible.txt"]);
      }),
  },
  ...(["ENOENT", "ENOTDIR"] as const).map((code) => ({
    name: `bad cwd throws ${code} in both methods`,
    run: (rt: CaseGlobRuntime) =>
      fixture(async (root) => {
        const cwd = join(root, code === "ENOENT" ? "absent" : "a.ts");
        await assert.rejects(
          async () => {
            for await (const _hit of rt.glob("**/*", { cwd, absolute: false })) {
            }
          },
          { code },
        );
        assert.throws(() => [...rt.globSync("**/*", { cwd, absolute: false })], { code });
      }),
  })),
];
