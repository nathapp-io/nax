#!/usr/bin/env bun
/**
 * Detect inline test mocks that should use test/helpers/ factories instead.
 *
 * Looks for the high-churn patterns documented in .claude/rules/test-helpers.md:
 *   - Inline IAgentManager mocks (getDefault + run + complete)
 *   - Inline AgentAdapter mocks (capabilities.supportedTiers)
 *   - Local makeConfig() / makeStory() functions that duplicate shared helpers
 *
 * Exits 1 if violations found (CI can fail on this).
 *
 * Usage:
 *   bun scripts/check-inline-test-mocks.ts          # report only
 *   bun scripts/check-inline-test-mocks.ts --strict # exit 1 on any match
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TEST_DIR = join(ROOT, "test");
const HELPERS_DIR = join(ROOT, "test/helpers");

const strict = process.argv.includes("--strict");

/**
 * Files that have been fully migrated to shared helpers.
 * These are skipped entirely — no false positives from residual pattern strings.
 */
const SKIP_FILES = new Set([
  "test/unit/pipeline/stages/execution-workdir.test.ts",
  "test/unit/pipeline/stages/execution-agent-routing.test.ts",
  "test/unit/pipeline/stages/execution-tdd-simple.test.ts",
  "test/unit/pipeline/stages/execution-session-role.test.ts",
  "test/unit/pipeline/stages/execution-ambiguity.test.ts",
  "test/unit/pipeline/stages/execution-manager-wiring.test.ts",
  "test/unit/pipeline/stages/execution-merge-conflict.test.ts",
  "test/unit/pipeline/stages/execution-agent-swap-metrics.test.ts",
  "test/unit/storyid-events.test.ts",
  "test/unit/agents/manager-iface-run.test.ts",
  "test/unit/agents/manager-credentials.test.ts",
  "test/unit/debate/resolvers.test.ts",
  "test/unit/debate/session-events.test.ts",
  "test/unit/debate/session-helpers-resolver-model.test.ts",
  "test/unit/debate/session-helpers.test.ts",
  "test/unit/debate/session-hybrid-rebuttal.test.ts",
  "test/unit/debate/session-one-shot-roles.test.ts",
  "test/unit/debate/session-plan.test.ts",
  "test/unit/pipeline/stages/review-debate-dialogue.test.ts",
  "test/unit/pipeline/stages/acceptance-setup-fingerprint.test.ts",
  "test/unit/pipeline/stages/autofix-budget-prompts.test.ts",
  "test/unit/pipeline/stages/autofix-noop.test.ts",
  "test/unit/pipeline/stages/autofix-adversarial.test.ts",
  "test/unit/pipeline/stages/autofix-dialogue.test.ts",
  "test/unit/pipeline/stages/autofix-routing.test.ts",
  "test/unit/pipeline/stages/autofix-session-wiring.test.ts",
  "test/unit/pipeline/stages/review-dialogue.test.ts",
]);

/**
 * Pattern C (inline-agent-adapter) false-positive guard.
 *
 * When `supportedTiers: [` appears inside a helper call like `makeAgentAdapter(...)`,
 * the regex matches the string inside the helper call — a false positive.
 *
 * This function checks whether the match at `matchIndex` in `text` is inside
 * an open helper call by looking backwards for `makeAgentAdapter(` or
 * `makeMockAgentManager(` within LOOKBACK_LINES lines, where the call's
 * opening paren has not been closed by the time we reach the match.
 *
 * A call is considered "open" at the match if the number of opening parens
 * on the line(s) between the call and the match is greater than the number
 * of closing parens on those same lines.
 */
const LOOKBACK_LINES = 15;

function isInsideHelperCall(text: string, matchIndex: number): boolean {
  const beforeMatch = text.slice(0, matchIndex);
  const lastNLines = beforeMatch.split("\n").slice(-LOOKBACK_LINES);
  const window = lastNLines.join("\n");

  const helperCalls = ["makeAgentAdapter(", "makeMockAgentManager("];
  for (const call of helperCalls) {
    const callIdx = window.lastIndexOf(call);
    if (callIdx === -1) continue;

    const afterCall = window.slice(callIdx + call.length);
    const openParens = (afterCall.match(/\(/g) ?? []).length;
    const closeParens = (afterCall.match(/\)/g) ?? []).length;
    if (openParens > closeParens) {
      return true;
    }
  }
  return false;
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (full === HELPERS_DIR) continue;
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

type Violation = { file: string; line: number; kind: string; snippet: string };

const PATTERNS: Array<{ kind: string; re: RegExp; hint: string }> = [
  {
    kind: "inline-agent-manager",
    re: /getDefault\s*:\s*\(\)\s*=>/,
    hint: "Replace with makeMockAgentManager() from test/helpers",
  },
  {
    kind: "inline-agent-adapter",
    re: /supportedTiers\s*:\s*\[/,
    hint: "Replace with makeAgentAdapter() from test/helpers",
  },
  {
    kind: "local-makeConfig",
    re: /^\s*function\s+makeConfig\s*\(/,
    hint: "Replace with makeNaxConfig() from test/helpers",
  },
  {
    kind: "local-makeStory",
    re: /^\s*function\s+makeStory\s*\(/,
    hint: "Replace with makeStory() from test/helpers",
  },
];

const files = await walk(TEST_DIR);
const violations: Violation[] = [];

for (const file of files) {
  const text = await Bun.file(file).text();
  const rel = file.replace(ROOT + "/", "");

  if (SKIP_FILES.has(rel)) continue;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const p of PATTERNS) {
      if (p.re.test(lines[i])) {
        const matchIndex = text.indexOf(lines[i], lines
          .slice(0, i)
          .reduce((acc, l) => acc + l.length + 1, 0));

        if (p.kind === "inline-agent-adapter" && isInsideHelperCall(text, matchIndex)) {
          continue;
        }

        violations.push({ file, line: i + 1, kind: p.kind, snippet: lines[i].trim().slice(0, 100) });
      }
    }
  }
}

const byKind = new Map<string, Violation[]>();
for (const v of violations) {
  const arr = byKind.get(v.kind) ?? [];
  arr.push(v);
  byKind.set(v.kind, arr);
}

if (violations.length === 0) {
  console.log("[OK] No inline test mock violations found.");
  process.exit(0);
}

console.log(`Found ${violations.length} inline mock patterns across ${files.length} test files.\n`);
for (const [kind, arr] of byKind) {
  const hint = PATTERNS.find((p) => p.kind === kind)?.hint ?? "";
  console.log(`━━ [${arr.length}] ${kind} — ${hint} ━━`);
  for (const v of arr.slice(0, 5)) {
    const rel = v.file.replace(ROOT + "/", "");
    console.log(`  ${rel}:${v.line}  ${v.snippet}`);
  }
  if (arr.length > 5) console.log(`  … +${arr.length - 5} more`);
  console.log();
}

console.log(`See .claude/rules/test-helpers.md for guidance.`);
process.exit(strict ? 1 : 0);
