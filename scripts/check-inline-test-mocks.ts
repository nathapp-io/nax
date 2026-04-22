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
  // Pattern D (AgentManager) - PERMANENT: no inline getDefault pattern
  "test/unit/pipeline/stages/execution-workdir.test.ts",
  "test/unit/pipeline/stages/execution-agent-routing.test.ts",
  "test/unit/pipeline/stages/execution-tdd-simple.test.ts",
  "test/unit/pipeline/stages/execution-session-role.test.ts",
  "test/unit/pipeline/stages/execution-ambiguity.test.ts",
  "test/unit/pipeline/stages/execution-merge-conflict.test.ts",
  "test/unit/storyid-events.test.ts",
  "test/unit/agents/manager-iface-run.test.ts",
  "test/unit/agents/manager-credentials.test.ts",
  "test/unit/debate/session-events.test.ts",
  "test/unit/debate/session-helpers-resolver-model.test.ts",
  "test/unit/debate/session-helpers.test.ts",
  "test/unit/debate/session-plan.test.ts",
  "test/unit/pipeline/stages/review-debate-dialogue.test.ts",
  "test/unit/pipeline/stages/acceptance-setup-fingerprint.test.ts",
  // Pattern D (AgentManager) - PERMANENT: .mock.calls on bun mock instance
  "test/unit/pipeline/stages/autofix-budget-prompts.test.ts",
  "test/unit/pipeline/stages/autofix-noop.test.ts",
  "test/unit/pipeline/stages/autofix-adversarial.test.ts",
  "test/unit/pipeline/stages/autofix-dialogue.test.ts",
  "test/unit/pipeline/stages/autofix-session-wiring.test.ts",
  "test/unit/pipeline/stages/execution-manager-wiring.test.ts",
  "test/unit/pipeline/stages/execution-agent-swap-metrics.test.ts",
  "test/unit/interaction/auto-plugin-adapter.test.ts",
  "test/unit/acceptance/component-strategy-integration.test.ts",
  "test/unit/acceptance/generator-prd-result.test.ts",
  "test/unit/acceptance/fix-executor-test-fix.test.ts",
  // Pattern C (AgentAdapter) - integration files with class-based or plugin-extension adapters
  "test/integration/pipeline/reporter-lifecycle-basic.test.ts",
  "test/integration/pipeline/reporter-lifecycle-resilience.test.ts",
  "test/integration/plugins/plugins-registry.test.ts",
  "test/integration/plugins/validator.test.ts",
  "test/integration/execution/agent-swap.test.ts",
  "test/integration/execution/status-file-integration.test.ts",
  // Pattern B (makeStory) - local factory functions
  "test/unit/metrics/tracker-escalation.test.ts",
  "test/unit/metrics/tracker-full-suite-gate.test.ts",
  "test/unit/metrics/tracker-runtime-crashes.test.ts",
  "test/unit/metrics/tracker.test.ts",
  "test/unit/pipeline/stages/completion-semantic.test.ts",
  "test/unit/pipeline/stages/review-debate-dialogue.test.ts",
  "test/unit/pipeline/stages/acceptance-setup-fingerprint.test.ts",
  "test/unit/pipeline/stages/routing-greenfield-monorepo.test.ts",
  "test/unit/pipeline/stages/prompt-batch.test.ts",
  "test/unit/pipeline/stages/acceptance-setup-gate.test.ts",
  "test/unit/pipeline/stages/acceptance-setup-criteria.test.ts",
  "test/unit/pipeline/stages/acceptance-setup-commit.test.ts",
  "test/unit/pipeline/stages/acceptance-setup-regeneration.test.ts",
  "test/unit/pipeline/stages/acceptance-setup-strategy.test.ts",
  "test/unit/pipeline/stages/completion.test.ts",
  "test/unit/pipeline/routing-partial-override.test.ts",
  "test/unit/context/feature-context.test.ts",
  "test/unit/context/feature-resolver.test.ts",
  "test/unit/context/parent-context.test.ts",
  "test/unit/context/engine/orchestrator-factory.test.ts",
  "test/unit/cli/plan-decompose-ac13-14.test.ts",
  "test/unit/cli/plan-decompose-guards.test.ts",
  "test/unit/cli/plan-decompose-adapter.test.ts",
  "test/unit/verification/rectification-loop.test.ts",
  "test/unit/verification/fix-generator.test.ts",
  "test/unit/verification/rectification-loop-escalation.test.ts",
  "test/unit/acceptance/test-path.test.ts",
  "test/unit/acceptance/generator-strategy.test.ts",
  "test/unit/execution/unified-executor-rl002.test.ts",
  "test/unit/execution/lifecycle-execution.test.ts",
  "test/unit/execution/story-context.test.ts",
  "test/unit/execution/runner-completion-skip.test.ts",
  "test/unit/execution/lifecycle/paused-story-prompts.test.ts",
  "test/unit/execution/lifecycle/run-completion-fallback.test.ts",
  "test/unit/execution/lifecycle/run-completion-postrun.test.ts",
  "test/unit/execution/lifecycle/run-cleanup.test.ts",
  "test/unit/execution/pipeline-result-handler.test.ts",
  "test/unit/execution/parallel-batch.test.ts",
  "test/unit/execution/runner-completion-postrun.test.ts",
  "test/unit/execution/lifecycle-completion.test.ts",
  "test/unit/execution/parallel-worker.test.ts",
  "test/unit/execution/unified-executor-rl007.test.ts",
  "test/unit/prd/schema.test.ts",
  "test/unit/prd/prd-get-next-story.test.ts",
  "test/unit/prd/prd-regression-failed.test.ts",
  "test/unit/prd/prd-failure-category.test.ts",
  "test/unit/prd/prd-postrun-reset.test.ts",
  "test/unit/prd/prd-reset-failed.test.ts",
  "test/unit/prompts/sections/story.test.ts",
  "test/unit/prompts/builders/rectifier-builder.test.ts",
  "test/unit/prompts/builder.test.ts",
  "test/unit/prompts/builder-acceptance.test.ts",
  "test/unit/routing/routing-stability.test.ts",
  "test/unit/prompts/sections/story.test.ts",
  "test/unit/routing/strategies/keyword.test.ts",
  "test/unit/routing/strategies/llm-adapter.test.ts",
  "test/unit/routing/llm-batch-route.test.ts",
  "test/unit/tdd/session-runner-tokens.test.ts",
  "test/unit/tdd/session-runner-bindhandle.test.ts",
  "test/unit/tdd/session-runner-keep-open.test.ts",
  "test/unit/tdd/rectification-gate-session.test.ts",
  "test/unit/tdd/orchestrator-totals.test.ts",
  "test/integration/context/feature-engine-read-path.test.ts",
  "test/integration/acceptance/red-green-cycle.test.ts",
  "test/integration/execution/feature-status-write.test.ts",
  "test/integration/execution/parallel-batch-selector.test.ts",
  "test/integration/execution/status-writer.test.ts",
  "test/integration/execution/status-writer-postrun.test.ts",
  "test/integration/execution/parallel-batch-rectification.test.ts",
  "test/integration/execution/parallel-batch-results.test.ts",
  "test/integration/execution/status-file.test.ts",
  "test/integration/execution/agent-swap.test.ts",
  "test/integration/prompts/pb-004-migration.test.ts",
// Pattern A (makeConfig) - complex full configs not spreading DEFAULT_CONFIG
  "test/unit/pipeline/stages/completion-semantic.test.ts",
  "test/unit/pipeline/stages/verify-crash-detection.test.ts",
  "test/unit/pipeline/stages/prompt-batch.test.ts",
  "test/unit/pipeline/stages/prompt-tdd-simple.test.ts",
  "test/unit/pipeline/stages/completion-review-gate.test.ts",
  "test/unit/pipeline/verify-smart-runner.test.ts",
  "test/unit/context/engine/providers/plugin-loader.test.ts",
  "test/unit/context/engine/orchestrator-factory.test.ts",
  "test/unit/context/generator.test.ts",
  "test/unit/quality/command-resolver.test.ts",
  "test/unit/config/permissions.test.ts",
  "test/unit/agents/manager-complete.test.ts",
  "test/unit/agents/manager-swap-loop.test.ts",
  "test/unit/cli/plan-decompose-ac13-14.test.ts",
  "test/unit/cli/plan-replan.test.ts",
  "test/unit/cli/plan-decompose-regression.test.ts",
  "test/unit/cli/plan-decompose-guards.test.ts",
  "test/unit/cli/plan-decompose-adapter.test.ts",
  "test/unit/verification/rectification-loop.test.ts",
  "test/unit/verification/rectification-loop-escalation.test.ts",
  "test/unit/acceptance/generator-prd-fallback.test.ts",
  "test/unit/acceptance/generator-prd-result.test.ts",
  "test/unit/acceptance/component-strategy-integration.test.ts",
  "test/unit/execution/lifecycle-execution.test.ts",
  "test/unit/execution/story-context.test.ts",
  "test/unit/execution/runner-completion-skip.test.ts",
  "test/unit/execution/lifecycle/run-regression.test.ts",
  "test/unit/execution/lifecycle/run-completion-postrun.test.ts",
  "test/unit/execution/lifecycle/run-setup.test.ts",
  "test/unit/execution/lifecycle/acceptance-fix.test.ts",
  "test/unit/execution/runner-completion-postrun.test.ts",
  "test/unit/execution/lifecycle-completion.test.ts",
  "test/unit/review/dialogue.test.ts",
  "test/unit/review/dialogue-re-review.test.ts",
  "test/unit/prompts/sections/tdd-conventions.test.ts",
  "test/unit/prompts/loader.test.ts",
  "test/unit/precheck/checks-blockers-agent.test.ts",
  "test/unit/precheck/precheck-run-story-size-gate-routing.test.ts",
  "test/unit/routing/strategies/llm.test.ts",
  "test/unit/routing/strategies/llm-adapter.test.ts",
  "test/unit/routing/llm-batch-route.test.ts",
  "test/unit/tdd/session-runner-tokens.test.ts",
  "test/unit/tdd/session-runner-bindhandle.test.ts",
  "test/unit/tdd/session-runner-keep-open.test.ts",
  "test/unit/tdd/rectification-gate-session.test.ts",
  "test/unit/tdd/orchestrator-totals.test.ts",
  "test/unit/interaction/triggers.test.ts",
  "test/unit/interaction/init-headless.test.ts",
  "test/unit/session/manager-session-retry.test.ts",
  "test/integration/pipeline/reporter-lifecycle-basic.test.ts",
  "test/integration/context/feature-engine-read-path.test.ts",
  "test/integration/execution/feature-status-write.test.ts",
  "test/integration/execution/status-writer.test.ts",
  "test/integration/execution/status-writer-postrun.test.ts",
  "test/integration/execution/agent-swap.test.ts",
  "test/integration/execution/deferred-review-integration.test.ts",
  "test/integration/prompts/pb-004-migration.test.ts",
  // Pattern A (makeConfig) — local factory for ContextPluginProviderConfig (not NaxConfig)
  "test/unit/context/engine/providers/plugin-cache.test.ts",
]);

/**
 * Pattern C (inline-agent-adapter) false-positive guard.
 *
 * When `supportedTiers: [` appears inside a helper call like `makeAgentAdapter(...)`,
 * the regex matches the string inside the helper call — a false positive.
 *
 * This function checks whether the match at `matchIndex` in `text` is inside
 * an open helper call by looking backwards for `makeAgentAdapter(` or
 * `makeMockAgentManager(` within LOOKBACK_LINES lines, then computing the
 * bracket nesting depth from the call to the match.
 *
 * A call is considered "open" at the match if the net nesting depth
 * (opening - closing of brackets/braces/parens) from after the call to
 * the match is positive.
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
    let depth = 0;
    for (const ch of afterCall) {
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth--;
    }
    if (depth > 0) return true;
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
