#!/usr/bin/env bun
/**
 * Live proof that the gate says no.
 *
 * Compiling proves the parts typecheck; only an end-to-end trace proves it
 * runs. Phase B shipped unreachable because nothing supplied transcriptDir and
 * every per-task review still passed — each task was right in isolation.
 *
 * Usage: bun scripts/probe-native-coding-tools.ts
 * Exits non-zero if a denial did not reach the caller, or if a file appeared
 * outside the root.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileToolPolicy, createCodingToolRuntime } from "@/tools";

const base = mkdtempSync(join(tmpdir(), "nax-probe-"));
const root = join(base, "repo");
const outside = join(base, "outside");
mkdirSync(join(root, "src"), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(root, "src", "a.ts"), "const a = 1;\n");

const runtime = createCodingToolRuntime({
  // "*" is the unrestricted-equivalent grant: the widest config can express.
  policy: compileToolPolicy(
    [
      { tool: "Write", patterns: ["*"] },
      { tool: "Read", patterns: ["*"] },
    ],
    root,
  ),
});

const escapeTarget = join(outside, "escaped.txt");
const denied = await runtime.callTool("Write", { path: escapeTarget, content: "should never land" });
const allowed = await runtime.callTool("Read", { path: "src/a.ts" });

const failures: string[] = [];
if (denied.kind !== "denied") failures.push(`expected a denial for a write outside the root, got "${denied.kind}"`);
if (denied.kind === "denied" && !denied.breach) failures.push("expected the denial to be flagged as a breach");
if (existsSync(escapeTarget)) failures.push(`FILE WAS WRITTEN OUTSIDE THE ROOT: ${escapeTarget}`);
if (allowed.kind !== "ok") failures.push(`expected the in-root read to succeed, got "${allowed.kind}"`);

if (failures.length > 0) {
  console.error("probe FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("probe OK: unrestricted-equivalent grants still deny outside the root; no file escaped.");
