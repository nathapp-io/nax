#!/usr/bin/env bun
/**
 * Live proof that the C2 story loop's tool path runs and its audit ledger lands.
 *
 * The native implementer has no shell: RunCommand runs only commands the
 * project declared, GitCommit is the sole mutating git verb, and a wanted
 * capability it cannot reach becomes a RequestCapability row instead of a bare
 * refusal in prose. This probe drives all three against a scratch repository
 * and then reads the ledger back from disk. The C1 and Phase B lesson applies:
 * compiling proves the parts typecheck, only an end-to-end trace proves the
 * loop runs.
 *
 * Usage: bun scripts/probe-c2-story-loop.ts
 * Exits non-zero if any call's outcome deviates, if the commit did not land,
 * or if the flushed ledger does not hold exactly three matching rows.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileToolPolicy, createCodingToolRuntime, createRunCommandTool, createToolAuditSink } from "@/tools";
import { gitWithTimeout } from "@/utils/git";

interface LedgerRecord {
  readonly tool: string;
  readonly outcome: "ok" | "error" | "denied";
  readonly input: Record<string, unknown>;
}

const base = mkdtempSync(join(tmpdir(), "nax-c2-probe-"));
const repo = join(base, "repo");
const auditDir = join(base, "audit");
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, "app.ts"), "export const answer = 42;\n");

const failures: string[] = [];

// Scratch repo: init + identity so the tool's own commit can land.
const init = await gitWithTimeout(["init"], repo);
if (init.exitCode !== 0) failures.push(`git init failed: ${init.stderr.trim() || init.exitCode}`);
const setEmail = await gitWithTimeout(["config", "user.email", "c2-probe@nax.local"], repo);
if (setEmail.exitCode !== 0) failures.push(`git config user.email failed: ${setEmail.stderr.trim()}`);
const setName = await gitWithTimeout(["config", "user.name", "C2 Probe"], repo);
if (setName.exitCode !== 0) failures.push(`git config user.name failed: ${setName.stderr.trim()}`);

const sink = createToolAuditSink({ dir: auditDir, sessionName: "c2-probe" });
const runtime = createCodingToolRuntime({
  // "*" is the unconditional grant each profile can express at its widest; it
  // still never widens past the root.
  policy: compileToolPolicy(
    [
      { tool: "Read", patterns: ["*"] },
      { tool: "Write", patterns: ["*"] },
      { tool: "Edit", patterns: ["*"] },
      { tool: "RunCommand", patterns: ["*"] },
      { tool: "GitCommit", patterns: ["*"] },
      { tool: "RequestCapability", patterns: ["*"] },
    ],
    repo,
  ),
  // RunCommand is per-session, so it arrives through the extraTools layer
  // rather than the process-global builtin registry.
  extraTools: [createRunCommandTool(new Map([["test", "echo {{files}} or run declared"]]))],
  sink,
});

const run = await runtime.callTool("RunCommand", { command: "test", values: { files: "app.test.ts" } });
const commit = await runtime.callTool("GitCommit", { message: "c2 probe commit", paths: ["app.ts"] });
const capability = await runtime.callTool("RequestCapability", {
  capability: "bun install",
  reason: "The implementer wanted to install a dependency it cannot reach.",
});

const logOut = await gitWithTimeout(["log", "-1"], repo);
if (logOut.exitCode !== 0) failures.push(`git log -1 failed: ${logOut.stderr.trim() || logOut.exitCode}`);
if (!logOut.stdout.includes("c2 probe commit")) failures.push("git log -1 does not show the probe commit");

if (run.kind !== "ok") failures.push(`expected RunCommand to run the declared command, got "${run.kind}"`);
if (commit.kind !== "ok") failures.push(`expected GitCommit to land a commit, got "${commit.kind}"`);
if (capability.kind !== "error") {
  failures.push(`expected RequestCapability to refuse loudly, got "${capability.kind}"`);
} else if (!capability.content.includes("bun install")) {
  failures.push("RequestCapability did not echo the requested capability");
}

await sink.flush();

const ledgerFiles = readdirSync(auditDir).filter((f) => f.endsWith("-c2-probe.json"));
if (ledgerFiles.length !== 1) {
  failures.push(`expected exactly one ledger file, found ${ledgerFiles.length}: ${ledgerFiles.join(", ")}`);
}
const ledgerPath = join(auditDir, ledgerFiles[0] ?? "missing");
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as { sessionName?: string; calls: LedgerRecord[] };

if (ledger.sessionName !== "c2-probe") failures.push(`ledger sessionName is "${ledger.sessionName}"`);
if (ledger.calls.length !== 3) failures.push(`expected three audited calls, found ${ledger.calls.length}`);

const expected: readonly (readonly [string, string])[] = [
  ["RunCommand", "ok"],
  ["GitCommit", "ok"],
  ["RequestCapability", "error"],
];
for (let i = 0; i < expected.length; i += 1) {
  const record = ledger.calls[i];
  if (record === undefined) continue;
  const [tool, outcome] = expected[i];
  if (record.tool !== tool) failures.push(`call ${i}: expected tool "${tool}", got "${record.tool}"`);
  if (record.outcome !== outcome)
    failures.push(`call ${i} (${record.tool}): expected "${outcome}", got "${record.outcome}"`);
}
if (ledger.calls[2]?.input.capability !== "bun install") {
  failures.push('the RequestCapability row does not carry "bun install"');
}

console.log(`scratch repo: ${repo}`);
console.log(`ledger file: ${ledgerPath}`);
console.log("--- ledger JSON (read back from disk) ---");
console.log(readFileSync(ledgerPath, "utf8").trimEnd());
console.log("--- calls ---");
for (const record of ledger.calls) console.log(`  ${record.tool}: ${record.outcome}`);
console.log("--- git log -1 ---");
console.log(logOut.stdout.trimEnd());

if (failures.length > 0) {
  console.error("probe FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  "probe OK: RunCommand ran the declared command, GitCommit landed, RequestCapability refused loudly, and the ledger holds all three rows.",
);
