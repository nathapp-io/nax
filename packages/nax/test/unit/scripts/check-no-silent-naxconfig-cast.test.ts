/**
 * The silent-fail `as NaxConfig` cast gate.
 *
 * The gate exists so a cast cannot paper over a partial or unvalidated config:
 * every cast in `src/` must sit in a file the gate's allow-list names, with a
 * documented reason for why the runtime shape is guaranteed.
 *
 * It is proven by violating it — a gate never seen to fail is not a gate. The
 * script scans `../src` relative to its OWN location, so the temp-tree cases
 * run a COPY of the shipped script inside the tree they scan. The copy keeps
 * the real allow-list, so what these tests exercise is the shipped policy.
 *
 * US-004 added `src/config/package-layer.ts`, which owns the per-package
 * config parse (`validatePackageConfig`) that `loader.ts` used to run inline,
 * so the cast that follows that parse moved with it. The allow-list entry has
 * to move too — and the gate must still catch a cast anywhere else.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

const PACKAGE_ROOT = join(import.meta.dir, "../../..");
const SCRIPT_REL = "scripts/check-no-silent-naxconfig-cast.sh";

let root = "";

afterEach(() => {
  if (root !== "") cleanupTempDir(root);
  root = "";
});

/** Materialise a tree holding a copy of the gate script plus the given `src/` files. */
function tree(files: Record<string, string>): string {
  const dir = makeTempDir("nax-naxconfig-cast-gate-");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(join(PACKAGE_ROOT, SCRIPT_REL), join(dir, SCRIPT_REL));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, "src", rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
  return dir;
}

/** Run the gate from the tree it scans, the way the npm script does. */
function runGate(cwd: string): { code: number; out: string } {
  const proc = Bun.spawnSync(["bash", join(cwd, SCRIPT_REL)], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

/** A source file whose cast follows a successful config parse. */
const CAST_AFTER_PARSE = "export function v(data: { version: number }): number {\n  return data as NaxConfig;\n}\n";

describe("check-no-silent-naxconfig-cast", () => {
  test("the shipped source tree carries no silent-fail NaxConfig cast", () => {
    const { code, out } = runGate(PACKAGE_ROOT);

    expect(out).toContain("[OK]");
    expect(code).toBe(0);
  });

  test("the gate still flags a cast in a file outside the allow-list", () => {
    root = tree({ "config/not-allow-listed.ts": CAST_AFTER_PARSE });

    const { code, out } = runGate(root);

    expect(code).toBe(1);
    expect(out).toContain("config/not-allow-listed.ts");
  });

  test("the gate accepts the package-layer cast, which follows a successful parse", () => {
    root = tree({ "config/package-layer.ts": CAST_AFTER_PARSE });

    const { code, out } = runGate(root);

    expect(out).toContain("[OK]");
    expect(code).toBe(0);
  });
});
