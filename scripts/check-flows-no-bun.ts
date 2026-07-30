#!/usr/bin/env bun
/**
 * Guard: `flows/` must not use Bun globals.
 *
 * Everything under `flows/` is loaded by `acpx flow run`, inside acpx's own
 * process — and the published `acpx` binary is a Node program
 * (`#!/usr/bin/env node`). The `Bun` global does not exist there, so a
 * `Bun.spawn` / `Bun.file` / `Bun.write` call throws `ReferenceError: Bun is
 * not defined` at runtime and aborts the flow.
 *
 * This is the one tree in the repo where the Bun-native rule in
 * `.claude/rules/project-conventions.md` is inverted, and the failure mode is
 * invisible to the test suite (which runs under Bun, where `Bun` resolves
 * fine), so it needs a static gate.
 */

export {}; // top-level await needs this file to be a module

const FLOWS_DIR = "flows";
const BUN_GLOBAL = /(?<![\w.$])Bun\s*\./;

const violations: string[] = [];

for (const rel of new Bun.Glob("**/*.ts").scanSync({ cwd: FLOWS_DIR, absolute: false })) {
  const path = `${FLOWS_DIR}/${rel}`;
  const lines = (await Bun.file(path).text()).split("\n");
  lines.forEach((line, i) => {
    // Skip comment lines — the ported files explain *why* Bun.* is banned.
    const code = line.trim();
    if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) return;
    if (BUN_GLOBAL.test(line)) violations.push(`${path}:${i + 1}: ${code}`);
  });
}

if (violations.length > 0) {
  console.error("[FAIL] Bun globals found under flows/ — these run under Node inside acpx and will throw:\n");
  for (const v of violations) console.error(`  ${v}`);
  console.error("\n  Use node:child_process / node:fs/promises instead. See flows/nax-finish/exec.ts.");
  process.exit(1);
}

console.log(`[OK] no Bun globals under ${FLOWS_DIR}/`);
