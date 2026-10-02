import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { which } from "#src/runtime/which";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

describe("which", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) cleanupTempDir(d);
  });
  const tmp = (): string => {
    const d = makeTempDir("nax-which-");
    dirs.push(d);
    return d;
  };

  test("finds an executable on PATH", () => {
    expect(which("sh")).toMatch(/\/sh$/);
  });

  test("returns null for a name on no PATH entry", () => {
    expect(which("nax-no-such-binary-xyz")).toBeNull();
  });

  test("a name with a slash is checked as a path: executable or null", () => {
    const d = tmp();
    const exe = join(d, "tool");
    const plain = join(d, "data");
    writeFileSync(exe, "#!/bin/sh\n");
    chmodSync(exe, 0o755);
    writeFileSync(plain, "");
    chmodSync(plain, 0o644);
    expect(which(exe)).toBe(exe);
    expect(which(plain)).toBeNull();
  });

  test("searches only the PATH it is given", () => {
    expect(which("sh", "/nonexistent-nax-path")).toBeNull();
  });

  test("skips a directory that has the binary's name", () => {
    const d = tmp();
    mkdirSync(join(d, "tool"));
    expect(which("tool", d)).toBeNull();
  });
});
