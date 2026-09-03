#!/usr/bin/env bun
/**
 * Ratchet check: an operation whose session role must write files or run
 * commands has to DECLARE those tools.
 *
 * Why this exists: `resolveDeclaredTools` is `op.tools ?? DEFAULT_CODING_TOOLS`
 * (`src/operations/types.ts`), so omitting the field yields a read-only set
 * rather than an error. On acpx that is inert -- the ACP agent brings its own
 * tools -- so the omission never surfaces there. On the native transport it
 * silently disables the op: a test-writer that cannot write, a verifier that
 * cannot run its own tests.
 *
 * Capability stays declared per op rather than derived from the role. Deriving
 * would trade a silent under-grant for a silent over-grant -- a new op picking
 * `role: "implementer"` would inherit Write/Edit/GitCommit with nobody deciding
 * it should. So the role table is ENFORCED here, never APPLIED at runtime.
 *
 * The check imports the operations barrel instead of parsing source, because
 * the source shape misleads twice: ops are exported under aliases
 * (`implementerOp` and `implementTddOp` are the same object), and one module can
 * define several ops (`acceptance-fix.ts` defines both `acceptance-fix-source`
 * and `acceptance-fix-test`). Reading the barrel reads what dispatch reads.
 *
 * Usage:
 *   bun scripts/check-op-tool-capability.ts                   # check (CI mode)
 *   bun scripts/check-op-tool-capability.ts --update-baseline # save new baseline
 *
 * Exit codes:
 *   0 — no unbaselined violations
 *   1 — a violation, or a baselined op that has since been fixed (lower the baseline)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDeclaredTools } from "../src/operations/types";
import type { CodingToolName } from "../src/tools";
import { byCodePoint } from "../src/utils/sort";

const BASELINE_FILE = join(import.meta.dir, "baselines", "op-tool-capability-baseline.json");

/**
 * Minimum tools a session role's work requires.
 *
 * `verifier` is deliberately run-only: a verifier that can repair what it is
 * judging is not a verifier, and the isolation check it performs assumes it
 * changed nothing.
 */
export const REQUIRED_TOOLS_BY_ROLE: Record<string, readonly string[]> = {
  implementer: ["Write", "Edit"],
  "test-writer": ["Write", "Edit"],
  "source-fix": ["Write", "Edit"],
  "test-fix": ["Write", "Edit"],
  "repo-scoped-test-fix": ["Write", "Edit"],
  "fix-gen": ["Write", "Edit"],
  "finish-fix": ["Write", "Edit"],
  verifier: ["RunCommand"],
  /**
   * These four roles never edit an existing file (no Edit requirement) — each
   * writes ONE fresh output file via a `fileOutput`-style contract ("write JSON
   * to this path, then reply with a brief confirmation") rather than replying
   * with the content inline. See docs/superpowers/specs/
   * 2026-09-03-fileoutput-op-tool-gap-followup.md for the per-op prompt evidence.
   */
  plan: ["Write"],
  "plan-refine": ["Write"],
  "debate-plan": ["Write"],
  "acceptance-gen": ["Write"],
};

export interface OpRow {
  readonly name: string;
  readonly role: string;
  readonly tools: readonly string[];
}

export interface Violation {
  readonly name: string;
  readonly role: string;
  readonly missing: string[];
}

interface Baseline {
  updatedAt: string;
  /** Op names knowingly undeclared. Shrinks as the follow-up arc declares them. */
  ops: string[];
}

/** Walk a module's exports for run operations, deduped by object identity. */
export function collectOps(mod: Record<string, unknown>): OpRow[] {
  const seen = new Set<unknown>();
  const rows: OpRow[] = [];
  for (const value of Object.values(mod)) {
    if (typeof value !== "object" || value === null) continue;
    const op = value as { kind?: unknown; name?: unknown; session?: { role?: unknown }; tools?: readonly string[] };
    if (op.kind !== "run" || typeof op.name !== "string") continue;
    const role = op.session?.role;
    if (typeof role !== "string") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    rows.push({ name: op.name, role, tools: resolveDeclaredTools(op as { tools?: readonly CodingToolName[] }) });
  }
  return rows;
}

export function findViolations(rows: readonly OpRow[], baseline: readonly string[]): Violation[] {
  const exempt = new Set(baseline);
  const violations: Violation[] = [];
  for (const row of rows) {
    if (exempt.has(row.name)) continue;
    const required = REQUIRED_TOOLS_BY_ROLE[row.role];
    if (required === undefined) continue;
    const missing = required.filter((tool) => !row.tools.includes(tool));
    if (missing.length > 0) violations.push({ name: row.name, role: row.role, missing });
  }
  return violations;
}

function readBaseline(): Baseline {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline;
  } catch {
    return { updatedAt: "", ops: [] };
  }
}

async function main(): Promise<void> {
  const mod = (await import("../src/operations")) as Record<string, unknown>;
  const rows = collectOps(mod);
  const baseline = readBaseline();

  if (process.argv.includes("--update-baseline")) {
    const ops = findViolations(rows, [])
      .map((v) => v.name)
      .sort(byCodePoint);
    writeFileSync(BASELINE_FILE, `${JSON.stringify({ updatedAt: new Date().toISOString(), ops }, null, 2)}\n`);
    console.log(`Baseline updated: ${ops.length} undeclared op(s).`);
    return;
  }

  const violations = findViolations(rows, baseline.ops);
  if (violations.length > 0) {
    console.error("[FAIL] operations whose session role requires tools they do not declare:\n");
    for (const v of violations.sort((a, b) => byCodePoint(a.name, b.name))) {
      console.error(`  ${v.name} (role ${v.role}) is missing: ${v.missing.join(", ")}`);
    }
    console.error(`\nAdd a \`tools:\` declaration to the operation. Omitting it yields`);
    console.error(`DEFAULT_CODING_TOOLS (read-only), which disables the op on the native`);
    console.error(`transport while leaving acpx unaffected -- so this never fails at runtime.`);
    process.exit(1);
  }

  const stillViolating = new Set(findViolations(rows, []).map((v) => v.name));
  const stale = baseline.ops.filter((name) => !stillViolating.has(name));
  if (stale.length > 0) {
    console.error(`[FAIL] baseline lists op(s) that no longer violate: ${stale.join(", ")}`);
    console.error("Lower it with: bun scripts/check-op-tool-capability.ts --update-baseline");
    process.exit(1);
  }

  console.log(`OK: ${rows.length} run op(s) checked, ${baseline.ops.length} grandfathered.`);
}

if (import.meta.main) await main();
