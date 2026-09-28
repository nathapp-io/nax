/**
 * The adapter-config boundary gate's plugin rule (US-004).
 *
 * `src/agents/native/` must not reach into the plugin system: a plugin
 * `loop-handlers` handler is handed nax-owned payload and context TYPES, but
 * nothing in the native loop may depend on `src/plugins` — that dependency
 * would close a cycle and make the coding agent unextractable (P6).
 *
 * The gate is proven by violating it: a gate never seen to fail is not a gate.
 * It is run the way CI runs it — `bash scripts/check-adapter-no-config-import.sh`
 * from the tree being scanned — because the script's own relative `scan_dirs`
 * are part of what has to keep working.
 *
 * The AC id is the test-name prefix.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

const SCRIPT = join(import.meta.dir, "../../../scripts/check-adapter-no-config-import.sh");

let root = "";

afterEach(() => {
  if (root !== "") cleanupTempDir(root);
  root = "";
});

/** Materialise a tree and return its root. */
function tree(files: Record<string, string>): string {
  const dir = makeTempDir("nax-adapter-gate-");
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
  return dir;
}

/** Run the gate from the tree it scans, as the npm script does. */
function runGate(cwd: string): { code: number; out: string } {
  const proc = Bun.spawnSync(["bash", SCRIPT], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

describe("check-adapter-no-config-import: the src/plugins rule", () => {
  test("AC12: exits 1 and prints the offending file when a native file imports @/plugins", () => {
    root = tree({
      "src/agents/native/x.ts": 'import { loadPlugins } from "@/plugins";\nexport const forward = loadPlugins;\n',
    });

    const { code, out } = runGate(root);

    expect(code).toBe(1);
    expect(out).toContain("x.ts");
  });

  test("AC12 (boundary): exits 1 when a native file reaches src/plugins by relative path", () => {
    root = tree({
      "src/agents/native/x.ts":
        'import type { LoopHandlerSet } from "../../plugins";\nexport type Forwarded = LoopHandlerSet;\n',
    });

    const { code, out } = runGate(root);

    expect(code).toBe(1);
    expect(out).toContain("x.ts");
  });

  test("AC13: exits 0 when the only import is the loop-event module", () => {
    root = tree({
      "src/agents/native/x.ts":
        'import type { LoopHandlerSet } from "@/agents/native/session/loop-events";\nexport type Forwarded = LoopHandlerSet;\n',
    });

    const { code } = runGate(root);

    expect(code).toBe(0);
  });

  test("AC13 (boundary): exits 0 for a relative loop-event import too", () => {
    root = tree({
      "src/agents/native/x.ts":
        'import type { LoopHandlerContext } from "./session/loop-events/types";\nexport type Ctx = LoopHandlerContext;\n',
    });

    const { code } = runGate(root);

    expect(code).toBe(0);
  });
});
