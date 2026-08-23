#!/usr/bin/env bun
/**
 * Gate: the generated agent rule directories must match the canonical store.
 *
 * `.nax/rules/` is the source of truth; `.claude/rules/` is generated from it by
 * `nax rules export --agent=claude` and every generated file says so in a banner.
 * Nothing enforced that, so the copy drifted silently: `test-ratchets.md` sat
 * stale through the whole #1514 phase-1 drain, still describing two ratchets
 * after a third had shipped. Agents read the generated copy, so a stale rule is
 * not a documentation nit — it is wrong guidance delivered straight into context.
 *
 * `rulesExportCommand({ check: true })` regenerates in memory and compares; it
 * writes nothing. The flag was built for exactly this gate (see its doc comment
 * in src/cli/rules.ts) and was never wired up.
 *
 * Only `claude` is checked: it is the one agent whose export is a directory of
 * committed files. Other agents export to a shim file, and CLAUDE.md / AGENTS.md
 * / GEMINI.md come from `nax generate` + .nax/context.md — a different pipeline.
 * Add an agent here when its generated output is committed to the repo.
 *
 * Usage:
 *   bun scripts/check-rules-drift.ts
 *
 * Exit codes:
 *   0 — every generated rule directory matches .nax/rules/
 *   1 — drift found (run the export command it names to regenerate)
 */
import { join } from "node:path";
import { rulesExportCommand } from "../src/cli";
import { initLogger } from "../src/logger";

const ROOT = join(import.meta.dir, "..");

/** Agents whose generated rule directory is committed and must stay in sync. */
const GATED_AGENTS = ["claude"] as const;

async function main() {
  // Without this the export's warnings — a generated file with no canonical
  // source, a scope it could not carry across — resolve through the noop logger
  // and are discarded. bin/nax.ts does the same for the same reason.
  initLogger({ level: "info", useChalk: true });

  for (const agent of GATED_AGENTS) {
    try {
      await rulesExportCommand({ dir: ROOT, agent, check: true });
    } catch (err) {
      console.error(`[FAIL] ${(err as Error).message}`);
      process.exit(1);
    }
  }
}

if (import.meta.main) {
  await main();
}
