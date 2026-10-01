/**
 * Deterministic Test Baseline — persistence and classification
 *
 * The baseline is the set of failing tests at a story's base ref. It is
 * immutable within a story: anything that changes after story start — including
 * mechanical lint/format fixes the harness runs on the story's behalf — is
 * attributable to the story.
 *
 * Two artifacts coexist on disk:
 *   - Run-start baseline  — captured once per run under the feature root.
 *   - Story baseline      — captured per story under `<feature>/stories/<id>/`,
 *                           source `roll-forward`. Sequential-mode stories read
 *                           this artifact; parallel-mode stories inherit the
 *                           run-start baseline.
 *
 * This module owns artifact IO and pure classification. It does NOT execute
 * tests or capture outputs (US-002); it does NOT attach dispositions to gate
 * findings (US-003 attaches them at the consuming gate,
 * `src/operations/full-suite-gate.ts`); it does NOT render prompts (US-004).
 * All path IO goes through `featureDir()` so feature-tree open-coding stays
 * gated by `scripts/check-feature-dir-ssot.ts`.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { featureDir } from "@/config";
import type { Finding } from "@/findings/types";
import { loadJsonFile, saveJsonFile } from "@/utils/json-file";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a finding sits relative to the captured baseline. Drives gate
 * attachment and prompt rendering in downstream stories.
 */
export type BaselineDisposition = "introduced" | "pre-existing" | "earlier-story" | "unattributed";

/**
 * One entry in a captured baseline. `testName` is optional — when absent,
 * the entry is a file-level fallback that matches any finding in that file.
 */
export interface BaselineEntry {
  file: string;
  testName?: string;
}

/**
 * The baseline artifact. Two shapes:
 *   - `captured`   — a real snapshot; `entries` may be empty (baseline green).
 *   - `no-baseline`— a sentinel explaining why no capture exists (disabled,
 *                    timeout, parse failure, etc.). Read paths return this
 *                    exactly as written.
 */
export type TestBaseline =
  | {
      kind: "captured";
      baseRef?: string;
      capturedAt: string;
      source: "preflight" | "roll-forward";
      entries: BaselineEntry[];
    }
  | {
      kind: "no-baseline";
      reason: "gate-disabled" | "no-test-command" | "timeout" | "unparseable" | "error" | "no-gate-parse";
      capturedAt: string;
    };

/**
 * Story execution mode. Parallel-mode stories inherit the run-start baseline;
 * sequential-mode stories use their own per-story roll-forward baseline.
 */
export type StoryExecutionMode = "sequential" | "parallel";

// ─────────────────────────────────────────────────────────────────────────────
// Artifact paths
// ─────────────────────────────────────────────────────────────────────────────

const RUN_BASELINE_FILENAME = "test-baseline.json";
const STORY_BASELINE_FILENAME = "test-baseline.json";

function runBaselinePath(root: string, featureId: string): string {
  return join(featureDir(root, featureId), RUN_BASELINE_FILENAME);
}

function storyBaselinePath(root: string, featureId: string, storyId: string): string {
  return join(featureDir(root, featureId), "stories", storyId, STORY_BASELINE_FILENAME);
}

// ─────────────────────────────────────────────────────────────────────────────
// IO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist a run-start baseline. Atomic write (tmp + rename) via `saveJsonFile`.
 */
export async function writeRunBaseline(root: string, featureId: string, baseline: TestBaseline): Promise<void> {
  const path = runBaselinePath(root, featureId);
  await saveJsonFile(path, baseline, "test-baseline");
}

/**
 * Read a run-start baseline. Returns `undefined` when the artifact is absent
 * or unparseable — classification treats `undefined` like a `no-baseline`
 * marker, so callers never need to distinguish.
 */
export async function readRunBaseline(root: string, featureId: string): Promise<TestBaseline | undefined> {
  return (await loadJsonFile<TestBaseline>(runBaselinePath(root, featureId), "test-baseline")) ?? undefined;
}

/**
 * Persist a per-story baseline.
 */
export async function writeStoryBaseline(
  root: string,
  featureId: string,
  storyId: string,
  baseline: TestBaseline,
): Promise<void> {
  const path = storyBaselinePath(root, featureId, storyId);
  // Ensure the story directory exists — atomic write would otherwise fail.
  await mkdir(join(featureDir(root, featureId), "stories", storyId), { recursive: true });
  await saveJsonFile(path, baseline, "test-baseline");
}

/**
 * Read a per-story baseline. Returns `undefined` when absent or unparseable.
 */
export async function readStoryBaseline(
  root: string,
  featureId: string,
  storyId: string,
): Promise<TestBaseline | undefined> {
  return (await loadJsonFile<TestBaseline>(storyBaselinePath(root, featureId, storyId), "test-baseline")) ?? undefined;
}

/** Remove retained per-story snapshots before a new run establishes its baseline. */
export async function clearStoryBaselines(root: string, featureId: string): Promise<void> {
  const storiesDir = join(featureDir(root, featureId), "stories");
  const entries = await readdir(storiesDir, { withFileTypes: true }).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => rm(join(storiesDir, entry.name, STORY_BASELINE_FILENAME), { force: true })),
  );
}

/**
 * The one read path consumers use. Returns the story artifact for sequential
 * stories that have one, and the run-start baseline otherwise — the run-start
 * capture is the parallel-mode story baseline, and it is also the baseline of a
 * story whose per-story artifact was never written (roll-forward only starts at
 * story 2), so the same rule serves both modes and callers with no execution-mode
 * signal of their own. Escalation and fallback swaps rebuild their prompts from
 * this resolved artifact, so they inherit whichever snapshot their session's
 * mode dictates.
 *
 * An artifact that exists but does not parse is NOT treated as absent: a capture
 * fault must classify as `unattributed` (see `applyBaselineDispositions`) rather
 * than be replaced by the older run-start snapshot, whose intervening stories
 * would then be re-attributed to this one.
 */
export async function resolveStoryBaseline(
  root: string,
  featureId: string,
  storyId: string,
  executionMode: StoryExecutionMode,
): Promise<TestBaseline | undefined> {
  if (executionMode === "parallel") {
    return readRunBaseline(root, featureId);
  }
  const story = await readStoryBaseline(root, featureId, storyId);
  if (story !== undefined) return story;
  if (existsSync(storyBaselinePath(root, featureId, storyId))) return undefined;
  return readRunBaseline(root, featureId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pure, non-mutating classification. Returns a new array of new `Finding`
 * objects with `baselineDisposition` set on every element; the input array
 * and elements are left untouched.
 *
 * Rules:
 *   - Story baseline is `no-baseline` or `undefined` → every finding is
 *     `unattributed`.
 *   - Captured story baseline (even with zero entries): a finding matched by
 *     an entry is `pre-existing`; otherwise `introduced`.
 *   - When a run baseline is also passed: a finding matched by the captured
 *     story baseline's `roll-forward` entry but missing from the captured run
 *     baseline is `earlier-story`; a match in both stays `pre-existing`.
 *
 * Matching: an entry with a `testName` matches a finding on `(file, testName)`
 * where `testName` reads from the finding's `rule` (the closest analogue the
 * `Finding` wire format carries — test runners populate `rule` with the test
 * name, see `src/findings/adapters/test-failure.ts`); an entry without a
 * `testName` matches any finding in the same `file`.
 */
export function applyBaselineDispositions(
  findings: readonly Finding[],
  storyBaseline: TestBaseline | undefined,
  runBaseline: TestBaseline | undefined,
): Finding[] {
  // `no-baseline` and `undefined` both yield `unattributed`.
  if (storyBaseline === undefined || storyBaseline.kind === "no-baseline") {
    return findings.map((f) => withDisposition(f, "unattributed"));
  }

  // Captured story baseline — `roll-forward` stories get `earlier-story` when
  // the run baseline does not match the same entry.
  const isRollForward = storyBaseline.source === "roll-forward";
  const storyEntries = storyBaseline.entries;

  return findings.map((finding) => {
    const matched = matchEntry(finding, storyEntries);
    if (matched === undefined) {
      return withDisposition(finding, "introduced");
    }

    // Matched on story baseline. For roll-forward baselines, the run baseline
    // refines the disposition: missing-from-run → earlier-story, present-in-run
    // → pre-existing. When the run baseline is absent or unparseable, treat as
    // "no run-level distinction" and stay pre-existing (AC8 / AC10).
    if (isRollForward && runBaseline !== undefined && runBaseline.kind === "captured") {
      const alsoInRun = matchEntry(finding, runBaseline.entries) !== undefined;
      if (!alsoInRun) {
        return withDisposition(finding, "earlier-story");
      }
    }

    return withDisposition(finding, "pre-existing");
  });
}

/**
 * Does the finding match any entry in the list? An entry with `testName`
 * matches on `(file, testName)`; an entry without `testName` matches on
 * `file` alone. Returns the matching entry or `undefined`.
 */
function matchEntry(finding: Finding, entries: readonly BaselineEntry[]): BaselineEntry | undefined {
  for (const entry of entries) {
    if (entry.file !== finding.file) continue;
    if (entry.testName === undefined) return entry;
    if (entry.testName === finding.rule) return entry;
  }
  return undefined;
}

/**
 * Return a new finding object with `baselineDisposition` set. Every other
 * field is preserved by spread — this is the non-mutation contract (AC17).
 */
function withDisposition(finding: Finding, disposition: BaselineDisposition): Finding {
  return { ...finding, baselineDisposition: disposition };
}
