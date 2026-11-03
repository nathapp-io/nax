/**
 * The nullable-`agentManager` gate (ADR-020 Wave 2).
 *
 * Dispatch-time contexts must not make `agentManager` nullable — a context that
 * carries an optional manager pushes a null check into every consumer, which is
 * the shape ADR-020 removed. The declaration is legal in exactly one place: the
 * runtime's own construction options, where the caller is *supplying* a manager
 * rather than a dispatch reading one.
 *
 * US-005 moved `CreateRuntimeOptions` (and with it that declaration) out of
 * `src/runtime/index.ts` into `src/runtime/runtime-options.ts` to keep the barrel
 * inside the file-size cap. The gate's allowlist is a list of file paths, so it
 * had to follow the declaration — this file is what says so, and what proves the
 * gate still bites everywhere else. A gate never seen to fail is not a gate.
 *
 * The gate is run the way CI runs it — `bash scripts/check-dispatch-context.sh`
 * from the tree being scanned — because the script's own relative `src/` scope is
 * part of what has to keep working.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

const SCRIPT = join(import.meta.dir, "../../../scripts/check-dispatch-context.sh");

/** The declaration the gate looks for, spelled as the moved interface spells it. */
const NULLABLE = "  agentManager?: IAgentManager;\n";

let root = "";

afterEach(() => {
  if (root !== "") cleanupTempDir(root);
  root = "";
});

/** Materialise a tree and return its root. */
function tree(files: Record<string, string>): string {
  const dir = makeTempDir("nax-dispatch-context-gate-");
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

describe("check-dispatch-context: the runtime's construction options", () => {
  test("exits 0 when the declaration lives in the moved runtime-options.ts", () => {
    root = tree({ "src/runtime/runtime-options.ts": `export interface CreateRuntimeOptions {\n${NULLABLE}}\n` });

    const { code, out } = runGate(root);

    expect(out).not.toContain("runtime-options.ts");
    expect(code).toBe(0);
  });

  test("exits 0 when the declaration lives in src/runtime/index.ts", () => {
    root = tree({ "src/runtime/index.ts": `export interface CreateRuntimeOptions {\n${NULLABLE}}\n` });

    expect(runGate(root).code).toBe(0);
  });

  test("exits 1 and names the file when a dispatch-time context declares it", () => {
    root = tree({ "src/operations/ctx.ts": `export interface CallContext {\n${NULLABLE}}\n` });

    const { code, out } = runGate(root);

    expect(code).toBe(1);
    expect(out).toContain("src/operations/ctx.ts:2:  agentManager?: IAgentManager;");
  });

  test("exits 1 for the inline import() spelling too", () => {
    root = tree({
      "src/pipeline/ctx.ts": 'export interface StepContext {\n  agentManager?: import("../agents").IAgentManager;\n}\n',
    });

    expect(runGate(root).code).toBe(1);
  });

  test("exits 0 when no such declaration exists at all", () => {
    root = tree({ "src/operations/ctx.ts": "export interface CallContext {\n  agentManager: IAgentManager;\n}\n" });

    expect(runGate(root).code).toBe(0);
  });
});
